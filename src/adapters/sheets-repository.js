import {
  CLASSIFICATION,
  QUOTA_OPERATION,
  RELATIONSHIP_EXCEPTION_REASON,
  RELATIONSHIP_RESOLUTION,
  SHEET_HEADERS,
  SHEET_NAMES
} from '../core/domain-constants.js';

const GMAIL_IDENTIFIER_COLUMNS = new Set([
  'initial_message_id', 'initial_thread_id', 'last_message_id',
  'gmail_message_id', 'gmail_thread_id', 'source_message_id'
]);
const ISO_TIMESTAMP_COLUMNS = new Set([
  'application_date', 'received_at', 'lease_expires_at', 'next_attempt_at',
  'completed_at', 'changed_at', 'created_at', 'updated_at', 'deferred_at',
  'eligible_after', 'resolved_at', 'dataset_updated_at'
]);
const NUMBER_COLUMNS = new Set(['attempt_count', 'version', 'estimated_units', 'observed_units', 'elapsed_to_first_response_hours', 'company_application_rank']);
const BOOLEAN_COLUMNS = new Set(['has_response', 'reached_interview', 'reached_offer', 'retryable']);
const PRIMARY_KEY_BY_SHEET = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key',
  [SHEET_NAMES.PROCESSED_MESSAGES]: 'gmail_message_id',
  [SHEET_NAMES.PROCESSING_CHECKPOINT]: 'checkpoint_id',
  [SHEET_NAMES.CONFIGURATION]: 'config_key',
  [SHEET_NAMES.CONFIGURATION_AUDIT]: 'audit_id',
  [SHEET_NAMES.PROCESSING_FAILURES]: 'failure_id',
  [SHEET_NAMES.QUOTA_DEFERRALS]: 'deferral_id',
  [SHEET_NAMES.RELATIONSHIP_EXCEPTIONS]: 'exception_id',
  [SHEET_NAMES.REPORTING_DATASET]: 'application_id'
});
const LOGICAL_KEYS_BY_SHEET = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: ['application_id', 'dedup_key', 'initial_message_id', 'initial_thread_id'],
  [SHEET_NAMES.STATUS_HISTORY]: ['history_id', 'event_key', 'application_id', 'source_message_id'],
  [SHEET_NAMES.PROCESSED_MESSAGES]: ['gmail_message_id'],
  [SHEET_NAMES.PROCESSING_CHECKPOINT]: ['checkpoint_id'],
  [SHEET_NAMES.CONFIGURATION]: ['config_key'],
  [SHEET_NAMES.CONFIGURATION_AUDIT]: ['audit_id', 'config_key'],
  [SHEET_NAMES.PROCESSING_FAILURES]: ['failure_id', 'gmail_message_id'],
  [SHEET_NAMES.QUOTA_DEFERRALS]: ['deferral_id', 'gmail_message_id'],
  [SHEET_NAMES.RELATIONSHIP_EXCEPTIONS]: ['exception_id', 'gmail_message_id'],
  [SHEET_NAMES.REPORTING_DATASET]: ['application_id']
});
const SECRET_NAME = /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization)/i;
const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{20,}/;

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function toIsoUtc(value, field) {
  if (isBlank(value)) return null;
  if (value === 'Unavailable') return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Field "${field}" must be an ISO UTC date or an unavailable value.`);
  return date.toISOString();
}

function normalizeBoolean(value) {
  if (isBlank(value)) return null;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'TRUE') return true;
  if (value === 'false' || value === 'FALSE') return false;
  throw new TypeError(`Expected a boolean value, received "${value}".`);
}

function normalizeNumber(value, field) {
  if (isBlank(value)) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Field "${field}" must be a finite number.`);
  return number;
}

function assertNoSecrets(value, path = '') {
  if (typeof value === 'string' && GOOGLE_API_KEY.test(value)) {
    throw new Error(`Secrets must not be stored in Sheets (${path || 'value'}).`);
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return;
  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (SECRET_NAME.test(key)) throw new Error(`Secrets must not be stored in Sheets (${nestedPath}).`);
    assertNoSecrets(nestedValue, nestedPath);
  }
}

