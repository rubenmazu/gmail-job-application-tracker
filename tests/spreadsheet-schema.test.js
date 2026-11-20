import { describe, expect, it } from 'vitest';
import { initializeSpreadsheetSchema } from '../src/adapters/spreadsheet-schema.js';
import { SheetsRepository } from '../src/adapters/sheets-repository.js';
import {
  CONFIGURATION_KEY,
  DEFAULT_CONFIGURATION,
  PROCESSING_CHECKPOINT_HEADERS,
  SHEET_HEADERS,
  SHEET_NAMES,
  SHEET_ORDER
} from '../src/core/domain-constants.js';

class MemoryRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) => Array.from(
      { length: this.columnCount },
      (_, columnOffset) => this.sheet.cells[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
    ));
  }

  getDisplayValues() {
    return this.getValues().map((row) => row.map((value) => String(value ?? '')));
  }

  setValues(values) {
    values.forEach((valuesRow, rowOffset) => valuesRow.forEach((value, columnOffset) => {
      const targetRow = this.row - 1 + rowOffset;
      const targetColumn = this.column - 1 + columnOffset;
      this.sheet.cells[targetRow] ??= [];
      this.sheet.cells[targetRow][targetColumn] = value;
    }));
    return this;
  }

  setNumberFormat(format) {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        const targetRow = this.row - 1 + rowOffset;
        const targetColumn = this.column - 1 + columnOffset;
        this.sheet.numberFormats[targetRow] ??= [];
        this.sheet.numberFormats[targetRow][targetColumn] = format;
      }
    }
    return this;
  }
}

class MemorySheet {
  constructor(name) {
    this.name = name;
    this.cells = [];
    this.numberFormats = [];
    this.frozenRows = 0;
    this.maxRows = 100;
  }

  getLastRow() {
    for (let row = this.cells.length - 1; row >= 0; row -= 1) {
      if ((this.cells[row] ?? []).some((value) => value !== '' && value !== undefined && value !== null)) return row + 1;
    }
    return 0;
  }

  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new MemoryRange(this, row, column, rowCount, columnCount);
  }

  setFrozenRows(count) {
    this.frozenRows = count;
  }

  getMaxRows() {
    return this.maxRows;
  }

  insertRowsAfter(afterPosition, howMany) {
    this.maxRows = Math.max(this.maxRows, afterPosition) + howMany;
  }
}

class MemorySpreadsheet {
  constructor() {
    this.sheets = new Map();
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name) {
    const sheet = new MemorySheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

describe('spreadsheet schema initialization', () => {
  it('is repeatable without duplicating tabs, defaults, or the checkpoint', () => {
    const spreadsheet = new MemorySpreadsheet();
    const timestamp = '2025-02-03T10:00:00.000Z';
    const first = initializeSpreadsheetSchema(spreadsheet, { now: timestamp, createId: () => 'checkpoint-1' });
    const second = initializeSpreadsheetSchema(spreadsheet, { now: '2025-02-04T10:00:00.000Z', createId: () => 'checkpoint-2' });

    expect(first.createdSheets).toEqual(SHEET_ORDER);
    expect(first.initializedConfigurationKeys).toEqual(Object.keys(DEFAULT_CONFIGURATION));
    expect(first.checkpointCreated).toBe(true);
    expect(second).toMatchObject({ createdSheets: [], initializedConfigurationKeys: [], checkpointCreated: false });
    expect(spreadsheet.sheets.size).toBe(SHEET_ORDER.length);

    const configurationRows = spreadsheet.getSheetByName(SHEET_NAMES.CONFIGURATION).getRange(2, 1, 2, 3).getValues();
    expect(configurationRows).toEqual([
      [CONFIGURATION_KEY.SCHEDULE_INTERVAL_MINUTES, '60', timestamp],
      [CONFIGURATION_KEY.OVERLAP_MINUTES, '120', timestamp]
    ]);
    expect(spreadsheet.getSheetByName(SHEET_NAMES.PROCESSING_CHECKPOINT)
      .getRange(2, 1, 1, PROCESSING_CHECKPOINT_HEADERS.length).getValues()[0])
      .toEqual(['checkpoint-1', '', '', timestamp, '']);
  });

  it('creates every operational tab with its fixed header row', () => {
    const spreadsheet = new MemorySpreadsheet();
    initializeSpreadsheetSchema(spreadsheet, { now: '2025-02-03T10:00:00.000Z', createId: () => 'checkpoint-1' });

    for (const sheetName of SHEET_ORDER) {
      const sheet = spreadsheet.getSheetByName(sheetName);
      expect(sheet).not.toBeNull();
      expect(sheet.getRange(1, 1, 1, SHEET_HEADERS[sheetName].length).getValues()[0]).toEqual(SHEET_HEADERS[sheetName]);
      expect(sheet.frozenRows).toBe(1);
    }
  });

  it('serializes Gmail identifiers as text and timestamps as ISO UTC without precision loss', () => {
    const spreadsheet = new MemorySpreadsheet();
    initializeSpreadsheetSchema(spreadsheet, { now: '2025-02-03T10:00:00.000Z', createId: () => 'checkpoint-1' });
    const repository = new SheetsRepository(spreadsheet);
    const gmailMessageId = '00123456789012345678901234567890';
    const gmailThreadId = '00098765432109876543210987654321';
    const receivedAt = new Date('2025-02-03T10:11:12.345Z');

    const result = repository.upsert(SHEET_NAMES.PROCESSED_MESSAGES, [{
      gmail_message_id: gmailMessageId,
      gmail_thread_id: gmailThreadId,
      received_at: receivedAt,
      run_id: 'run-1',
      state: 'IN_PROGRESS'
    }]);
    const sheet = spreadsheet.getSheetByName(SHEET_NAMES.PROCESSED_MESSAGES);
    const headers = SHEET_HEADERS[SHEET_NAMES.PROCESSED_MESSAGES];
    const row = sheet.getRange(2, 1, 1, headers.length).getValues()[0];

    expect(result.records[0]).toMatchObject({
      gmail_message_id: gmailMessageId,
      gmail_thread_id: gmailThreadId,
      received_at: '2025-02-03T10:11:12.345Z'
    });
    expect(row[headers.indexOf('gmail_message_id')]).toBe(gmailMessageId);
    expect(row[headers.indexOf('gmail_thread_id')]).toBe(gmailThreadId);
    expect(row[headers.indexOf('received_at')]).toBe('2025-02-03T10:11:12.345Z');
    expect(sheet.numberFormats[1][headers.indexOf('gmail_message_id')]).toBe('@');
    expect(sheet.numberFormats[1][headers.indexOf('gmail_thread_id')]).toBe('@');
    expect(repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records[0]).toMatchObject({
      gmail_message_id: gmailMessageId,
      gmail_thread_id: gmailThreadId,
      received_at: '2025-02-03T10:11:12.345Z'
    });
  });
});
