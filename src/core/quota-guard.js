import { QUOTA_OPERATION } from './domain-constants.js';

export const QUOTA_NAME = Object.freeze({
  GMAIL_READS: 'execution_quota_gmail_reads',
  SHEETS_WRITES: 'execution_quota_sheet_writes',
  RUNTIME_MINUTES: 'execution_quota_runtime_minutes',
  GEMINI_RPM: 'gemini_free_tier_rpm',
  GEMINI_TPM: 'gemini_free_tier_tpm',
  GEMINI_RPD: 'gemini_free_tier_rpd'
});

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_CHARS_PER_TOKEN = 4;

const DEFINITION_TEMPLATE = Object.freeze([
  [QUOTA_NAME.GMAIL_READS, DAY_MS],
  [QUOTA_NAME.SHEETS_WRITES, DAY_MS],
  [QUOTA_NAME.RUNTIME_MINUTES, DAY_MS],
  [QUOTA_NAME.GEMINI_RPM, MINUTE_MS],
  [QUOTA_NAME.GEMINI_TPM, MINUTE_MS],
  [QUOTA_NAME.GEMINI_RPD, DAY_MS]
]);

function assertFiniteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be a finite non-negative number.`);
  return number;
}

function toMilliseconds(value, name = 'now') {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(milliseconds)) throw new TypeError(`${name} must be a valid timestamp.`);
  return milliseconds;
}

function asIso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function configurationValue(configuration, key) {
  if (configuration instanceof Map) return configuration.get(key);
  if (Array.isArray(configuration)) {
    return configuration.find((record) => record?.config_key === key)?.config_value;
  }
  return configuration?.[key];
}

function normalizedUsage(usage) {
  if (!Array.isArray(usage)) throw new TypeError('Quota usage must be an array.');
  return usage.map((record) => ({
    quota_name: String(record.quota_name),
    window_started_at: asIso(toMilliseconds(record.window_started_at, 'window_started_at')),
    consumed_units: assertFiniteNonNegative(record.consumed_units ?? 0, 'consumed_units'),
    reserved_units: assertFiniteNonNegative(record.reserved_units ?? 0, 'reserved_units'),
    updated_at: record.updated_at ? asIso(toMilliseconds(record.updated_at, 'updated_at')) : null
  }));
}

function normalizedDemand(demand) {
  if (!demand || typeof demand !== 'object') throw new TypeError('Quota demand must be an object.');
  return {
    quota_name: String(demand.quota_name),
    units: assertFiniteNonNegative(demand.units, `units for ${demand.quota_name}`)
  };
}

function demandMap(demands) {
  if (!Array.isArray(demands)) throw new TypeError('Quota estimate must be an array of demands.');
  return [...demands.map(normalizedDemand).reduce((totals, demand) => {
    totals.set(demand.quota_name, (totals.get(demand.quota_name) ?? 0) + demand.units);
    return totals;
  }, new Map())].map(([quota_name, units]) => ({ quota_name, units }));
}

/** Estimates provider quota units without accessing Apps Script services. */
export function estimateGmailRead({ readCalls = 1 } = {}) {
  return [{ quota_name: QUOTA_NAME.GMAIL_READS, units: assertFiniteNonNegative(readCalls, 'readCalls') }];
}

export function estimateSheetsWrite({ writeCalls = 1 } = {}) {
  return [{ quota_name: QUOTA_NAME.SHEETS_WRITES, units: assertFiniteNonNegative(writeCalls, 'writeCalls') }];
}

export function estimateRuntime({ milliseconds, minutes } = {}) {
  const resolvedMinutes = minutes === undefined
    ? Math.ceil(assertFiniteNonNegative(milliseconds ?? 0, 'milliseconds') / MINUTE_MS)
    : assertFiniteNonNegative(minutes, 'minutes');
  return [{ quota_name: QUOTA_NAME.RUNTIME_MINUTES, units: resolvedMinutes }];
}

export function estimateGeminiRequest({ inputCharacters = 0, expectedOutputTokens = 0, charactersPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  const divisor = assertFiniteNonNegative(charactersPerToken, 'charactersPerToken');
  if (divisor === 0) throw new TypeError('charactersPerToken must be greater than zero.');
  const inputTokens = Math.ceil(assertFiniteNonNegative(inputCharacters, 'inputCharacters') / divisor);
  const outputTokens = assertFiniteNonNegative(expectedOutputTokens, 'expectedOutputTokens');
  return [
    { quota_name: QUOTA_NAME.GEMINI_RPM, units: 1 },
    { quota_name: QUOTA_NAME.GEMINI_TPM, units: inputTokens + outputTokens },
    { quota_name: QUOTA_NAME.GEMINI_RPD, units: 1 }
  ];
}

export function estimateOperation(operation, options = {}) {
  switch (operation) {
    case QUOTA_OPERATION.GMAIL_READ: return estimateGmailRead(options);
    case QUOTA_OPERATION.SHEETS_WRITE: return estimateSheetsWrite(options);
    case QUOTA_OPERATION.RUN: return estimateRuntime(options);
    case QUOTA_OPERATION.GEMINI_REQUEST: return estimateGeminiRequest(options);
    default: throw new TypeError(`Unsupported quota operation "${operation}".`);
  }
}

/** Converts persisted configuration values into the quota windows used by the guard. */
export function quotaLimitsFromConfiguration(configuration, options = {}) {
  const dailyReset = options.dailyResetReference
    ?? configurationValue(configuration, 'gemini_free_tier_daily_reset_reference')
    ?? configurationValue(configuration, 'execution_quota_daily_reset_reference');
  const anchor = dailyReset ? toMilliseconds(dailyReset, 'daily reset reference') : 0;

  return DEFINITION_TEMPLATE.flatMap(([quota_name, defaultWindowMs]) => {
    const rawLimit = configurationValue(configuration, quota_name);
    if (rawLimit === null || rawLimit === undefined || rawLimit === '') return [];
    const limit = assertFiniteNonNegative(rawLimit, quota_name);
    const configuredWindowMinutes = configurationValue(configuration, `${quota_name}_window_minutes`);
    const window_ms = configuredWindowMinutes === null || configuredWindowMinutes === undefined || configuredWindowMinutes === ''
      ? defaultWindowMs
      : assertFiniteNonNegative(configuredWindowMinutes, `${quota_name}_window_minutes`) * MINUTE_MS;
    if (window_ms <= 0) throw new TypeError(`Window for ${quota_name} must be greater than zero.`);
    return [{ quota_name, limit, window_ms, anchor_ms: window_ms === DAY_MS ? anchor : 0 }];
  });
}

function windowStart(definition, nowMs) {
  return definition.anchor_ms + Math.floor((nowMs - definition.anchor_ms) / definition.window_ms) * definition.window_ms;
}

function currentUsage(usage, quotaName, windowStartedAt) {
  return usage.find((record) => record.quota_name === quotaName && record.window_started_at === asIso(windowStartedAt))
    ?? { quota_name: quotaName, window_started_at: asIso(windowStartedAt), consumed_units: 0, reserved_units: 0, updated_at: null };
}

function definitionIndex(limits) {
  if (!Array.isArray(limits)) throw new TypeError('Quota limits must be an array.');
  const index = new Map();
  for (const limit of limits) {
    if (!limit?.quota_name) throw new TypeError('Each quota limit requires quota_name.');
    const normalized = {
      quota_name: String(limit.quota_name),
      limit: assertFiniteNonNegative(limit.limit, `limit for ${limit.quota_name}`),
      window_ms: assertFiniteNonNegative(limit.window_ms, `window_ms for ${limit.quota_name}`),
      anchor_ms: limit.anchor_ms === undefined ? 0 : toMilliseconds(limit.anchor_ms, `anchor_ms for ${limit.quota_name}`)
    };
    if (normalized.window_ms <= 0) throw new TypeError(`Window for ${normalized.quota_name} must be greater than zero.`);
    index.set(normalized.quota_name, normalized);
  }
  return index;
}

/**
 * Produces a side-effect-free authorization decision. A missing configured
 * limit is intentionally unguarded; only verified, stored limits can block a call.
 */
export function canStart(limits, usage, estimate, now = new Date()) {
  const nowMs = toMilliseconds(now);
  const definitions = definitionIndex(limits);
  const usageRecords = normalizedUsage(usage);
  const checks = demandMap(estimate).flatMap((demand) => {
    const definition = definitions.get(demand.quota_name);
    if (!definition) return [];
    const startedAt = windowStart(definition, nowMs);
    const observed = currentUsage(usageRecords, demand.quota_name, startedAt);
    const available = definition.limit - observed.consumed_units - observed.reserved_units;
    return [{
      ...demand,
      limit: definition.limit,
      available_units: available,
      window_started_at: asIso(startedAt),
      eligible_after: asIso(startedAt + definition.window_ms),
      allowed: demand.units <= available
    }];
  });
  const blocked = checks.filter((check) => !check.allowed);
  return {
    allowed: blocked.length === 0,
    checks,
    blocked,
    eligible_after: blocked.length ? (() => {
      const eligibleWindows = blocked.map((check) => check.eligible_after).sort();
      return eligibleWindows[eligibleWindows.length - 1];
    })() : null
  };
}

/** Reserves all estimated units atomically in a returned, immutable usage snapshot. */
export function reserveQuota(limits, usage, estimate, now = new Date()) {
  const decision = canStart(limits, usage, estimate, now);
  if (!decision.allowed) return { ...decision, usage: normalizedUsage(usage), reservation: null };

  const nowIso = asIso(toMilliseconds(now));
  const reservedByWindow = new Map(decision.checks.map((check) => [`${check.quota_name}|${check.window_started_at}`, check]));
  const retained = normalizedUsage(usage).filter((record) => !reservedByWindow.has(`${record.quota_name}|${record.window_started_at}`));
  const updated = decision.checks.map((check) => {
    const prior = currentUsage(usage, check.quota_name, toMilliseconds(check.window_started_at));
    return { ...prior, reserved_units: prior.reserved_units + check.units, updated_at: nowIso };
  });
  return {
    ...decision,
    usage: [...retained, ...updated],
    reservation: { reserved_at: nowIso, demands: decision.checks.map(({ quota_name, units, window_started_at }) => ({ quota_name, units, window_started_at })) }
  };
}

/** Commits observed units and releases the matching reservation after an attempted operation. */
export function recordUsage(usage, reservation, observedUsage, now = new Date()) {
  if (!reservation || !Array.isArray(reservation.demands)) throw new TypeError('A quota reservation is required to record usage.');
  const nowIso = asIso(toMilliseconds(now));
  const observed = demandMap(observedUsage ?? reservation.demands);
  const observedByQuota = new Map(observed.map((demand) => [demand.quota_name, demand.units]));
  const demandsByWindow = new Map(reservation.demands.map((demand) => [`${demand.quota_name}|${demand.window_started_at}`, normalizedDemand(demand)]));
  const existing = normalizedUsage(usage);
  const updatedKeys = new Set(demandsByWindow.keys());
  const retained = existing.filter((record) => !updatedKeys.has(`${record.quota_name}|${record.window_started_at}`));
  const updated = [...demandsByWindow.entries()].map(([key, demand]) => {
    const [quota_name, window_started_at] = key.split('|');
    const prior = existing.find((record) => record.quota_name === quota_name && record.window_started_at === window_started_at)
      ?? { quota_name, window_started_at, consumed_units: 0, reserved_units: 0 };
    const actual = observedByQuota.get(quota_name) ?? demand.units;
    return {
      ...prior,
      reserved_units: Math.max(0, prior.reserved_units - demand.units),
      consumed_units: prior.consumed_units + actual,
      updated_at: nowIso
    };
  });
  return [...retained, ...updated];
}

export function isRetryEligible(record, now = new Date()) {
  if (!record?.next_attempt_at) return false;
  return toMilliseconds(record.next_attempt_at, 'next_attempt_at') <= toMilliseconds(now);
}

export const QUOTA_GUARD_CONSTANTS = Object.freeze({ MINUTE_MS, DAY_MS, DEFAULT_CHARS_PER_TOKEN });
