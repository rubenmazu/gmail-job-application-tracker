import {
  CONFIGURATION_KEY,
  DEFAULT_CONFIGURATION,
  SHEET_NAMES
} from '../core/domain-constants.js';
import { TERMINAL_PROCESSED_MESSAGE_STATES } from '../core/processed-message-ledger.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_GMAIL_SEARCH_PAGE_SIZE = 500;

function asDate(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`"${field}" must be a valid timestamp.`);
  return date;
}

function toIsoTimestamp(value, field) {
  return asDate(value, field).toISOString();
}

function asNonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`"${field}" must be a non-negative integer.`);
  return number;
}

function asPositiveInteger(value, field) {
  const number = asNonNegativeInteger(value, field);
  if (number === 0) throw new TypeError(`"${field}" must be a positive integer.`);
  return number;
}

function asNonEmptyText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`"${field}" must be a non-empty string.`);
  return value;
}

function checkpointPair(checkpoint) {
  if (!checkpoint || !checkpoint.last_completed_received_at) return null;
  return {
    received_at: toIsoTimestamp(checkpoint.last_completed_received_at, 'last_completed_received_at'),
    gmail_message_id: checkpoint.last_completed_message_id == null ? '' : String(checkpoint.last_completed_message_id)
  };
}

function candidatePair(message) {
  return {
    received_at: toIsoTimestamp(message?.received_at, 'received_at'),
    gmail_message_id: asNonEmptyText(message?.gmail_message_id, 'gmail_message_id')
  };
}

/** Sorts messages chronologically, using the Gmail message ID as a stable tie-breaker. */
export function compareMessageOrder(left, right) {
  const leftPair = candidatePair(left);
  const rightPair = candidatePair(right);
  const timeDifference = new Date(leftPair.received_at).getTime() - new Date(rightPair.received_at).getTime();
  if (timeDifference !== 0) return timeDifference;
  return leftPair.gmail_message_id.localeCompare(rightPair.gmail_message_id);
}

/** Returns true only when a message pair is strictly after a persisted checkpoint pair. */
export function isAfterCheckpoint(message, checkpoint) {
  const watermark = checkpointPair(checkpoint);
  if (!watermark) return true;
  return compareMessageOrder(message, watermark) > 0;
}

function uniqueSortedMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  const byId = new Map();
  for (const message of messages) {
    const pair = candidatePair(message);
    const normalized = { ...message, ...pair };
    const existing = byId.get(pair.gmail_message_id);
    if (!existing || compareMessageOrder(normalized, existing) < 0) byId.set(pair.gmail_message_id, normalized);
  }
  return [...byId.values()].sort(compareMessageOrder);
}

function ledgerByMessageId(ledgerRecords) {
  if (!Array.isArray(ledgerRecords)) throw new TypeError('ledgerRecords must be an array.');
  return new Map(ledgerRecords
    .filter((record) => record?.gmail_message_id != null && String(record.gmail_message_id) !== '')
    .map((record) => [String(record.gmail_message_id), record]));
}

function isTerminalRecord(record) {
  return Boolean(record && TERMINAL_PROCESSED_MESSAGE_STATES.has(record.state));
}

/**
 * Selects messages for a run without changing Gmail or ledger state. Terminal
 * ledger IDs are always excluded; non-terminal records remain visible even if
 * their timestamp is on or before the watermark so recovery cannot lose them.
 */
export function selectIncrementalCandidates(messages, { checkpoint = null, ledgerRecords = [], maxMessagesPerRun } = {}) {
  const recordsById = ledgerByMessageId(ledgerRecords);
  const eligible = uniqueSortedMessages(messages).filter((message) => {
    const record = recordsById.get(message.gmail_message_id);
    if (isTerminalRecord(record)) return false;
    return isAfterCheckpoint(message, checkpoint) || Boolean(record);
  });
  if (maxMessagesPerRun === undefined || maxMessagesPerRun === null || maxMessagesPerRun === '') return eligible;
  return eligible.slice(0, asPositiveInteger(maxMessagesPerRun, 'maxMessagesPerRun'));
}

