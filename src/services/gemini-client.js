import { CONFIGURATION_KEY, CLASSIFICATION, QUOTA_OPERATION } from '../core/domain-constants.js';
import { QUOTA_NAME } from '../core/quota-guard.js';

const KEY = CONFIGURATION_KEY;
const CLASSIFICATIONS = Object.freeze(Object.values(CLASSIFICATION));
const CLASSIFICATION_SET = new Set(CLASSIFICATIONS);
const RESULT_FIELDS = Object.freeze([
  'classification', 'role', 'company', 'applicationDate', 'platform', 'location', 'evidence'
]);
const EVIDENCE_FIELDS = Object.freeze(['confidence', 'excerpt']);
const DEFAULT_EXPECTED_OUTPUT_TOKENS = 300;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** The exact structured-output contract requested from Gemini. */
export const GEMINI_CLASSIFICATION_JSON_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: RESULT_FIELDS,
  properties: {
    classification: { type: 'string', enum: CLASSIFICATIONS },
    role: { type: ['string', 'null'] }, company: { type: ['string', 'null'] },
    applicationDate: { type: ['string', 'null'], format: 'date' },
    platform: { type: ['string', 'null'] }, location: { type: ['string', 'null'] },
    evidence: {
      type: 'object', additionalProperties: false, required: EVIDENCE_FIELDS,
      properties: { confidence: { type: 'number', minimum: 0, maximum: 1 }, excerpt: { type: 'string', maxLength: 500 } }
    }
  }
});

export class GeminiClientError extends Error {
  constructor(code, message, { retryable = false, status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GeminiClientError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function asNonEmptyText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new GeminiClientError('INVALID_MESSAGE', `"${field}" must be a non-empty string.`);
  return value.trim();
}

function asConfiguration(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (Array.isArray(value)) return Object.fromEntries(value.map(({ config_key, config_value }) => [config_key, config_value]));
  if (!isPlainObject(value)) throw new GeminiClientError('INVALID_CONFIGURATION', 'Gemini configuration must be an object.');
  return value;
}

function asBoolean(value, field) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new GeminiClientError('INVALID_CONFIGURATION', `Gemini configuration "${field}" must be boolean.`);
}

function asPositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new GeminiClientError('INVALID_CONFIGURATION', `Gemini configuration "${field}" must be a positive integer.`);
  return number;
}

function asTimestamp(value, field) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new GeminiClientError('INVALID_CONFIGURATION', `Gemini configuration "${field}" must be a valid timestamp.`);
  return time;
}

function effectiveConfiguration(configuration) {
  const config = asConfiguration(configuration);
  const modelId = asNonEmptyText(config[KEY.GEMINI_MODEL_ID], KEY.GEMINI_MODEL_ID);
  const modelVerifiedAt = asTimestamp(config[KEY.GEMINI_MODEL_VERIFIED_AT], KEY.GEMINI_MODEL_VERIFIED_AT);
  const enabled = asBoolean(config[KEY.GEMINI_ENABLED], KEY.GEMINI_ENABLED);
  const acknowledgedAt = asTimestamp(config[KEY.PRIVACY_ACKNOWLEDGED_AT], KEY.PRIVACY_ACKNOWLEDGED_AT);
  const withdrawnAt = config[KEY.PRIVACY_WITHDRAWN_AT] ? asTimestamp(config[KEY.PRIVACY_WITHDRAWN_AT], KEY.PRIVACY_WITHDRAWN_AT) : null;
  if (!enabled || withdrawnAt !== null && withdrawnAt >= acknowledgedAt) {
    throw new GeminiClientError('GEMINI_NOT_AUTHORIZED', 'Gemini submission requires an active, unwithdrawn privacy acknowledgement.');
  }
  const freeTier = {
    rpm: asPositiveInteger(config[KEY.GEMINI_FREE_TIER_RPM], KEY.GEMINI_FREE_TIER_RPM),
    tpm: asPositiveInteger(config[KEY.GEMINI_FREE_TIER_TPM], KEY.GEMINI_FREE_TIER_TPM),
    rpd: asPositiveInteger(config[KEY.GEMINI_FREE_TIER_RPD], KEY.GEMINI_FREE_TIER_RPD)
  };
  return Object.freeze({
    modelId, modelVerifiedAt, freeTier,
    inputCharacterLimit: asPositiveInteger(config[KEY.GEMINI_INPUT_CHAR_LIMIT], KEY.GEMINI_INPUT_CHAR_LIMIT)
  });
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(EMAIL_ADDRESS, '[redacted email]').replace(/\s+/g, ' ').trim();
}

