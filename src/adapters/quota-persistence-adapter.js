import { SHEET_NAMES, PROCESSED_MESSAGE_STATE } from '../core/domain-constants.js';
import {
  canStart,
  estimateOperation,
  isRetryEligible,
  quotaLimitsFromConfiguration,
  recordUsage,
  reserveQuota
} from '../core/quota-guard.js';

export const QUOTA_USAGE_CONFIGURATION_KEY = 'quota_usage_windows';

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid timestamp is required.');
  return date.toISOString();
}

function defaultId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  return `quota-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function asConfiguration(records) {
  return Object.fromEntries(records.map(({ config_key, config_value }) => [config_key, config_value]));
}

function parseUsage(value) {
  if (value === null || value === undefined || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new TypeError('Quota usage windows must be an array.');
    return parsed;
  } catch (error) {
    throw new Error(`Stored quota usage is invalid: ${error.message}`);
  }
}

function serializeEstimate(estimate) {
  return Array.isArray(estimate) ? estimate.reduce((total, item) => total + Number(item.units ?? 0), 0) : null;
}

/**
 * Persists quota windows in Configuration and operational deferrals in Sheets.
 * The run coordinator must call reserveBeforeOperation before its provider call.
 */
export class QuotaPersistenceAdapter {
  constructor(repository, options = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    this.repository = repository;
    this.createId = options.createId ?? defaultId;
  }

  readConfiguration() {
    return asConfiguration(this.repository.readTable(SHEET_NAMES.CONFIGURATION).records);
  }

  readUsage() {
    const configuration = this.readConfiguration();
    return parseUsage(configuration[QUOTA_USAGE_CONFIGURATION_KEY]);
  }

  saveUsage(usage, now = new Date()) {
    this.repository.upsert(SHEET_NAMES.CONFIGURATION, [{
      config_key: QUOTA_USAGE_CONFIGURATION_KEY,
      config_value: JSON.stringify(usage),
      updated_at: iso(now)
    }]);
    return usage;
  }

  /** Records exactly one quota deferral and preserves the affected message as nonterminal. */
  defer({ runId, gmailMessageId = null, operation, quotaName, estimate, observedUnits = null, eligibleAfter, reason, now = new Date() }) {
    if (!operation || !quotaName || !eligibleAfter || !reason) throw new TypeError('A complete quota deferral is required.');
    const deferredAt = iso(now);
    const deferral = {
      deferral_id: this.createId(), run_id: runId ?? null, gmail_message_id: gmailMessageId,
      operation, quota_name: quotaName, estimated_units: serializeEstimate(estimate), observed_units: observedUnits,
      deferred_at: deferredAt, eligible_after: iso(eligibleAfter), reason, resolved_at: null
    };
    this.repository.upsert(SHEET_NAMES.QUOTA_DEFERRALS, [deferral]);
    if (gmailMessageId) {
      this.repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [{
        gmail_message_id: gmailMessageId,
        state: PROCESSED_MESSAGE_STATE.DEFERRED,
        next_attempt_at: deferral.eligible_after
      }]);
    }
    return deferral;
  }

  /**
   * Reserves quota before a Gmail, Sheets, runtime, or Gemini operation. A
   * rejected decision is persisted as one deferral before the caller can invoke a provider.
   */
  reserveBeforeOperation({ runId, gmailMessageId = null, operation, estimate, estimateOptions, now = new Date() }) {
    const configuration = this.readConfiguration();
    const limits = quotaLimitsFromConfiguration(configuration);
    const usage = this.readUsage();
    const plannedEstimate = estimate ?? estimateOperation(operation, estimateOptions);
    const result = reserveQuota(limits, usage, plannedEstimate, now);
    if (result.allowed) {
      this.saveUsage(result.usage, now);
      return { ...result, limits, estimate: plannedEstimate, deferral: null };
    }

    const primaryBlock = result.blocked[0];
    const deferral = this.defer({
      runId, gmailMessageId, operation, quotaName: primaryBlock.quota_name,
      estimate: plannedEstimate, eligibleAfter: result.eligible_after,
      reason: 'ESTIMATED_QUOTA_EXCEEDED', now
    });
    return { ...result, limits, estimate: plannedEstimate, deferral };
  }

  /** Commits observed provider consumption and frees the prior reservation. */
  recordOperationUsage({ reservation, observedUsage, now = new Date() }) {
    const updatedUsage = recordUsage(this.readUsage(), reservation, observedUsage, now);
    this.saveUsage(updatedUsage, now);
    return updatedUsage;
  }

  /** Handles a provider quota-exceeded result without allowing a second provider call. */
  deferQuotaExceeded({ runId, gmailMessageId = null, operation, quotaName, estimate, reservation, observedUsage, now = new Date() }) {
    const configuration = this.readConfiguration();
    const limits = quotaLimitsFromConfiguration(configuration);
    const decision = canStart(limits, this.readUsage(), estimate, now);
    if (reservation) this.recordOperationUsage({ reservation, observedUsage, now });
    const matchingCheck = decision.checks.find((check) => check.quota_name === quotaName);
    const eligibleAfter = matchingCheck?.eligible_after ?? new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return this.defer({
      runId, gmailMessageId, operation, quotaName, estimate,
      observedUnits: serializeEstimate(observedUsage ?? estimate), eligibleAfter,
      reason: 'PROVIDER_QUOTA_EXCEEDED', now
    });
  }

  /** Supplies only deferred messages whose configured retry time has arrived. */
  eligibleRetries(now = new Date()) {
    return this.repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records
      .filter((record) => record.state === PROCESSED_MESSAGE_STATE.DEFERRED && isRetryEligible(record, now));
  }

  /** Marks a deferral resolved only after the retried operation has completed successfully. */
  resolveDeferral(deferralId, now = new Date()) {
    this.repository.upsert(SHEET_NAMES.QUOTA_DEFERRALS, [{ deferral_id: deferralId, resolved_at: iso(now) }]);
  }
}
