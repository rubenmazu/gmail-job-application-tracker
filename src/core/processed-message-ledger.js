import { CLASSIFICATION, PROCESSED_MESSAGE_STATE, SHEET_NAMES } from './domain-constants.js';

export const TERMINAL_PROCESSED_MESSAGE_STATES = Object.freeze(new Set([
  PROCESSED_MESSAGE_STATE.COMPLETED,
  PROCESSED_MESSAGE_STATE.UNRESOLVED
]));
export const NON_TERMINAL_PROCESSED_MESSAGE_STATES = Object.freeze(new Set([
  PROCESSED_MESSAGE_STATE.IN_PROGRESS,
  PROCESSED_MESSAGE_STATE.CLASSIFIED,
  PROCESSED_MESSAGE_STATE.RETRYABLE_FAILURE,
  PROCESSED_MESSAGE_STATE.DEFERRED
]));

const VALID_CLASSIFICATIONS = new Set(Object.values(CLASSIFICATION));
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid timestamp is required.');
  return date.toISOString();
}

function asNonEmptyText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`"${field}" must be a non-empty string.`);
  return value;
}

function asAttemptCount(value) {
  const count = Number(value ?? 0);
  if (!Number.isInteger(count) || count < 0) throw new TypeError('Ledger attempt_count must be a non-negative integer.');
  return count;
}

function parsePersistedClassification(classificationJson) {
  if (typeof classificationJson !== 'string' || classificationJson.trim() === '') return null;
  try {
    const result = JSON.parse(classificationJson);
    return result && typeof result === 'object' && !Array.isArray(result) && VALID_CLASSIFICATIONS.has(result.classification)
      ? result
      : null;
  } catch (_) {
    return null;
  }
}

function canonicalClassification(result) {
  const parsed = typeof result === 'string' ? parsePersistedClassification(result) : result;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !VALID_CLASSIFICATIONS.has(parsed.classification)) {
    throw new TypeError('A valid classified result with an allowed classification is required.');
  }
  return { result: parsed, json: JSON.stringify(parsed) };
}

function sha256Hex(value) {
  const input = unescape(encodeURIComponent(value));
  const words = [];
  for (let index = 0; index < input.length; index += 1) {
    words[index >> 2] = (words[index >> 2] || 0) | (input.charCodeAt(index) << ((3 - (index % 4)) * 8));
  }
  const bitLength = input.length * 8;
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (24 - (bitLength % 32)));
  words[(((bitLength + 64) >> 9) << 4) + 15] = bitLength;

  const constants = [];
  let candidate = 2;
  while (constants.length < 64) {
    let isPrime = true;
    for (let divisor = 2; divisor * divisor <= candidate; divisor += 1) {
      if (candidate % divisor === 0) { isPrime = false; break; }
    }
    if (isPrime) constants.push((Math.pow(candidate, 1 / 3) * 0x100000000) | 0);
    candidate += 1;
  }

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = words.slice(offset, offset + 16);
    for (let index = 16; index < 64; index += 1) {
      const x = schedule[index - 15];
      const y = schedule[index - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) | 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + constants[index] + schedule[index]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => (`00000000${(part >>> 0).toString(16)}`).slice(-8)).join('');
}

function activeLease(record, now) {
  return record.lease_expires_at && new Date(record.lease_expires_at).getTime() > now.getTime();
}

function dueForRetry(record, now) {
  return !record.next_attempt_at || new Date(record.next_attempt_at).getTime() <= now.getTime();
}

function executeAtomically(lock, operation) {
  if (typeof lock === 'function') return lock(operation);
  if (lock && typeof lock.execute === 'function') return lock.execute(operation);
  throw new TypeError('A ledger lock with an execute operation is required for atomic claims.');
}

function matchingRecord(repository, messageId) {
  return repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).indexes.gmail_message_id.get(messageId)?.[0] ?? null;
}

/**
 * A Sheet-backed retry ledger. Every mutation is protected by the supplied
 * script-wide lock so a message ID is claimed before any Gemini request occurs.
 */
export class ProcessedMessageLedger {
  constructor(repository, options = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    this.repository = repository;
    this.lock = options.lock;
    this.now = options.now ?? (() => new Date());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.hashClassification = options.hashClassification ?? sha256Hex;
    if (!Number.isFinite(this.leaseDurationMs) || this.leaseDurationMs <= 0) throw new TypeError('leaseDurationMs must be positive.');
  }