function senderDomain(message) {
  const explicitDomain = message.sender_domain ?? message.senderDomain;
  if (explicitDomain !== null && explicitDomain !== undefined && String(explicitDomain).trim() !== '') {
    return String(explicitDomain).trim().toLowerCase();
  }
  const sender = String(message.sender ?? message.from ?? '');
  const match = sender.match(/@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  return match ? match[1].toLowerCase() : null;
}

function dateOnly(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new GeminiClientError('INVALID_MESSAGE', `"${field}" must be a valid date.`);
  return date.toISOString();
}

/**
 * Creates the only message-derived content that can be sent externally. It
 * excludes attachments, raw addresses, and conversation history by accepting
 * exactly one body field and only its bounded normalized excerpt.
 */
export function createGeminiClassificationPayload(message, inputCharacterLimit) {
  if (!isPlainObject(message)) throw new GeminiClientError('INVALID_MESSAGE', 'A Gmail message object is required.');
  const limit = asPositiveInteger(inputCharacterLimit, KEY.GEMINI_INPUT_CHAR_LIMIT);
  asNonEmptyText(message.gmail_message_id, 'gmail_message_id');
  const normalizedBody = normalizeText(message.body ?? message.body_text ?? '');
  return Object.freeze({
    subject: normalizeText(message.subject ?? ''),
    senderDomain: senderDomain(message),
    receivedAt: dateOnly(message.received_at ?? message.receivedAt ?? null, 'received_at'),
    excerpt: normalizedBody.slice(0, limit)
  });
}

function requestText(payload) {
  return [
    'Classify this single email for a job-application tracker and extract only stated data.',
    `Return JSON that conforms exactly to the supplied schema. Valid classifications: ${CLASSIFICATIONS.join(', ')}.`,
    'Use null where a requested value is absent. Do not add fields or prose.',
    JSON.stringify(payload)
  ].join('\n');
}

/** Creates the minimal GenerateContent request body, including strict structured output. */
export function createGeminiGenerateContentRequest(payload) {
  return {
    contents: [{ role: 'user', parts: [{ text: requestText(payload) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: GEMINI_CLASSIFICATION_JSON_SCHEMA
    }
  };
}

function extractResponseText(responsePayload) {
  const candidates = responsePayload?.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini response must contain exactly one candidate.', { retryable: true });
  }
  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0]?.text !== 'string') {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini response candidate must contain exactly one JSON text part.', { retryable: true });
  }
  return parts[0].text;
}

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function assertExactFields(value, fields, name) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))) {
    throw new GeminiClientError('INVALID_RESPONSE', `${name} has missing or additional properties.`, { retryable: true });
  }
}

/** Parses and locally validates Gemini output before it can reach domain code. */
export function parseGeminiClassificationResponse(responseText) {
  if (typeof responseText !== 'string' || responseText.trim() === '') {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini returned an empty structured response.', { retryable: true });
  }
  let result;
  try { result = JSON.parse(responseText); } catch (error) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini returned malformed JSON.', { retryable: true, cause: error });
  }
  assertExactFields(result, RESULT_FIELDS, 'Gemini classification result');
  if (!CLASSIFICATION_SET.has(result.classification)) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini returned an unsupported classification.', { retryable: true });
  }
  for (const field of ['role', 'company', 'platform', 'location']) {
    if (result[field] !== null && typeof result[field] !== 'string') {
      throw new GeminiClientError('INVALID_RESPONSE', `Gemini field "${field}" must be a string or null.`, { retryable: true });
    }
  }
  if (result.applicationDate !== null && !validDateOnly(result.applicationDate)) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini field "applicationDate" must be an ISO calendar date or null.', { retryable: true });
  }
  assertExactFields(result.evidence, EVIDENCE_FIELDS, 'Gemini evidence');
  if (typeof result.evidence.confidence !== 'number' || !Number.isFinite(result.evidence.confidence) ||
    result.evidence.confidence < 0 || result.evidence.confidence > 1) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini evidence confidence must be a number from 0 through 1.', { retryable: true });
  }
  if (typeof result.evidence.excerpt !== 'string' || Array.from(result.evidence.excerpt).length > 500) {
    throw new GeminiClientError('INVALID_RESPONSE', 'Gemini evidence excerpt must be a string of at most 500 characters.', { retryable: true });
  }
  return Object.freeze({
    classification: result.classification, role: result.role, company: result.company,
    applicationDate: result.applicationDate, platform: result.platform, location: result.location,
    evidence: Object.freeze({ confidence: result.evidence.confidence, excerpt: result.evidence.excerpt })
  });
}

function responseStatus(response) {
  if (!response || typeof response.getResponseCode !== 'function') {
    throw new GeminiClientError('INVALID_PROVIDER', 'UrlFetchApp returned an invalid response object.', { retryable: true });
  }
  return Number(response.getResponseCode());
}

function responseBody(response) {
  if (typeof response.getContentText !== 'function') {
    throw new GeminiClientError('INVALID_PROVIDER', 'UrlFetchApp response has no body reader.', { retryable: true });
  }
  return response.getContentText();
}

function providerError(status, body) {
  const message = `Gemini GenerateContent failed with HTTP ${status}.`;
  if (status === 401 || status === 403) return new GeminiClientError('GEMINI_AUTHORIZATION_FAILED', message, { status });
  if (status === 404) return new GeminiClientError('GEMINI_MODEL_UNAVAILABLE', message, { status });
  return new GeminiClientError('GEMINI_PROVIDER_FAILED', message, { retryable: status === 429 || status >= 500, status, cause: body });
}

