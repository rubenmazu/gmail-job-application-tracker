import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, QUOTA_OPERATION } from '../src/core/domain-constants.js';
import { ScheduledProcessingCoordinator } from '../src/services/scheduled-processing-coordinator.js';

const NOW = new Date('2025-02-03T10:00:00.000Z');

function createLock({ acquired = true } = {}) {
  return {
    attempts: 0,
    released: 0,
    tryLock() { this.attempts += 1; return acquired; },
    releaseLock() { this.released += 1; }
  };
}

function createCoordinator(overrides = {}) {
  const lock = overrides.lock ?? createLock();
  const repository = overrides.repository ?? {
    failures: [], relationships: [],
    appendProcessingFailure(record) { this.failures.push(record); return record; },
    appendRelationshipException(record) { this.relationships.push(record); return record; }
  };
  const scheduler = overrides.scheduler ?? {
    plan: () => ({ candidates: [], discoveredMessages: [] }),
    advanceCheckpoint: () => ({ advanced: false })
  };
  const ledger = overrides.ledger ?? {
    claim: () => ({ claimed: false }), complete() {}, markRetryableFailure() {}, defer() {}
  };
  const quotaPersistence = overrides.quotaPersistence ?? {
    reserves: [], usage: [], deferrals: [],
    reserveBeforeOperation(request) {
      this.reserves.push(request);
      return { allowed: true, reservation: { operation: request.operation }, estimate: [] };
    },
    recordOperationUsage(request) { this.usage.push(request); },
    defer(record) { this.deferrals.push(record); return record; }
  };
  const coordinator = new ScheduledProcessingCoordinator({
    repository,
    scheduler,
    ledger,
    quotaPersistence,
    gemini: overrides.gemini ?? { classifyClaimedMessage() { throw new Error('Gemini must not be called for reused classification.'); } },
    domain: overrides.domain ?? { apply() { throw new Error('Domain must not be called for irrelevant classification.'); } },
    reporting: overrides.reporting ?? { rebuildAndUpsert() {} },
    lockService: { getScriptLock: () => lock },
    now: () => NOW,
    createId: () => 'run-1',
    runtimeSafetyMarginMs: 1,
    logError: overrides.logError ?? (() => {})
  });
  return { coordinator, lock, repository, scheduler, ledger, quotaPersistence };
}

describe('ScheduledProcessingCoordinator', () => {
  it('holds one global lock and runs reader, claim, reuse, reporting, then checkpoint', () => {
    const order = [];
    const candidate = { gmail_message_id: 'message-1', gmail_thread_id: 'thread-1', received_at: NOW.toISOString() };
    const { coordinator, lock, quotaPersistence } = createCoordinator({
      scheduler: {
        plan() { order.push('reader'); return { candidates: [candidate], discoveredMessages: [candidate] }; },
        advanceCheckpoint(_plan, runId) { order.push(`checkpoint:${runId}`); }
      },
      ledger: {
        claim(message, runId) {
          order.push(`claim:${message.gmail_message_id}:${runId}`);
          return { claimed: true, shouldClassify: false, classification: { classification: CLASSIFICATION.IRRELEVANT }, record: { attempt_count: 1 } };
        },
        complete(messageId, runId, outcome) { order.push(`complete:${messageId}:${runId}:${outcome}`); },
        markRetryableFailure() {}, defer() {}
      },
      reporting: { rebuildAndUpsert() { order.push('reporting'); } }
    });

    const result = coordinator.runScheduledProcessing();

    expect(result).toMatchObject({ runId: 'run-1', status: 'COMPLETED', planned: 1, completed: 1 });
    expect(order).toEqual(['reader', 'claim:message-1:run-1', 'complete:message-1:run-1:IRRELEVANT', 'reporting', 'checkpoint:run-1']);
    expect(lock).toMatchObject({ attempts: 1, released: 1 });
    expect(quotaPersistence.reserves.map(({ operation }) => operation)).toEqual([
      QUOTA_OPERATION.RUN, QUOTA_OPERATION.GMAIL_READ, QUOTA_OPERATION.SHEETS_WRITE,
      QUOTA_OPERATION.SHEETS_WRITE, QUOTA_OPERATION.SHEETS_WRITE
    ]);
  });

  it('records a run failure independently and releases the global lock when the reader fails', () => {
    const { coordinator, lock, repository } = createCoordinator({
      scheduler: {
        plan() { throw Object.assign(new Error('Gmail unavailable'), { code: 'GMAIL_READ_FAILED', retryable: true }); },
        advanceCheckpoint() {}
      }
    });

    const result = coordinator.runScheduledProcessing();

    expect(result).toMatchObject({ status: 'FAILED', runId: 'run-1', errorCode: 'GMAIL_READ_FAILED', failed: 1 });
    expect(repository.failures).toHaveLength(1);
    expect(repository.failures[0]).toMatchObject({ run_id: 'run-1', stage: 'run', reason_code: 'GMAIL_READ_FAILED', retryable: true });
    expect(lock.released).toBe(1);
  });

  it('does not invoke the reader when the runtime quota guard defers the run', () => {
    let readerCalls = 0;
    const { coordinator, lock, quotaPersistence } = createCoordinator({
      scheduler: { plan() { readerCalls += 1; return { candidates: [], discoveredMessages: [] }; }, advanceCheckpoint() {} },
      quotaPersistence: {
        reserveBeforeOperation(request) {
          return request.operation === QUOTA_OPERATION.RUN
            ? { allowed: false, reservation: null, deferral: { deferral_id: 'quota-1' } }
            : { allowed: true, reservation: { operation: request.operation }, estimate: [] };
        },
        recordOperationUsage() {}, defer() {}
      }
    });

    expect(coordinator.runScheduledProcessing()).toMatchObject({ status: 'DEFERRED_RUNTIME_QUOTA', deferred: 1 });
    expect(readerCalls).toBe(0);
    expect(lock.released).toBe(1);
    expect(quotaPersistence).toBeDefined();
  });
});


