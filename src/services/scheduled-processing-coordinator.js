import {
  CLASSIFICATION,
  CONFIGURATION_KEY,
  PROCESSED_MESSAGE_STATE,
  QUOTA_OPERATION
} from '../core/domain-constants.js';
import { QUOTA_NAME } from '../core/quota-guard.js';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_BUDGET_MS = 5 * 60 * 1_000;
const DEFAULT_RUNTIME_SAFETY_MARGIN_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_SHEET_WRITES_PER_MESSAGE = 5;

function asDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`"${field}" must be a valid timestamp.`);
  return date;
}

function asPositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`"${field}" must be a positive integer.`);
  return number;
}

function defaultNow() {
  return new Date();
}

function defaultCreateId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('A run ID generator is required outside Google Apps Script.');
}

function logFailure(error) {
  const message = `Unable to record scheduled-processing failure: ${error?.message ?? String(error)}`;
  if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(message);
  else if (typeof Logger !== 'undefined' && typeof Logger.log === 'function') Logger.log(message);
}

function errorCode(error) {
  return String(error?.code ?? error?.name ?? 'PROCESSING_ERROR');
}

function retryable(error) {
  return error?.retryable !== false;
}

/**
 * Coordinates one complete, lock-protected scheduled processing run. Provider
 * calls are guarded before invocation; per-message failures are isolated so a
 * later candidate can still complete, while a run-level catch records failures
 * through the independent Processing_Failures append boundary.
 */
export class ScheduledProcessingCoordinator {
  constructor({
    repository,
    scheduler,
    ledger,
    quotaPersistence,
    gemini,
    domain,
    reporting,
    lockService = globalThis.LockService,
    now = defaultNow,
    createId = defaultCreateId,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    runtimeBudgetMs = DEFAULT_RUNTIME_BUDGET_MS,
    runtimeSafetyMarginMs = DEFAULT_RUNTIME_SAFETY_MARGIN_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sheetWritesPerMessage = DEFAULT_SHEET_WRITES_PER_MESSAGE,
    logError = logFailure
  } = {}) {
    if (!repository || typeof repository.appendProcessingFailure !== 'function' || typeof repository.appendRelationshipException !== 'function') {
      throw new TypeError('A repository with independent failure and relationship append operations is required.');
    }
    if (!scheduler || typeof scheduler.plan !== 'function' || typeof scheduler.advanceCheckpoint !== 'function') {
      throw new TypeError('An IncrementalProcessingScheduler-compatible scheduler is required.');
    }
    if (!ledger || typeof ledger.claim !== 'function' || typeof ledger.complete !== 'function' ||
      typeof ledger.markRetryableFailure !== 'function' || typeof ledger.defer !== 'function') {
      throw new TypeError('A ProcessedMessageLedger-compatible ledger is required.');
    }
    if (!quotaPersistence || typeof quotaPersistence.reserveBeforeOperation !== 'function' ||
      typeof quotaPersistence.recordOperationUsage !== 'function' || typeof quotaPersistence.defer !== 'function') {
      throw new TypeError('A QuotaPersistenceAdapter-compatible quota persistence adapter is required.');
    }
    if (!gemini || typeof gemini.classifyClaimedMessage !== 'function') throw new TypeError('A Gemini client is required.');
    if (!domain || typeof domain.apply !== 'function') throw new TypeError('An application domain state machine is required.');
    if (!reporting || typeof reporting.rebuildAndUpsert !== 'function') throw new TypeError('A reporting dataset service is required.');
    if (!lockService || typeof lockService.getScriptLock !== 'function') throw new TypeError('Apps Script LockService is required.');
    if (typeof now !== 'function' || typeof createId !== 'function' || typeof logError !== 'function') throw new TypeError('now, createId, and logError must be functions.');

    this.repository = repository;
    this.scheduler = scheduler;
    this.ledger = ledger;
    this.quotaPersistence = quotaPersistence;
    this.gemini = gemini;
    this.domain = domain;
    this.reporting = reporting;
    this.lockService = lockService;
    this.now = now;
    this.createId = createId;
    this.lockTimeoutMs = asPositiveInteger(lockTimeoutMs, 'lockTimeoutMs');
    this.runtimeBudgetMs = asPositiveInteger(runtimeBudgetMs, 'runtimeBudgetMs');
    this.runtimeSafetyMarginMs = asPositiveInteger(runtimeSafetyMarginMs, 'runtimeSafetyMarginMs');
    this.retryDelayMs = asPositiveInteger(retryDelayMs, 'retryDelayMs');
    this.sheetWritesPerMessage = asPositiveInteger(sheetWritesPerMessage, 'sheetWritesPerMessage');
    this.logError = logError;
  }