function apiKey(propertiesService) {
  const properties = propertiesService?.getScriptProperties?.();
  const key = properties?.getProperty?.('GEMINI_API_KEY');
  if (typeof key !== 'string' || key.trim() === '') {
    throw new GeminiClientError('GEMINI_API_KEY_MISSING', 'GEMINI_API_KEY must be stored in Script Properties.');
  }
  return key.trim();
}

/**
 * Apps Script Gemini boundary. It permits at most one GenerateContent call for
 * a claimed message, reuses a persisted valid response, and persists a new
 * locally validated response to the ledger before returning it to domain code.
 */
export class GeminiClient {
  constructor({ ledger, quotaPersistence, configuration, urlFetchApp = globalThis.UrlFetchApp, propertiesService = globalThis.PropertiesService, now = () => new Date(), expectedOutputTokens = DEFAULT_EXPECTED_OUTPUT_TOKENS } = {}) {
    if (!ledger || typeof ledger.getPersistedClassification !== 'function' || typeof ledger.persistClassification !== 'function') {
      throw new TypeError('A ProcessedMessageLedger-compatible ledger is required.');
    }
    if (!quotaPersistence || typeof quotaPersistence.reserveBeforeOperation !== 'function' || typeof quotaPersistence.recordOperationUsage !== 'function' || typeof quotaPersistence.deferQuotaExceeded !== 'function') {
      throw new TypeError('A QuotaPersistenceAdapter-compatible quota persistence adapter is required.');
    }
    if (!configuration) throw new TypeError('A Gemini configuration object or provider is required.');
    if (!urlFetchApp || typeof urlFetchApp.fetch !== 'function') throw new TypeError('Apps Script UrlFetchApp is required.');
    this.ledger = ledger;
    this.quotaPersistence = quotaPersistence;
    this.configuration = configuration;
    this.urlFetchApp = urlFetchApp;
    this.propertiesService = propertiesService;
    this.now = now;
    this.expectedOutputTokens = asPositiveInteger(expectedOutputTokens, 'expectedOutputTokens');
  }

  readConfiguration() {
    return typeof this.configuration.readConfiguration === 'function'
      ? this.configuration.readConfiguration()
      : this.configuration;
  }

  classifyClaimedMessage(message, runId) {
    const messageId = asNonEmptyText(message?.gmail_message_id, 'gmail_message_id');
    const existing = this.ledger.getPersistedClassification(messageId);
    if (existing) return Object.freeze({ status: 'REUSED', classification: existing.classification, ledgerRecord: existing.record });

    const config = effectiveConfiguration(this.readConfiguration());
    const payload = createGeminiClassificationPayload(message, config.inputCharacterLimit);
    const request = createGeminiGenerateContentRequest(payload);
    const key = apiKey(this.propertiesService);
    const estimateOptions = { inputCharacters: request.contents[0].parts[0].text.length, expectedOutputTokens: this.expectedOutputTokens };
    const reservation = this.quotaPersistence.reserveBeforeOperation({
      runId, gmailMessageId: messageId, operation: QUOTA_OPERATION.GEMINI_REQUEST, estimateOptions, now: this.now()
    });
    if (!reservation.allowed) return Object.freeze({ status: 'DEFERRED', deferral: reservation.deferral });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:generateContent`;
    let response;
    try {
      response = this.urlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        headers: { 'x-goog-api-key': key }, payload: JSON.stringify(request), muteHttpExceptions: true
      });
    } catch (error) {
      this.quotaPersistence.recordOperationUsage({ reservation: reservation.reservation, now: this.now() });
      throw new GeminiClientError('GEMINI_NETWORK_FAILED', 'Gemini request failed before a response was received.', { retryable: true, cause: error });
    }

    const status = responseStatus(response);
    const body = responseBody(response);
    if (status === 429) {
      const deferral = this.quotaPersistence.deferQuotaExceeded({
        runId, gmailMessageId: messageId, operation: QUOTA_OPERATION.GEMINI_REQUEST,
        quotaName: QUOTA_NAME.GEMINI_RPM, estimate: reservation.estimate,
        reservation: reservation.reservation, now: this.now()
      });
      return Object.freeze({ status: 'DEFERRED', deferral });
    }
    this.quotaPersistence.recordOperationUsage({ reservation: reservation.reservation, now: this.now() });
    if (status < 200 || status >= 300) throw providerError(status, body);

    let providerPayload;
    try { providerPayload = JSON.parse(body); } catch (error) {
      throw new GeminiClientError('INVALID_RESPONSE', 'Gemini returned malformed HTTP response JSON.', { retryable: true, cause: error });
    }
    const classification = parseGeminiClassificationResponse(extractResponseText(providerPayload));
    const ledgerRecord = this.ledger.persistClassification(messageId, asNonEmptyText(runId, 'run_id'), classification);
    return Object.freeze({ status: 'CLASSIFIED', classification, ledgerRecord });
  }
}

export const GEMINI_CLIENT_DEFAULTS = Object.freeze({ DEFAULT_EXPECTED_OUTPUT_TOKENS });