function sheetFor(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Required tracker sheet "${sheetName}" does not exist. Initialize the schema first.`);
  return sheet;
}

function normalizeCell(header, value, displayValue) {
  if (isBlank(value)) return null;
  if (GMAIL_IDENTIFIER_COLUMNS.has(header)) return String(displayValue ?? value);
  if (ISO_TIMESTAMP_COLUMNS.has(header) || header.endsWith('_at')) return toIsoUtc(value, header);
  if (NUMBER_COLUMNS.has(header)) return normalizeNumber(value, header);
  if (BOOLEAN_COLUMNS.has(header)) return normalizeBoolean(value);
  return value instanceof Date ? value.toISOString() : String(value);
}

const MAX_DIAGNOSTIC_LENGTH = 500;
const QUOTA_OPERATIONS = new Set(Object.values(QUOTA_OPERATION));
const RELATIONSHIP_REASONS = new Set(Object.values(RELATIONSHIP_EXCEPTION_REASON));
const CLASSIFICATIONS = new Set(Object.values(CLASSIFICATION));

function serializeCell(value) {
  return value === null || value === undefined ? '' : value;
}

function defaultOperationalId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new Error('An operational-record ID generator is required outside Google Apps Script.');
}

function diagnosticText(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

/** Removes common credentials and personal email addresses from persistent diagnostics. */
export function redactDiagnostic(value) {
  const redacted = diagnosticText(value ?? '')
    .replace(GOOGLE_API_KEY, '[REDACTED_API_KEY]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(authorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > MAX_DIAGNOSTIC_LENGTH ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…` : redacted;
}

function normalizeReasonCode(value) {
  const normalized = String(value ?? 'PROCESSING_ERROR').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
  return normalized || 'PROCESSING_ERROR';
}

function requireValue(record, field, operation) {
  if (isBlank(record[field])) throw new TypeError(`${operation} requires "${field}".`);
  return record[field];
}

function normalizeAttemptCount(value) {
  const count = value ?? 0;
  if (!Number.isInteger(Number(count)) || Number(count) < 0) {
    throw new TypeError('Processing failure attempt_count must be a non-negative integer.');
  }
  return Number(count);
}

function serializeCandidateApplicationIds(value) {
  if (isBlank(value)) return '[]';
  if (Array.isArray(value)) return JSON.stringify(value.map(String));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return JSON.stringify(parsed.map(String));
    } catch (_error) {
      // A single supplied candidate ID is represented as a one-element list.
    }
  }
  return JSON.stringify([String(value)]);
}

function logIndependentAppendFailure(error) {
  const message = `Unable to append independent operational record: ${redactDiagnostic(error)}`;
  if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(message);
  else if (typeof Logger !== 'undefined' && typeof Logger.log === 'function') Logger.log(message);
}

function normalizeRecord(headers, record, displayRecord = {}) {
  assertNoSecrets(record);
  return Object.fromEntries(headers.map((header) => [
    header,
    normalizeCell(header, record[header], displayRecord[header])
  ]));
}

function recordFromRow(headers, row, displayRow) {
  const raw = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  const display = Object.fromEntries(headers.map((header, index) => [header, displayRow?.[index]]));
  return normalizeRecord(headers, raw, display);
}

function buildIndexes(records, keys) {
  return Object.fromEntries(keys.map((key) => {
    const index = new Map();
    for (const record of records) {
      const value = record[key];
      if (value === null || value === undefined || value === '') continue;
      const indexedRecords = index.get(String(value)) ?? [];
      indexedRecords.push(record);
      index.set(String(value), indexedRecords);
    }
    return [key, index];
  }));
}

function ensureCapacity(sheet, requiredRows) {
  if (typeof sheet.getMaxRows !== 'function' || typeof sheet.insertRowsAfter !== 'function') return;
  const currentRows = sheet.getMaxRows();
  if (requiredRows > currentRows) sheet.insertRowsAfter(currentRows, requiredRows - currentRows);
}

function setGmailColumnsAsText(sheet, headers, rowCount) {
  if (rowCount === 0) return;
  headers.forEach((header, index) => {
    if (GMAIL_IDENTIFIER_COLUMNS.has(header)) sheet.getRange(2, index + 1, rowCount, 1).setNumberFormat('@');
  });
}

/**
 * Google Sheets adapter for the tracker operational tabs. It intentionally has
 * no PropertiesService access: credentials (including GEMINI_API_KEY) stay out
 * of spreadsheet storage and are handled only by the configuration service.
 */
