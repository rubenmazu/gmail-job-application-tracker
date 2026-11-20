import { CONFIGURATION_KEY, SHEET_NAMES } from '../core/domain-constants.js';

const KEY = CONFIGURATION_KEY;
const GEMINI_CONFIGURATION_KEYS = Object.freeze([
  KEY.GEMINI_MODEL_ID,
  KEY.GEMINI_MODEL_VERIFIED_AT,
  KEY.GEMINI_FREE_TIER_RPM,
  KEY.GEMINI_FREE_TIER_TPM,
  KEY.GEMINI_FREE_TIER_RPD,
  KEY.GEMINI_FREE_TIER_DAILY_RESET_REFERENCE
]);
const EXECUTION_QUOTA_KEYS = Object.freeze([
  KEY.EXECUTION_QUOTA_GMAIL_READS,
  KEY.EXECUTION_QUOTA_SHEET_WRITES,
  KEY.EXECUTION_QUOTA_RUNTIME_MINUTES,
  KEY.EXECUTION_QUOTA_VERIFIED_AT
]);
const POSITIVE_INTEGER_KEYS = new Set([
  KEY.SCHEDULE_INTERVAL_MINUTES,
  KEY.MAX_MESSAGES_PER_RUN,
  KEY.OVERLAP_MINUTES,
  KEY.GEMINI_FREE_TIER_RPM,
  KEY.GEMINI_FREE_TIER_TPM,
  KEY.GEMINI_FREE_TIER_RPD,
  KEY.GEMINI_INPUT_CHAR_LIMIT,
  KEY.EXECUTION_QUOTA_GMAIL_READS,
  KEY.EXECUTION_QUOTA_SHEET_WRITES,
  KEY.EXECUTION_QUOTA_RUNTIME_MINUTES,
  KEY.RETRY_INITIAL_BACKOFF_SECONDS,
  KEY.RETRY_MAX_BACKOFF_SECONDS
]);
const NON_NEGATIVE_INTEGER_KEYS = new Set([KEY.MAX_RETRIES_PER_RUN]);
const TIMESTAMP_KEYS = new Set([
  KEY.GEMINI_MODEL_VERIFIED_AT,
  KEY.EXECUTION_QUOTA_VERIFIED_AT,
  KEY.PRIVACY_ACKNOWLEDGED_AT,
  KEY.PRIVACY_WITHDRAWN_AT,
  KEY.CONFIG_UPDATED_AT
]);
const BOOLEAN_KEYS = new Set([KEY.GEMINI_ENABLED]);
const TEXT_KEYS = new Set([
  KEY.GEMINI_MODEL_ID,
  KEY.GEMINI_FREE_TIER_DAILY_RESET_REFERENCE,
  KEY.PRIVACY_NOTICE_VERSION,
  KEY.PRIVACY_ACKNOWLEDGED_BY
]);
const KNOWN_KEYS = new Set(Object.values(KEY));
const SECRET_KEY = /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Configuration field "${field}" must be a valid timestamp.`);
  return date.toISOString();
}

function normalizeInteger(value, field, minimum) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError(`Configuration field "${field}" must be an integer greater than or equal to ${minimum}.`);
  }
  return number;
}

function normalizeText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Configuration field "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`Configuration field "${field}" must be boolean.`);
}

function serialize(value) {
  return String(value);
}

function defaultCreateId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  throw new Error('A configuration audit ID generator is required outside Google Apps Script.');
}

function defaultNow() {
  return new Date().toISOString();
}

function requiredGroupIsComplete(configuration, keys, groupName) {
  const missing = keys.filter((key) => configuration[key] === undefined || configuration[key] === null || configuration[key] === '');
  if (missing.length) throw new Error(`${groupName} configuration requires: ${missing.join(', ')}.`);
}

/**
 * Validates administrative changes, persists Configuration values, and writes an
 * immutable audit entry for each effective key change. This service deliberately
 * has no Script Properties access: API keys never enter a spreadsheet or audit.
 */
export class ConfigurationService {
  constructor(repository, { now = defaultNow, createId = defaultCreateId, getAuthorizedUser } = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsertAll !== 'function') {
      throw new TypeError('A SheetsRepository with readTable and upsertAll is required.');
    }
    this.repository = repository;
    this.now = now;
    this.createId = createId;
    this.getAuthorizedUser = getAuthorizedUser;
  }

  readConfiguration() {
    const records = this.repository.readTable(SHEET_NAMES.CONFIGURATION).records;
    return Object.fromEntries(records.map(({ config_key: key, config_value: value }) => [key, value]));
  }

  saveConfiguration(changes, { updatedBy } = {}) {
    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw new TypeError('Configuration changes must be a non-empty plain object.');
    }
    const actor = this.resolveAuthorizedUser(updatedBy);
    const existing = this.readConfiguration();
    const normalizedChanges = this.normalizeChanges(changes);
    const effective = { ...existing, ...normalizedChanges };
    this.validateCoherentConfiguration(normalizedChanges, effective);

    const changedEntries = Object.entries(normalizedChanges)
      .filter(([key, value]) => existing[key] !== serialize(value));
    if (changedEntries.length === 0) {
      return { changed: false, version: null, updatedAt: null, changes: [] };
    }

    const updatedAt = normalizeTimestamp(this.now(), KEY.CONFIG_UPDATED_AT);
    const timestampChanged = existing[KEY.CONFIG_UPDATED_AT] !== updatedAt;
    const allChangedEntries = timestampChanged
      ? [...changedEntries, [KEY.CONFIG_UPDATED_AT, updatedAt]]
      : changedEntries;
    const auditRecords = this.repository.readTable(SHEET_NAMES.CONFIGURATION_AUDIT).records;
    const version = auditRecords.reduce((maximum, record) => Math.max(maximum, Number(record.version) || 0), 0) + 1;
    const configurationRecords = allChangedEntries.map(([configKey, value]) => ({
      config_key: configKey,
      config_value: serialize(value),
      updated_at: updatedAt
    }));
    const auditRows = allChangedEntries.map(([configKey, value]) => ({
      audit_id: this.createId(),
      config_key: configKey,
      previous_value: existing[configKey] ?? '',
      new_value: serialize(value),
      version,
      updated_by: actor,
      updated_at: updatedAt
    }));

    this.repository.upsertAll({
      [SHEET_NAMES.CONFIGURATION]: configurationRecords,
      [SHEET_NAMES.CONFIGURATION_AUDIT]: auditRows
    });
    return { changed: true, version, updatedAt, changes: allChangedEntries.map(([key]) => key) };
  }

  resolveAuthorizedUser(updatedBy) {
    const candidate = updatedBy ?? (typeof this.getAuthorizedUser === 'function' ? this.getAuthorizedUser() : undefined);
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error('An authorized administrative user identity is required to change configuration.');
    }
    return candidate.trim();
  }

  normalizeChanges(changes) {
    return Object.fromEntries(Object.entries(changes).map(([key, value]) => {
      if (!KNOWN_KEYS.has(key) || SECRET_KEY.test(key)) {
        throw new Error(`Configuration field "${key}" is not allowed.`);
      }
      if (key === KEY.CONFIG_UPDATED_AT) {
        throw new Error(`Configuration field "${key}" is managed by the service.`);
      }
      if (POSITIVE_INTEGER_KEYS.has(key)) return [key, normalizeInteger(value, key, 1)];
      if (NON_NEGATIVE_INTEGER_KEYS.has(key)) return [key, normalizeInteger(value, key, 0)];
      if (TIMESTAMP_KEYS.has(key)) return [key, normalizeTimestamp(value, key)];
      if (BOOLEAN_KEYS.has(key)) return [key, normalizeBoolean(value, key)];
      if (TEXT_KEYS.has(key)) return [key, normalizeText(value, key)];
      throw new Error(`Configuration field "${key}" has no validation rule.`);
    }));
  }

  validateCoherentConfiguration(changes, effective) {
    if (GEMINI_CONFIGURATION_KEYS.some((key) => Object.hasOwn(changes, key))) {
      requiredGroupIsComplete(effective, GEMINI_CONFIGURATION_KEYS, 'Gemini Free Tier');
    }
    if (EXECUTION_QUOTA_KEYS.some((key) => Object.hasOwn(changes, key))) {
      requiredGroupIsComplete(effective, EXECUTION_QUOTA_KEYS, 'Google execution quota');
    }
    if (Object.hasOwn(changes, KEY.RETRY_MAX_BACKOFF_SECONDS) || Object.hasOwn(changes, KEY.RETRY_INITIAL_BACKOFF_SECONDS)) {
      if (effective[KEY.RETRY_INITIAL_BACKOFF_SECONDS] === undefined || effective[KEY.RETRY_MAX_BACKOFF_SECONDS] === undefined) {
        throw new Error('Retry configuration requires both initial and maximum backoff values.');
      }
      if (Number(effective[KEY.RETRY_MAX_BACKOFF_SECONDS]) < Number(effective[KEY.RETRY_INITIAL_BACKOFF_SECONDS])) {
        throw new Error('Retry maximum backoff must be greater than or equal to initial backoff.');
      }
    }
  }
}

export const CONFIGURATION_SERVICE_METADATA = Object.freeze({
  GEMINI_CONFIGURATION_KEYS,
  EXECUTION_QUOTA_KEYS,
  KNOWN_KEYS: [...KNOWN_KEYS]
});


export const GEMINI_API_KEY_PROPERTY = 'GEMINI_API_KEY';

export const GEMINI_PRIVACY_NOTICE = Object.freeze({
  version: 'gemini-external-processing-v1',
  title: 'Gemini external processing acknowledgement',
  message: [
    'When Gemini processing is enabled, limited message content is sent to Gemini, an external processing service.',
    'Verify the privacy and data-use terms for the configured Gemini API tier against Google documentation before acknowledging.',
    'Availability on a Gemini API Free Tier does not, by itself, establish that submitted message content is private.'
  ].join(' '),
  links: Object.freeze([
    Object.freeze({ label: 'Gemini API billing', url: 'https://ai.google.dev/gemini-api/docs/billing' }),
    Object.freeze({ label: 'Gemini API rate limits', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }),
    Object.freeze({ label: 'Gemini API Additional Terms of Service', url: 'https://ai.google.dev/gemini-api/terms' })
  ])
});

const GEMINI_INPUT_TO_CONFIGURATION_KEY = Object.freeze({
  modelId: KEY.GEMINI_MODEL_ID,
  modelVerifiedAt: KEY.GEMINI_MODEL_VERIFIED_AT,
  freeTierRpm: KEY.GEMINI_FREE_TIER_RPM,
  freeTierTpm: KEY.GEMINI_FREE_TIER_TPM,
  freeTierRpd: KEY.GEMINI_FREE_TIER_RPD,
  dailyResetReference: KEY.GEMINI_FREE_TIER_DAILY_RESET_REFERENCE,
  inputCharLimit: KEY.GEMINI_INPUT_CHAR_LIMIT
});

function defaultScriptProperties() {
  if (typeof PropertiesService === 'undefined' || typeof PropertiesService.getScriptProperties !== 'function') {
    throw new Error('Google Apps Script PropertiesService is required to store the Gemini API key.');
  }
  return PropertiesService.getScriptProperties();
}

function defaultAuthorizedUser() {
  if (typeof Session === 'undefined' || typeof Session.getActiveUser !== 'function') {
    throw new Error('Google Apps Script Session is required to identify the authorized administrator.');
  }
  return Session.getActiveUser().getEmail();
}

function isEnabled(value) {
  return value === true || value === 'true';
}

function hasUsableApiKey(scriptProperties) {
  const key = scriptProperties?.getProperty?.(GEMINI_API_KEY_PROPERTY);
  return typeof key === 'string' && key.trim() !== '';
}

function acknowledgementIsCurrent(configuration) {
  const acknowledgedAt = configuration[KEY.PRIVACY_ACKNOWLEDGED_AT];
  if (!acknowledgedAt || configuration[KEY.PRIVACY_NOTICE_VERSION] !== GEMINI_PRIVACY_NOTICE.version) return false;
  const withdrawnAt = configuration[KEY.PRIVACY_WITHDRAWN_AT];
  return !withdrawnAt || new Date(acknowledgedAt).getTime() >= new Date(withdrawnAt).getTime();
}

/**
 * Returns the only authorization decision Gemini callers may use before sending
 * message content. A withdrawal always wins because it also sets gemini_enabled
 * to false, while the timestamp check protects against stale configuration.
 */
export function getGeminiSubmissionAuthorization(configuration, scriptProperties) {
  if (!configuration || typeof configuration !== 'object') {
    return Object.freeze({ allowed: false, reason: 'configuration_missing' });
  }
  if (!isEnabled(configuration[KEY.GEMINI_ENABLED])) {
    return Object.freeze({ allowed: false, reason: 'gemini_disabled' });
  }
  if (!acknowledgementIsCurrent(configuration)) {
    return Object.freeze({ allowed: false, reason: 'acknowledgement_missing_or_withdrawn' });
  }
  if (!hasUsableApiKey(scriptProperties)) {
    return Object.freeze({ allowed: false, reason: 'api_key_missing' });
  }
  return Object.freeze({ allowed: true, reason: null });
}

export function assertGeminiSubmissionAuthorized(configuration, scriptProperties) {
  const authorization = getGeminiSubmissionAuthorization(configuration, scriptProperties);
  if (!authorization.allowed) {
    throw new Error(`Gemini message submission is blocked: ${authorization.reason}.`);
  }
  return authorization;
}

function buildGeminiConfigurationChanges(input) {
  if (!isPlainObject(input)) throw new TypeError('Gemini configuration must be a plain object.');
  const permitted = new Set([...Object.keys(GEMINI_INPUT_TO_CONFIGURATION_KEY), 'apiKey']);
  for (const key of Object.keys(input)) {
    if (!permitted.has(key)) throw new Error(`Gemini configuration field "${key}" is not allowed.`);
  }
  return Object.fromEntries(Object.entries(GEMINI_INPUT_TO_CONFIGURATION_KEY)
    .filter(([inputKey]) => input[inputKey] !== undefined)
    .map(([inputKey, configurationKey]) => [configurationKey, input[inputKey]]));
}

/**
 * Administrative boundary for Gemini configuration and acknowledgement. It is
 * deliberately separate from ConfigurationService so the API secret can only
 * be read/written through Script Properties and never reaches Sheets or audit.
 */
export class GeminiConfigurationAdministration {
  constructor(configurationService, {
    scriptProperties = defaultScriptProperties(),
    now = defaultNow,
    getAuthorizedUser = defaultAuthorizedUser
  } = {}) {
    if (!(configurationService instanceof ConfigurationService)) {
      throw new TypeError('A ConfigurationService is required for Gemini administration.');
    }
    if (!scriptProperties || typeof scriptProperties.getProperty !== 'function' || typeof scriptProperties.setProperty !== 'function') {
      throw new TypeError('Script Properties with getProperty and setProperty are required.');
    }
    this.configurationService = configurationService;
    this.scriptProperties = scriptProperties;
    this.now = now;
    this.getAuthorizedUser = getAuthorizedUser;
  }

  getPrivacyNotice() {
    return GEMINI_PRIVACY_NOTICE;
  }

  saveGeminiConfiguration(input, { updatedBy } = {}) {
    const changes = buildGeminiConfigurationChanges(input);
    const apiKeyProvided = Object.hasOwn(input, 'apiKey');
    if (apiKeyProvided) normalizeText(input.apiKey, 'apiKey');
    if (!apiKeyProvided && !hasUsableApiKey(this.scriptProperties)) {
      throw new Error('A Gemini API key is required and is stored only in Script Properties.');
    }
    if (Object.keys(changes).length === 0 && !apiKeyProvided) {
      throw new TypeError('Provide at least one Gemini configuration value or an API key.');
    }

    const configurationResult = Object.keys(changes).length
      ? this.configurationService.saveConfiguration(changes, { updatedBy })
      : { changed: false, version: null, updatedAt: null, changes: [] };
    if (apiKeyProvided) this.scriptProperties.setProperty(GEMINI_API_KEY_PROPERTY, input.apiKey.trim());

    return Object.freeze({
      ...configurationResult,
      apiKeyStored: apiKeyProvided,
      authorization: getGeminiSubmissionAuthorization(this.configurationService.readConfiguration(), this.scriptProperties)
    });
  }

  recordAcknowledgement({ noticeVersion } = {}, { updatedBy } = {}) {
    if (noticeVersion !== GEMINI_PRIVACY_NOTICE.version) {
      throw new Error(`Acknowledgement requires notice version "${GEMINI_PRIVACY_NOTICE.version}".`);
    }
    if (!hasUsableApiKey(this.scriptProperties)) {
      throw new Error('Gemini cannot be enabled until a Gemini API key exists in Script Properties.');
    }
    requiredGroupIsComplete(
      this.configurationService.readConfiguration(),
      GEMINI_CONFIGURATION_KEYS,
      'Gemini Free Tier'
    );
    const acknowledgedAt = normalizeTimestamp(this.now(), KEY.PRIVACY_ACKNOWLEDGED_AT);
    const acknowledgedBy = this.configurationService.resolveAuthorizedUser(updatedBy ?? this.getAuthorizedUser());
    const result = this.configurationService.saveConfiguration({
      [KEY.PRIVACY_NOTICE_VERSION]: GEMINI_PRIVACY_NOTICE.version,
      [KEY.PRIVACY_ACKNOWLEDGED_AT]: acknowledgedAt,
      [KEY.PRIVACY_ACKNOWLEDGED_BY]: acknowledgedBy,
      [KEY.GEMINI_ENABLED]: true
    }, { updatedBy: acknowledgedBy });
    return Object.freeze({ ...result, noticeVersion: GEMINI_PRIVACY_NOTICE.version, acknowledgedAt, acknowledgedBy });
  }

  withdrawAcknowledgement({ updatedBy } = {}) {
    const withdrawnAt = normalizeTimestamp(this.now(), KEY.PRIVACY_WITHDRAWN_AT);
    const result = this.configurationService.saveConfiguration({
      [KEY.GEMINI_ENABLED]: false,
      [KEY.PRIVACY_WITHDRAWN_AT]: withdrawnAt
    }, { updatedBy });
    return Object.freeze({ ...result, withdrawnAt, authorization: getGeminiSubmissionAuthorization(this.configurationService.readConfiguration(), this.scriptProperties) });
  }
}

/** Creates the production administration service while preserving injectability for tests. */
export function createAppsScriptGeminiAdministration(repository, options = {}) {
  const configurationService = new ConfigurationService(repository, {
    now: options.now,
    createId: options.createId,
    getAuthorizedUser: options.getAuthorizedUser ?? defaultAuthorizedUser
  });
  return new GeminiConfigurationAdministration(configurationService, {
    scriptProperties: options.scriptProperties ?? defaultScriptProperties(),
    now: options.now,
    getAuthorizedUser: options.getAuthorizedUser ?? defaultAuthorizedUser
  });
}