/**
 * Finds the furthest checkpoint that can safely be committed. The scan stops at
 * the first non-terminal/missing ledger entry, therefore it cannot skip an
 * incomplete message merely because a later message completed first.
 */
export function findContiguousTerminalCheckpoint(messages, { checkpoint = null, ledgerRecords = [] } = {}) {
  const recordsById = ledgerByMessageId(ledgerRecords);
  let contiguous = checkpointPair(checkpoint);
  for (const message of uniqueSortedMessages(messages)) {
    if (!isAfterCheckpoint(message, checkpoint)) continue;
    if (!isTerminalRecord(recordsById.get(message.gmail_message_id))) break;
    contiguous = candidatePair(message);
  }
  if (!contiguous || (checkpointPair(checkpoint)
    && contiguous.received_at === checkpointPair(checkpoint).received_at
    && contiguous.gmail_message_id === checkpointPair(checkpoint).gmail_message_id)) {
    return checkpoint ?? null;
  }
  return {
    ...(checkpoint ?? {}),
    last_completed_received_at: contiguous.received_at,
    last_completed_message_id: contiguous.gmail_message_id
  };
}

function gmailQueryDate(value) {
  const date = asDate(value, 'watermark');
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/** Builds a Gmail search query broad enough to include the requested overlap window. */
export function buildIncrementalGmailQuery(watermark, overlapMinutes = 0) {
  if (!watermark) return 'in:anywhere';
  const overlap = asNonNegativeInteger(overlapMinutes, 'overlapMinutes');
  const from = new Date(asDate(watermark, 'watermark').getTime() - overlap * 60 * 1000);
  // Gmail's after operator is day-granular; exact pair filtering happens locally.
  return `in:anywhere after:${gmailQueryDate(from)}`;
}

function callMessage(message, method, fallback = '') {
  if (!message || typeof message[method] !== 'function') return fallback;
  return message[method]();
}

function mapGmailMessage(message, thread) {
  const gmailMessageId = String(callMessage(message, 'getId'));
  if (!gmailMessageId) throw new Error('Gmail returned a message without an ID.');
  const messageThread = typeof message?.getThread === 'function' ? message.getThread() : thread;
  const gmailThreadId = String(callMessage(messageThread, 'getId', callMessage(thread, 'getId', '')));
  if (!gmailThreadId) throw new Error(`Gmail message "${gmailMessageId}" has no thread ID.`);
  const receivedAt = toIsoTimestamp(callMessage(message, 'getDate'), 'Gmail message date');
  return Object.freeze({
    gmail_message_id: gmailMessageId,
    gmail_thread_id: gmailThreadId,
    received_at: receivedAt,
    subject: String(callMessage(message, 'getSubject', '')),
    sender: String(callMessage(message, 'getFrom', '')),
    plain_body: String(callMessage(message, 'getPlainBody', ''))
  });
}

/**
 * Read-only Gmail adapter. It uses only search/getMessages/getters and never
 * labels, archives, marks read, trashes, or otherwise mutates mail.
 */
export class GmailIncrementalReader {
  constructor(gmailApp = globalThis.GmailApp, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
    if (!gmailApp || typeof gmailApp.search !== 'function') throw new TypeError('A GmailApp-compatible read-only search adapter is required.');
    this.gmailApp = gmailApp;
    this.pageSize = asPositiveInteger(pageSize, 'pageSize');
    if (this.pageSize > MAX_GMAIL_SEARCH_PAGE_SIZE) throw new RangeError(`pageSize cannot exceed ${MAX_GMAIL_SEARCH_PAGE_SIZE}.`);
  }

  readMessages({ watermark = null, overlapMinutes = 0 } = {}) {
    const query = buildIncrementalGmailQuery(watermark, overlapMinutes);
    const messagesById = new Map();
    let start = 0;
    while (true) {
      const threads = this.gmailApp.search(query, start, this.pageSize);
      if (!Array.isArray(threads)) throw new TypeError('Gmail search must return an array of threads.');
      for (const thread of threads) {
        if (!thread || typeof thread.getMessages !== 'function') throw new TypeError('Gmail search returned a thread without getMessages().');
        for (const message of thread.getMessages()) {
          const candidate = mapGmailMessage(message, thread);
          const existing = messagesById.get(candidate.gmail_message_id);
          if (!existing || compareMessageOrder(candidate, existing) < 0) messagesById.set(candidate.gmail_message_id, candidate);
        }
      }
      if (threads.length < this.pageSize) break;
      start += threads.length;
    }
    return [...messagesById.values()].sort(compareMessageOrder);
  }
}

function configurationValue(records, key) {
  return records.find((record) => record.config_key === key)?.config_value;
}

function defaultCreateId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('A checkpoint ID generator is required outside Google Apps Script.');
}