  claim(message, runId) {
    const messageId = asNonEmptyText(message?.gmail_message_id, 'gmail_message_id');
    const claimedRunId = asNonEmptyText(runId, 'run_id');
    return executeAtomically(this.lock, () => {
      const now = this.now();
      const existing = matchingRecord(this.repository, messageId);
      if (existing && TERMINAL_PROCESSED_MESSAGE_STATES.has(existing.state)) {
        return { claimed: false, reason: 'TERMINAL', record: existing };
      }
      if (existing && activeLease(existing, now)) {
        return { claimed: false, reason: 'LEASE_ACTIVE', record: existing };
      }
      if (existing && !dueForRetry(existing, now)) {
        return { claimed: false, reason: 'RETRY_NOT_DUE', record: existing };
      }

      const savedClassification = existing && parsePersistedClassification(existing.classification_json);
      const record = {
        ...(existing ?? {}),
        gmail_message_id: messageId,
        gmail_thread_id: message.gmail_thread_id ?? existing?.gmail_thread_id ?? null,
        received_at: message.received_at ?? existing?.received_at ?? null,
        run_id: claimedRunId,
        state: savedClassification ? PROCESSED_MESSAGE_STATE.CLASSIFIED : PROCESSED_MESSAGE_STATE.IN_PROGRESS,
        lease_expires_at: isoTimestamp(new Date(now.getTime() + this.leaseDurationMs)),
        attempt_count: asAttemptCount(existing?.attempt_count) + 1,
        next_attempt_at: null
      };
      this.repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [record]);
      return {
        claimed: true,
        shouldClassify: !savedClassification,
        classification: savedClassification,
        record
      };
    });
  }

  persistClassification(messageId, runId, result) {
    const id = asNonEmptyText(messageId, 'gmail_message_id');
    const ownerRunId = asNonEmptyText(runId, 'run_id');
    const classified = canonicalClassification(result);
    return executeAtomically(this.lock, () => {
      const record = matchingRecord(this.repository, id);
      this.#assertOwnedActiveClaim(record, id, ownerRunId);
      const updated = {
        ...record,
        state: PROCESSED_MESSAGE_STATE.CLASSIFIED,
        classification: classified.result.classification,
        classification_json: classified.json,
        classification_hash: this.hashClassification(classified.json),
        next_attempt_at: null
      };
      this.repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [updated]);
      return updated;
    });
  }

  complete(messageId, runId, outcome, options = {}) {
    const id = asNonEmptyText(messageId, 'gmail_message_id');
    const ownerRunId = asNonEmptyText(runId, 'run_id');
    const terminalState = options.state ?? PROCESSED_MESSAGE_STATE.COMPLETED;
    if (!TERMINAL_PROCESSED_MESSAGE_STATES.has(terminalState)) throw new TypeError('Only terminal ledger states can complete a message.');
    return executeAtomically(this.lock, () => {
      const record = matchingRecord(this.repository, id);
      if (record && TERMINAL_PROCESSED_MESSAGE_STATES.has(record.state)) return record;
      this.#assertOwnedActiveClaim(record, id, ownerRunId);
      const updated = {
        ...record,
        state: terminalState,
        outcome: asNonEmptyText(outcome, 'outcome'),
        application_id: options.applicationId ?? record.application_id ?? null,
        completed_at: isoTimestamp(this.now()),
        lease_expires_at: null,
        next_attempt_at: null,
        last_error_id: null
      };
      this.repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [updated]);
      return updated;
    });
  }

  markRetryableFailure(messageId, runId, nextAttemptAt, lastErrorId = null) {
    return this.#scheduleRetry(messageId, runId, nextAttemptAt, lastErrorId, PROCESSED_MESSAGE_STATE.RETRYABLE_FAILURE);
  }

  defer(messageId, runId, nextAttemptAt, lastErrorId = null) {
    return this.#scheduleRetry(messageId, runId, nextAttemptAt, lastErrorId, PROCESSED_MESSAGE_STATE.DEFERRED);
  }

  getPersistedClassification(messageId) {
    const id = asNonEmptyText(messageId, 'gmail_message_id');
    const record = matchingRecord(this.repository, id);
    const classification = record && parsePersistedClassification(record.classification_json);
    return classification ? { record, classification } : null;
  }

  #scheduleRetry(messageId, runId, nextAttemptAt, lastErrorId, state) {
    const id = asNonEmptyText(messageId, 'gmail_message_id');
    const ownerRunId = asNonEmptyText(runId, 'run_id');
    return executeAtomically(this.lock, () => {
      const record = matchingRecord(this.repository, id);
      this.#assertOwnedActiveClaim(record, id, ownerRunId);
      const updated = {
        ...record,
        state,
        lease_expires_at: null,
        next_attempt_at: isoTimestamp(nextAttemptAt),
        last_error_id: lastErrorId ?? null
      };
      this.repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [updated]);
      return updated;
    });
  }

  #assertOwnedActiveClaim(record, messageId, runId) {
    if (!record) throw new Error(`Message "${messageId}" has not been claimed.`);
    if (record.run_id !== runId) throw new Error(`Run "${runId}" does not own the claim for message "${messageId}".`);
    if (TERMINAL_PROCESSED_MESSAGE_STATES.has(record.state)) throw new Error(`Message "${messageId}" is already terminal.`);
    if (!activeLease(record, this.now())) throw new Error(`The claim lease for message "${messageId}" has expired.`);
  }
}

/** Adapts Apps Script's script-wide LockService to the ledger lock interface. */
export function createAppsScriptLedgerLock(lockService = globalThis.LockService, timeoutMs = 5000) {
  if (!lockService || typeof lockService.getScriptLock !== 'function') throw new TypeError('Apps Script LockService is required.');
  return Object.freeze({
    execute(operation) {
      const lock = lockService.getScriptLock();
      if (!lock.tryLock(timeoutMs)) throw new Error('Could not acquire the processing ledger lock.');
      try { return operation(); } finally { lock.releaseLock(); }
    }
  });
}

export const PROCESSED_MESSAGE_LEDGER_DEFAULTS = Object.freeze({ DEFAULT_LEASE_DURATION_MS });
