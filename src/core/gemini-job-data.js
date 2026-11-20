import { CLASSIFICATION, UNAVAILABLE } from './domain-constants.js';

const GEMINI_JOB_DATA_FIELDS = Object.freeze([
  ['role', 'role'],
  ['company', 'company'],
  ['applicationDate', 'application_date'],
  ['platform', 'platform'],
  ['location', 'location']
]);

const RELEVANT_CLASSIFICATIONS = new Set([
  CLASSIFICATION.APPLICATION_CONFIRMATION,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.OFFER
]);

function isMissingDisplayValue(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'string' && value.trim() === '');
}

function normalizeDisplayValue(value, field) {
  if (isMissingDisplayValue(value)) return UNAVAILABLE;
  if (typeof value !== 'string') {
    throw new TypeError(`Gemini field "${field}" must be a string, null, or undefined.`);
  }

  return value;
}

/**
 * Converts a validated Gemini structured result into the display fields stored
 * by an application. Non-empty values, including platform spelling/casing, are
 * returned verbatim; missing values are displayed as `Unavailable`.
 */
export function normalizeGeminiJobData(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('A Gemini structured result object is required.');
  }

  return Object.freeze(Object.fromEntries(GEMINI_JOB_DATA_FIELDS.map(([geminiField, applicationField]) => [
    applicationField,
    normalizeDisplayValue(result[geminiField], geminiField)
  ])));
}

/**
 * Creates the pure domain-facing outcome of a validated Gemini result. An
 * irrelevant message intentionally exposes no structured data and instructs
 * later domain code not to create or change applications or status history.
 */
export function extractGeminiDomainEffect(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('A Gemini structured result object is required.');
  }

  if (result.classification === CLASSIFICATION.IRRELEVANT) {
    return Object.freeze({
      classification: CLASSIFICATION.IRRELEVANT,
      shouldMutateDomain: false,
      structuredJobData: null
    });
  }

  if (!RELEVANT_CLASSIFICATIONS.has(result.classification)) {
    throw new TypeError(`Unsupported Gemini classification "${result.classification}".`);
  }

  return Object.freeze({
    classification: result.classification,
    shouldMutateDomain: true,
    structuredJobData: normalizeGeminiJobData(result)
  });
}

export const GEMINI_JOB_DATA_METADATA = Object.freeze({
  displayFields: GEMINI_JOB_DATA_FIELDS.map(([geminiField]) => geminiField),
  applicationFields: GEMINI_JOB_DATA_FIELDS.map(([, applicationField]) => applicationField)
});