describe('Property 1: Failures remain independently auditable', () => {
  // Feature: gmail-job-application-tracker, Property 1: Failures remain independently auditable
  // Validates: Requirements 1.4, 2.4, 3.4
  it('records exactly one independently persisted failure for every injected processing-stage exception', () => {
    const stageArbitrary = fc.constantFrom('reader', 'claim', 'gemini', 'domain', 'reporting', 'checkpoint');
    const errorCodeArbitrary = fc.constantFrom('GMAIL_READ_FAILED', 'CLAIM_FAILED', 'GEMINI_INVALID_RESPONSE', 'DOMAIN_WRITE_FAILED', 'SHEETS_WRITE_FAILED', 'CHECKPOINT_FAILED');
    const timestampArbitrary = fc.date({
      min: new Date('2020-01-01T00:00:00.000Z'),
      max: new Date('2030-12-31T23:59:59.999Z')
    });

    fc.assert(fc.property(
      stageArbitrary,
      errorCodeArbitrary,
      fc.uuid(),
      timestampArbitrary,
      fc.boolean(),
      (stage, code, runId, occurredAt, canRetry) => {
        const injectedError = Object.assign(new Error(`${code} injected failure`), { code, retryable: canRetry });
        const failures = [];
        const candidate = {
          gmail_message_id: 'candidate-message',
          gmail_thread_id: 'candidate-thread',
          received_at: occurredAt.toISOString()
        };
        const repository = {
          // Any normal state mutation is deliberately unavailable; the failure append remains independent.
          upsert() { throw new Error('Normal state write is unavailable.'); },
          appendProcessingFailure(record) { failures.push(record); return record; },
          appendRelationshipException() { throw new Error('Relationship writes are not used by this property.'); }
        };
        const scheduler = {
          plan() {
            if (stage === 'reader') throw injectedError;
            return { candidates: [candidate], discoveredMessages: [candidate] };
          },
          advanceCheckpoint() {
            if (stage === 'checkpoint') throw injectedError;
            return { advanced: true };
          }
        };
        const ledger = {
          claim() {
            if (stage === 'claim') throw injectedError;
            return {
              claimed: true,
              shouldClassify: stage === 'gemini' || stage === 'domain',
              classification: { classification: CLASSIFICATION.IRRELEVANT },
              record: { attempt_count: 1 }
            };
          },
          complete() {},
          markRetryableFailure() {},
          defer() {}
        };
        const gemini = {
          classifyClaimedMessage() {
            if (stage === 'gemini') throw injectedError;
            return {
              status: 'CLASSIFIED',
              classification: { classification: stage === 'domain' ? CLASSIFICATION.REJECTION : CLASSIFICATION.IRRELEVANT }
            };
          }
        };
        const domain = {
          apply() {
            if (stage === 'domain') throw injectedError;
            return { outcome: 'IRRELEVANT' };
          }
        };
        const reporting = {
          rebuildAndUpsert() {
            if (stage === 'reporting') throw injectedError;
          }
        };
        const quotaPersistence = {
          reserveBeforeOperation(request) { return { allowed: true, reservation: { operation: request.operation } }; },
          recordOperationUsage() {},
          defer() {}
        };
        const coordinator = new ScheduledProcessingCoordinator({
          repository,
          scheduler,
          ledger,
          quotaPersistence,
          gemini,
          domain,
          reporting,
          lockService: { getScriptLock: () => createLock() },
          now: () => occurredAt,
          createId: () => runId,
          runtimeSafetyMarginMs: 1,
          logError: () => {}
        });

        coordinator.runScheduledProcessing();

        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          run_id: runId,
          reason_code: code,
          retryable: canRetry
        });
        expect(failures[0].occurred_at.toISOString()).toBe(occurredAt.toISOString());
        expect(String(failures[0].reason_code)).not.toHaveLength(0);
      }
    ), { numRuns: 100 });
  });
});