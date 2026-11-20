import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CONFIGURATION_KEY,
  PROCESSED_MESSAGE_STATE,
  SHEET_NAMES
} from '../src/core/domain-constants.js';
import { IncrementalProcessingScheduler } from '../src/services/gmail-incremental-reader.js';

const BASE_TIME = Date.parse('2025-02-03T10:00:00.000Z');
const TERMINAL_STATES = new Set([
  PROCESSED_MESSAGE_STATE.COMPLETED,
  PROCESSED_MESSAGE_STATE.UNRESOLVED
]);
const LEDGER_STATES = Object.values(PROCESSED_MESSAGE_STATE);

function asMessage(entry) {
  return {
    gmail_message_id: `message-${entry.id}`,
    gmail_thread_id: `thread-${entry.id}`,
    received_at: new Date(BASE_TIME + entry.relativeMinutes * 60_000).toISOString()
  };
}

function asCheckpoint(entry) {
  if (entry == null) return null;
  return {
    checkpoint_id: 'checkpoint-1',
    last_completed_received_at: new Date(BASE_TIME + entry.relativeMinutes * 60_000).toISOString(),
    last_completed_message_id: `message-${entry.id}`
  };
}

function messageComparator(left, right) {
  const timeDifference = Date.parse(left.received_at) - Date.parse(right.received_at);
  return timeDifference || (left.gmail_message_id < right.gmail_message_id ? -1 : left.gmail_message_id > right.gmail_message_id ? 1 : 0);
}

function referenceCandidates(messages, checkpoint, ledgerRecords) {
  const messagesById = new Map();
  for (const message of messages) {
    const existing = messagesById.get(message.gmail_message_id);
    if (!existing || messageComparator(message, existing) < 0) messagesById.set(message.gmail_message_id, message);
  }
  const ledgerById = new Map(ledgerRecords.map((record) => [record.gmail_message_id, record]));
  const watermark = checkpoint && {
    received_at: checkpoint.last_completed_received_at,
    gmail_message_id: checkpoint.last_completed_message_id
  };

  return [...messagesById.values()]
    .sort(messageComparator)
    .filter((message) => {
      const record = ledgerById.get(message.gmail_message_id);
      if (record && TERMINAL_STATES.has(record.state)) return false;
      return record || !watermark || messageComparator(message, watermark) > 0;
    });
}

function createRepository({ checkpoint, ledgerRecords, overlapMinutes }) {
  const recordsBySheet = new Map([
    [SHEET_NAMES.PROCESSING_CHECKPOINT, checkpoint ? [checkpoint] : []],
    [SHEET_NAMES.PROCESSED_MESSAGES, ledgerRecords],
    [SHEET_NAMES.CONFIGURATION, [{
      config_key: CONFIGURATION_KEY.OVERLAP_MINUTES,
      config_value: overlapMinutes
    }]]
  ]);
  return {
    readTable(sheetName) { return { records: recordsBySheet.get(sheetName) ?? [] }; },
    upsert() { throw new Error('Planning must not mutate repository state.'); }
  };
}

const scenarioArbitrary = fc.record({
  // Deliberately unsorted input with duplicate IDs and timestamps around the watermark.
  messages: fc.array(fc.record({
    id: fc.integer({ min: 0, max: 12 }),
    relativeMinutes: fc.integer({ min: -5, max: 5 })
  }), { maxLength: 40 }),
  ledger: fc.array(fc.record({
    id: fc.integer({ min: 0, max: 12 }),
    state: fc.constantFrom(...LEDGER_STATES)
  }), { maxLength: 40 }),
  checkpoint: fc.option(fc.record({
    id: fc.integer({ min: 0, max: 12 }),
    relativeMinutes: fc.integer({ min: -5, max: 5 })
  }), { nil: null }),
  overlapMinutes: fc.integer({ min: 0, max: 240 })
});

describe('IncrementalProcessingScheduler property tests', () => {
  // Feature: gmail-job-application-tracker, Property 2: Incremental selection processes each eligible message once
  // Validates: Requirements 2.1, 2.3, 2.4, 6.4
  it('plans every eligible nonterminal message exactly once and excludes terminal ledger IDs', () => {
    fc.assert(fc.property(scenarioArbitrary, (scenario) => {
      const messages = scenario.messages.map(asMessage);
      const checkpoint = asCheckpoint(scenario.checkpoint);
      const ledgerRecords = scenario.ledger.map((record) => ({
        gmail_message_id: `message-${record.id}`,
        state: record.state
      }));
      const repository = createRepository({ checkpoint, ledgerRecords, overlapMinutes: scenario.overlapMinutes });
      const readerCalls = [];
      const scheduler = new IncrementalProcessingScheduler(repository, {
        readMessages(options) {
          readerCalls.push(options);
          return messages;
        }
      }, { createId: () => 'checkpoint-1' });

      const plan = scheduler.plan();
      const expected = referenceCandidates(messages, checkpoint, ledgerRecords);
      const candidateIds = plan.candidates.map(({ gmail_message_id }) => gmail_message_id);

      expect(readerCalls).toEqual([{
        watermark: checkpoint?.last_completed_received_at ?? null,
        overlapMinutes: scenario.overlapMinutes
      }]);
      const effectiveLedger = new Map(ledgerRecords.map((record) => [record.gmail_message_id, record]));

      expect(plan.candidates).toEqual(expected);
      expect(new Set(candidateIds).size).toBe(candidateIds.length);
      for (const record of effectiveLedger.values()) {
        if (TERMINAL_STATES.has(record.state)) expect(candidateIds).not.toContain(record.gmail_message_id);
      }
    }), { numRuns: 100 });
  });
});