function defaultNow() {
  return new Date();
}

/**
 * Coordinates non-mutating Gmail discovery with the Sheets ledger/checkpoint.
 * The caller still owns claims and message processing; this class only plans
 * candidates and safely persists a checkpoint after terminal completion.
 */
export class IncrementalProcessingScheduler {
  constructor(repository, gmailReader, { now = defaultNow, createId = defaultCreateId } = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    if (!gmailReader || typeof gmailReader.readMessages !== 'function') {
      throw new TypeError('A GmailIncrementalReader-compatible reader is required.');
    }
    this.repository = repository;
    this.gmailReader = gmailReader;
    this.now = now;
    this.createId = createId;
  }

  getCheckpoint() {
    const records = this.repository.readTable(SHEET_NAMES.PROCESSING_CHECKPOINT).records;
    if (records.length > 1) throw new Error('Processing_Checkpoint must contain at most one active checkpoint.');
    return records[0] ?? null;
  }

  plan({ overlapMinutes, maxMessagesPerRun } = {}) {
    const checkpoint = this.getCheckpoint();
    const configurationRecords = this.repository.readTable(SHEET_NAMES.CONFIGURATION).records;
    const configuredOverlap = overlapMinutes ?? configurationValue(configurationRecords, CONFIGURATION_KEY.OVERLAP_MINUTES) ?? DEFAULT_CONFIGURATION[CONFIGURATION_KEY.OVERLAP_MINUTES];
    const configuredMaximum = maxMessagesPerRun ?? configurationValue(configurationRecords, CONFIGURATION_KEY.MAX_MESSAGES_PER_RUN);
    const ledgerRecords = this.repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records;
    const discoveredMessages = this.gmailReader.readMessages({ watermark: checkpoint?.last_completed_received_at ?? null, overlapMinutes: configuredOverlap });
    const candidates = selectIncrementalCandidates(discoveredMessages, {
      checkpoint,
      ledgerRecords,
      maxMessagesPerRun: configuredMaximum
    });
    return Object.freeze({
      checkpoint,
      overlapMinutes: asNonNegativeInteger(configuredOverlap, 'overlapMinutes'),
      discoveredMessages: Object.freeze(discoveredMessages),
      candidates: Object.freeze(candidates)
    });
  }

  advanceCheckpoint(plan, runId) {
    if (!plan || !Array.isArray(plan.discoveredMessages)) throw new TypeError('A scheduler plan is required to advance the checkpoint.');
    const ownerRunId = asNonEmptyText(runId, 'runId');
    const current = this.getCheckpoint();
    const ledgerRecords = this.repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records;
    const next = findContiguousTerminalCheckpoint(plan.discoveredMessages, { checkpoint: current, ledgerRecords });
    if (!next || (current
      && next.last_completed_received_at === current.last_completed_received_at
      && next.last_completed_message_id === current.last_completed_message_id)) {
      return Object.freeze({ advanced: false, checkpoint: current });
    }
    const persisted = {
      ...next,
      checkpoint_id: current?.checkpoint_id ?? this.createId(),
      updated_at: toIsoTimestamp(typeof this.now === 'function' ? this.now() : this.now, 'updated_at'),
      last_run_id: ownerRunId
    };
    this.repository.upsert(SHEET_NAMES.PROCESSING_CHECKPOINT, [persisted]);
    return Object.freeze({ advanced: true, checkpoint: persisted });
  }
}

export const GMAIL_INCREMENTAL_READER_DEFAULTS = Object.freeze({
  DEFAULT_PAGE_SIZE,
  MAX_GMAIL_SEARCH_PAGE_SIZE
});
