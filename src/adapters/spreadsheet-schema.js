import { CONFIGURATION_KEY, DEFAULT_CONFIGURATION, PROCESSING_CHECKPOINT_HEADERS, SHEET_HEADERS, SHEET_NAMES, SHEET_ORDER } from '../core/domain-constants.js';

function isoTimestamp(value) {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
}

function defaultCheckpointId() {
  if (typeof Utilities === 'undefined' || typeof Utilities.getUuid !== 'function') {
    throw new Error('A checkpoint ID generator is required outside Google Apps Script.');
  }
  return Utilities.getUuid();
}

function headersMatch(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function ensureSheet(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  const created = !sheet;
  if (created) sheet = spreadsheet.insertSheet(sheetName);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const actualHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (!headersMatch(actualHeaders, headers)) {
      throw new Error(`Sheet "${sheetName}" has a header row that does not match the fixed tracker schema.`);
    }
  }
  sheet.setFrozenRows(1);
  return { sheet, created };
}

function appendMissingDefaults(configurationSheet, timestamp) {
  const rowCount = configurationSheet.getLastRow();
  const rows = rowCount > 1 ? configurationSheet.getRange(2, 1, rowCount - 1, 2).getValues() : [];
  const configuredKeys = new Set(rows.map(([key]) => key));
  const defaults = Object.entries(DEFAULT_CONFIGURATION)
    .filter(([key]) => !configuredKeys.has(key))
    .map(([key, value]) => [key, String(value), timestamp]);
  if (defaults.length) configurationSheet.getRange(rowCount + 1, 1, defaults.length, 3).setValues(defaults);
  return defaults.map(([key]) => key);
}

function initializeCheckpoint(checkpointSheet, timestamp, createId) {
  if (checkpointSheet.getLastRow() > 1) return false;
  checkpointSheet.getRange(2, 1, 1, PROCESSING_CHECKPOINT_HEADERS.length)
    .setValues([[createId(), '', '', timestamp, '']]);
  return true;
}

/** Creates all operational tabs without overwriting a populated, incompatible schema. */
export function initializeSpreadsheetSchema(spreadsheet, options = {}) {
  if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function') {
    throw new TypeError('A Google Spreadsheet instance is required.');
  }
  const timestamp = isoTimestamp(options.now);
  const createId = options.createId ?? defaultCheckpointId;
  const sheets = {};
  const createdSheets = [];

  for (const name of SHEET_ORDER) {
    const result = ensureSheet(spreadsheet, name, SHEET_HEADERS[name]);
    sheets[name] = result.sheet;
    if (result.created) createdSheets.push(name);
  }

  const initializedConfigurationKeys = appendMissingDefaults(sheets[SHEET_NAMES.CONFIGURATION], timestamp);
  const checkpointCreated = initializeCheckpoint(sheets[SHEET_NAMES.PROCESSING_CHECKPOINT], timestamp, createId);
  return { sheets, createdSheets, initializedConfigurationKeys, checkpointCreated };
}

export const SPREADSHEET_SCHEMA = Object.freeze({ SHEET_HEADERS, SHEET_ORDER, CONFIGURATION_KEY, DEFAULT_CONFIGURATION });