  runScheduledProcessing() {
    const runId = this.createId();
    const startedAt = asDate(this.now(), 'run start');
    const lock = this.lockService.getScriptLock();
    let acquired = false;
    let runReservation = null;
    const summary = { runId, status: 'COMPLETED', planned: 0, claimed: 0, completed: 0, deferred: 0, skipped: 0, failed: 0 };

    try {
      acquired = Boolean(lock.tryLock(this.lockTimeoutMs));
      if (!acquired) return Object.freeze({ ...summary, status: 'LOCK_UNAVAILABLE' });

      const runtime = this.#reserve(runId, null, QUOTA_OPERATION.RUN, { milliseconds: this.runtimeBudgetMs });
      if (!runtime.allowed) return Object.freeze({ ...summary, status: 'DEFERRED_RUNTIME_QUOTA', deferred: 1 });
      runReservation = runtime.reservation;

      const gmailRead = this.#reserve(runId, null, QUOTA_OPERATION.GMAIL_READ, { readCalls: 1 });
      if (!gmailRead.allowed) return Object.freeze({ ...summary, status: 'DEFERRED_GMAIL_QUOTA', deferred: 1 });
      let plan;
      try {
        plan = this.scheduler.plan();
      } finally {
        this.#recordUsage(gmailRead.reservation, QUOTA_OPERATION.GMAIL_READ, { readCalls: 1 });
      }
      summary.planned = plan.candidates.length;

      for (const candidate of plan.candidates) {
        if (this.#runtimeRemaining(startedAt) <= this.runtimeSafetyMarginMs) {
          this.#deferRuntime(runId);
          summary.status = 'DEFERRED_RUNTIME_BUDGET';
          summary.deferred += 1;
          break;
        }
        const outcome = this.#processCandidate(candidate, runId);
        summary[outcome] += 1;
      }

      if (summary.status === 'COMPLETED') {
        const reportingReservation = this.#reserve(runId, null, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: 1 });
        if (!reportingReservation.allowed) {
          summary.status = 'DEFERRED_SHEETS_QUOTA';
          summary.deferred += 1;
        } else {
          try {
            this.reporting.rebuildAndUpsert();
            const checkpointReservation = this.#reserve(runId, null, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: 1 });
            if (!checkpointReservation.allowed) {
              summary.status = 'DEFERRED_SHEETS_QUOTA';
              summary.deferred += 1;
            } else {
              try { this.scheduler.advanceCheckpoint(plan, runId); }
              finally { this.#recordUsage(checkpointReservation.reservation, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: 1 }); }
            }
          } finally {
            this.#recordUsage(reportingReservation.reservation, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: 1 });
          }
        }
      }
      return Object.freeze({ ...summary });
    } catch (error) {
      summary.status = 'FAILED';
      summary.failed += 1;
      this.#recordFailure(error, { runId, stage: 'run', occurredAt: this.now(), retryable: retryable(error) });
      return Object.freeze({ ...summary, errorCode: errorCode(error) });
    } finally {
      if (runReservation) {
        const elapsedMs = Math.max(0, asDate(this.now(), 'run finish').getTime() - startedAt.getTime());
        this.#recordUsage(runReservation, QUOTA_OPERATION.RUN, { milliseconds: elapsedMs });
      }
      if (acquired) lock.releaseLock();
    }
  }

  #processCandidate(candidate, runId) {
    const messageId = candidate?.gmail_message_id ?? null;
    let claim = null;
    let sheetsReservation = null;
    try {
      claim = this.ledger.claim(candidate, runId);
      if (!claim.claimed) return 'skipped';

      sheetsReservation = this.#reserve(runId, messageId, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: this.sheetWritesPerMessage });
      if (!sheetsReservation.allowed) {
        const eligibleAfter = sheetsReservation.deferral?.eligible_after ??
          new Date(asDate(this.now(), 'sheets deferral time').getTime() + this.retryDelayMs);
        this.ledger.defer(messageId, runId, eligibleAfter);
        return 'deferred';
      }

      const classified = claim.shouldClassify
        ? this.gemini.classifyClaimedMessage({ ...candidate, body: candidate.plain_body ?? candidate.body ?? '' }, runId)
        : { status: 'REUSED', classification: claim.classification, ledgerRecord: claim.record };
      if (classified.status === 'DEFERRED') return 'deferred';

      const message = { ...candidate, ...classified.classification };
      if (message.classification === CLASSIFICATION.IRRELEVANT) {
        this.ledger.complete(message.gmail_message_id, runId, 'IRRELEVANT');
        return 'completed';
      }

      const domainResult = this.domain.apply(message, { runId });
      if (domainResult.outcome === 'UNRESOLVED') {
        this.repository.appendRelationshipException(domainResult.match.relationshipException);
        this.ledger.complete(message.gmail_message_id, runId, 'UNRESOLVED', { state: PROCESSED_MESSAGE_STATE.UNRESOLVED });
        return 'completed';
      }
      this.ledger.complete(message.gmail_message_id, runId, domainResult.outcome, { applicationId: domainResult.application?.application_id ?? null });
      return 'completed';
    } catch (error) {
      this.#recordFailure(error, {
        runId,
        gmailMessageId: messageId,
        stage: claim ? 'message_processing' : 'claim',
        occurredAt: this.now(),
        retryable: retryable(error),
        attemptCount: claim?.record?.attempt_count ?? 0
      });
      if (claim?.claimed) {
        try {
          this.ledger.markRetryableFailure(messageId, runId, new Date(asDate(this.now(), 'retry time').getTime() + this.retryDelayMs));
        } catch (ledgerError) {
          this.logError(ledgerError);
        }
      }
      return 'failed';
    } finally {
      if (sheetsReservation?.reservation) {
        this.#recordUsage(sheetsReservation.reservation, QUOTA_OPERATION.SHEETS_WRITE, { writeCalls: this.sheetWritesPerMessage });
      }
    }
  }

  #reserve(runId, gmailMessageId, operation, estimateOptions) {
    return this.quotaPersistence.reserveBeforeOperation({
      runId,
      gmailMessageId,
      operation,
      estimateOptions,
      now: this.now()
    });
  }

  #recordUsage(reservation, operation, estimateOptions) {
    if (!reservation) return;
    try {
      this.quotaPersistence.recordOperationUsage({
        reservation,
        observedUsage: undefined,
        now: this.now(),
        operation,
        estimateOptions
      });
    } catch (error) {
      this.logError(error);
    }
  }

  #deferRuntime(runId) {
    try {
      const now = this.now();
      this.quotaPersistence.defer({
        runId,
        operation: QUOTA_OPERATION.RUN,
        quotaName: QUOTA_NAME.RUNTIME_MINUTES,
        estimate: [{ quota_name: QUOTA_NAME.RUNTIME_MINUTES, units: 1 }],
        eligibleAfter: new Date(asDate(now, 'runtime deferral time').getTime() + this.retryDelayMs),
        reason: 'RUNTIME_BUDGET_EXHAUSTED',
        now
      });
    } catch (error) {
      this.logError(error);
    }
  }

  #runtimeRemaining(startedAt) {
    return this.runtimeBudgetMs - (asDate(this.now(), 'runtime check').getTime() - startedAt.getTime());
  }

  #recordFailure(error, { runId, gmailMessageId = null, stage, occurredAt, retryable: canRetry, attemptCount = 0 }) {
    try {
      this.repository.appendProcessingFailure({
        run_id: runId,
        gmail_message_id: gmailMessageId,
        stage,
        reason_code: errorCode(error),
        error,
        occurred_at: occurredAt,
        retryable: canRetry,
        attempt_count: attemptCount
      });
    } catch (appendError) {
      this.logError(appendError);
    }
  }
}

export const SCHEDULED_PROCESSING_COORDINATOR_DEFAULTS = Object.freeze({
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_RUNTIME_BUDGET_MS,
  DEFAULT_RUNTIME_SAFETY_MARGIN_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_SHEET_WRITES_PER_MESSAGE
});