export class SheetsRepository {
  constructor(spreadsheet, options = {}) {
    if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') {
      throw new TypeError('A Google Spreadsheet instance is required.');
    }
    this.spreadsheet = spreadsheet;
    this.createId = options.createId ?? defaultOperationalId;
    this.now = options.now ?? (() => new Date());
    this.logError = options.logError ?? logIndependentAppendFailure;
  }

  _operationalNow() {
    return typeof this.now === 'function' ? this.now() : this.now;
  }

  /**
   * Appends directly to an operational log tab. This deliberately bypasses
   * read/merge/upsert state writes, so callers can audit a failed state write.
   */
  _appendOperationalRecord(sheetName, record) {
    const headers = SHEET_HEADERS[sheetName];
    const normalized = normalizeRecord(headers, record);
    const sheet = sheetFor(this.spreadsheet, sheetName);
    const row = Math.max(2, sheet.getLastRow() + 1);
    ensureCapacity(sheet, row);
    headers.forEach((header, index) => {
      if (GMAIL_IDENTIFIER_COLUMNS.has(header) && typeof sheet.getRange(row, index + 1).setNumberFormat === 'function') {
        sheet.getRange(row, index + 1).setNumberFormat('@');
      }
    });
    sheet.getRange(row, 1, 1, headers.length).setValues([headers.map((header) => serializeCell(normalized[header]))]);
    return normalized;
  }

  appendProcessingFailure(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('Processing failure must be a record.');
    }
    const error = record.error;
    const operationalRecord = {
      failure_id: record.failure_id ?? this.createId(),
      run_id: requireValue(record, 'run_id', 'Processing failure'),
      gmail_message_id: record.gmail_message_id ?? null,
      stage: requireValue(record, 'stage', 'Processing failure'),
      reason_code: normalizeReasonCode(record.reason_code ?? error?.code ?? error?.name),
      reason_detail_redacted: redactDiagnostic(record.reason_detail_redacted ?? record.reason_detail ?? error),
      occurred_at: record.occurred_at ?? this._operationalNow(),
      retryable: record.retryable ?? false,
      attempt_count: normalizeAttemptCount(record.attempt_count)
    };
    return this._appendOperationalRecord(SHEET_NAMES.PROCESSING_FAILURES, operationalRecord);
  }

  /**
   * Records a failure without allowing a failed audit append to replace the
   * exception that originally interrupted processing.
   */
  recordProcessingFailureAndRethrow(error, context = {}) {
    try {
      this.appendProcessingFailure({ ...context, error });
    } catch (appendError) {
      this.logError(appendError);
    }
    throw error;
  }

  appendQuotaDeferral(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('Quota deferral must be a record.');
    }
    const operation = requireValue(record, 'operation', 'Quota deferral');
    if (!QUOTA_OPERATIONS.has(operation)) throw new TypeError(`Unsupported quota operation "${operation}".`);
    const operationalRecord = {
      deferral_id: record.deferral_id ?? this.createId(),
      run_id: requireValue(record, 'run_id', 'Quota deferral'),
      gmail_message_id: record.gmail_message_id ?? null,
      operation,
      quota_name: requireValue(record, 'quota_name', 'Quota deferral'),
      estimated_units: record.estimated_units ?? null,
      observed_units: record.observed_units ?? null,
      deferred_at: record.deferred_at ?? this._operationalNow(),
      eligible_after: requireValue(record, 'eligible_after', 'Quota deferral'),
      reason: redactDiagnostic(record.reason),
      resolved_at: record.resolved_at ?? null
    };
    return this._appendOperationalRecord(SHEET_NAMES.QUOTA_DEFERRALS, operationalRecord);
  }

  appendRelationshipException(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('Relationship exception must be a record.');
    }
    const classification = requireValue(record, 'classification', 'Relationship exception');
    const reason = requireValue(record, 'reason', 'Relationship exception');
    if (!CLASSIFICATIONS.has(classification) || classification === CLASSIFICATION.IRRELEVANT) {
      throw new TypeError(`Relationship exception requires a relevant classification, received "${classification}".`);
    }
    if (!RELATIONSHIP_REASONS.has(reason)) throw new TypeError(`Unsupported relationship exception reason "${reason}".`);
    const operationalRecord = {
      exception_id: record.exception_id ?? this.createId(),
      gmail_message_id: requireValue(record, 'gmail_message_id', 'Relationship exception'),
      classification,
      candidate_application_ids: serializeCandidateApplicationIds(record.candidate_application_ids),
      evidence_summary: redactDiagnostic(record.evidence_summary),
      reason,
      created_at: record.created_at ?? this._operationalNow(),
      resolution: record.resolution ?? RELATIONSHIP_RESOLUTION.PENDING,
      resolved_application_id: record.resolved_application_id ?? null,
      resolved_at: record.resolved_at ?? null,
      resolved_by: record.resolved_by ?? null
    };
    if (!Object.values(RELATIONSHIP_RESOLUTION).includes(operationalRecord.resolution)) {
      throw new TypeError(`Unsupported relationship resolution "${operationalRecord.resolution}".`);
    }
    return this._appendOperationalRecord(SHEET_NAMES.RELATIONSHIP_EXCEPTIONS, operationalRecord);
  }

  readTable(sheetName) {
    const headers = SHEET_HEADERS[sheetName];
    if (!headers) throw new Error(`Unknown tracker sheet "${sheetName}".`);
    const sheet = sheetFor(this.spreadsheet, sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) {
      return { sheetName, records: [], indexes: buildIndexes([], LOGICAL_KEYS_BY_SHEET[sheetName]) };
    }

    const range = sheet.getRange(2, 1, lastRow - 1, headers.length);
    const rows = range.getValues();
    const displayRows = typeof range.getDisplayValues === 'function' ? range.getDisplayValues() : undefined;
    const records = rows.map((row, index) => recordFromRow(headers, row, displayRows?.[index]));
    return { sheetName, records, indexes: buildIndexes(records, LOGICAL_KEYS_BY_SHEET[sheetName]) };
  }

  readAll() {
    return Object.fromEntries(Object.keys(SHEET_HEADERS).map((sheetName) => [sheetName, this.readTable(sheetName)]));
  }

  /** Performs one complete-table setValues write per changed tab, preserving omitted fields on an update. */
  upsert(sheetName, records) {
    if (!Array.isArray(records)) throw new TypeError('Upsert records must be an array.');
    const headers = SHEET_HEADERS[sheetName];
    const key = PRIMARY_KEY_BY_SHEET[sheetName];
    if (!headers || !key) throw new Error(`Unknown tracker sheet "${sheetName}".`);
    if (records.length === 0) return { inserted: 0, updated: 0, records: [] };

    const table = this.readTable(sheetName);
    const existingByKey = new Map(table.records.map((record) => [String(record[key]), record]));
    const orderedKeys = table.records.map((record) => String(record[key]));
    const mergedByKey = new Map(table.records.map((record) => [String(record[key]), record]));
    let inserted = 0;
    let updated = 0;

    for (const patch of records) {
      assertNoSecrets(patch);
      const rawKey = patch[key];
      if (isBlank(rawKey)) throw new TypeError(`Upsert into "${sheetName}" requires "${key}".`);
      const normalizedKey = String(rawKey);
      const prior = existingByKey.get(normalizedKey);
      const merged = { ...(prior ?? {}), ...patch, [key]: normalizedKey };
      const normalized = normalizeRecord(headers, merged);
      if (prior) updated += 1;
      else {
        inserted += 1;
        orderedKeys.push(normalizedKey);
      }
      mergedByKey.set(normalizedKey, normalized);
      existingByKey.set(normalizedKey, normalized);
    }

    const finalRecords = orderedKeys.map((recordKey) => mergedByKey.get(recordKey));
    const finalRows = finalRecords.map((record) => headers.map((header) => serializeCell(record[header])));
    const sheet = sheetFor(this.spreadsheet, sheetName);
    ensureCapacity(sheet, finalRows.length + 1);
    setGmailColumnsAsText(sheet, headers, finalRows.length);
    sheet.getRange(2, 1, finalRows.length, headers.length).setValues(finalRows);
    return { inserted, updated, records: finalRecords };
  }

  /** Applies batch upserts for any subset of operational tabs. */
  upsertAll(recordsBySheet) {
    if (!recordsBySheet || typeof recordsBySheet !== 'object' || Array.isArray(recordsBySheet)) {
      throw new TypeError('Batch upserts must be keyed by sheet name.');
    }
    return Object.fromEntries(Object.entries(recordsBySheet).map(([sheetName, records]) => [sheetName, this.upsert(sheetName, records)]));
  }
}

export const SHEETS_REPOSITORY_METADATA = Object.freeze({
  GMAIL_IDENTIFIER_COLUMNS: [...GMAIL_IDENTIFIER_COLUMNS],
  ISO_TIMESTAMP_COLUMNS: [...ISO_TIMESTAMP_COLUMNS],
  PRIMARY_KEY_BY_SHEET,
  LOGICAL_KEYS_BY_SHEET
});
