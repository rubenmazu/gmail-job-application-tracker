import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, PROCESSED_MESSAGE_STATE, SHEET_NAMES } from '../src/core/domain-constants.js';
import { ProcessedMessageLedger } from '../src/core/processed-message-ledger.js';
import { GmailIncrementalReader, IncrementalProcessingScheduler } from '../src/services/gmail-incremental-reader.js';
import { ScheduledProcessingCoordinator } from '../src/services/scheduled-processing-coordinator.js';

class Clock {
  constructor(timestamp = '2025-02-03T10:00:00.000Z') { this.time = new Date(timestamp); }
  now = () => new Date(this.time);
  advance(milliseconds) { this.time = new Date(this.time.getTime() + milliseconds); }
}

class SheetsMock {
  constructor(recordsBySheet = {}) {
    this.recordsBySheet = Object.fromEntries(Object.entries(recordsBySheet)
      .map(([sheet, records]) => [sheet, records.map((record) => ({ ...record }))]));
    this.writes = [];
  }

  readTable(sheet) {
    const records = this.recordsBySheet[sheet] ?? [];
    const gmailIndex = new Map();
    for (const record of records) {
      if (record.gmail_message_id) gmailIndex.set(String(record.gmail_message_id), [record]);
    }
    return { records, indexes: { gmail_message_id: gmailIndex } };
  }

  upsert(sheet, patches) {
    const records = this.recordsBySheet[sheet] ?? (this.recordsBySheet[sheet] = []);
    const key = sheet === SHEET_NAMES.PROCESSING_CHECKPOINT ? 'checkpoint_id' : 'gmail_message_id';
    for (const patch of patches) {
      const index = records.findIndex((record) => String(record[key]) === String(patch[key]));
      if (index < 0) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
    this.writes.push({ sheet, patches: patches.map((patch) => ({ ...patch })) });
    return { records };
  }

  appendProcessingFailure() {}
  appendRelationshipException() {}
}

function gmailMessage(id, receivedAt, threadId = `thread-${id}`) {
  const thread = { getId: () => threadId };
  return {
    getId: () => id, getThread: () => thread, getDate: () => new Date(receivedAt),
    getSubject: () => 'Application update', getFrom: () => 'recruiter@example.test', getPlainBody: () => 'Redacted fixture body'
  };
}

function gmailMock(messages) {
  return {
    searches: [],
    search(query, start) {
      this.searches.push({ query, start });
      return start === 0 ? [{ getId: () => 'thread', getMessages: () => messages }] : [];
    }
  };
}

function ledgerLock() { return { execute: (operation) => operation() }; }

function quotaMock() {
  return {
    reserveBeforeOperation: ({ operation }) => ({ allowed: true, reservation: { operation } }),
    recordOperationUsage() {}, defer() {}
  };
}

function coordinatorDependencies({ repository, scheduler, ledger, gemini, clock }) {
  const lock = { tryLock: () => true, releaseLock() {} };
  return new ScheduledProcessingCoordinator({
    repository, scheduler, ledger, gemini,
    domain: { apply() { throw new Error('Irrelevant messages do not enter the domain.'); } },
    reporting: { rebuildAndUpsert() {} }, quotaPersistence: quotaMock(),
    lockService: { getScriptLock: () => lock }, now: clock.now, createId: () => 'run-1', runtimeSafetyMarginMs: 1
  });
}

describe('incremental processing recovery', () => {
  it('writes the Sheets-backed claim before submitting the Gmail message to Gemini', () => {
    const clock = new Clock();
    const repository = new SheetsMock({ [SHEET_NAMES.CONFIGURATION]: [], [SHEET_NAMES.PROCESSED_MESSAGES]: [], [SHEET_NAMES.PROCESSING_CHECKPOINT]: [] });
    const gmail = gmailMock([gmailMessage('message-1', '2025-02-03T09:00:00.000Z')]);
    const scheduler = new IncrementalProcessingScheduler(repository, new GmailIncrementalReader(gmail), { now: clock.now, createId: () => 'checkpoint-1' });
    const ledger = new ProcessedMessageLedger(repository, { lock: ledgerLock(), now: clock.now, leaseDurationMs: 60_000 });
    let recordAtSubmit;
    const coordinator = coordinatorDependencies({
      repository, scheduler, ledger, clock,
      gemini: {
        classifyClaimedMessage(message) {
          recordAtSubmit = repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).indexes.gmail_message_id.get(message.gmail_message_id)[0];
          return { status: 'CLASSIFIED', classification: { classification: CLASSIFICATION.IRRELEVANT } };
        }
      }
    });

    expect(coordinator.runScheduledProcessing()).toMatchObject({ status: 'COMPLETED', completed: 1 });
    expect(gmail.searches).toHaveLength(1);
    expect(recordAtSubmit).toMatchObject({ gmail_message_id: 'message-1', run_id: 'run-1', state: PROCESSED_MESSAGE_STATE.IN_PROGRESS, attempt_count: 1 });
    expect(new Date(recordAtSubmit.lease_expires_at).getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('reclaims an expired lease with a new attempt rather than leaving it blocked', () => {
    const clock = new Clock();
    const repository = new SheetsMock({
      [SHEET_NAMES.PROCESSED_MESSAGES]: [{
        gmail_message_id: 'message-lease', gmail_thread_id: 'thread-lease', received_at: '2025-02-03T09:00:00.000Z',
        run_id: 'abandoned-run', state: PROCESSED_MESSAGE_STATE.IN_PROGRESS,
        lease_expires_at: '2025-02-03T09:59:59.999Z', attempt_count: 1, next_attempt_at: null
      }]
    });
    const ledger = new ProcessedMessageLedger(repository, { lock: ledgerLock(), now: clock.now, leaseDurationMs: 60_000 });

    const claim = ledger.claim({ gmail_message_id: 'message-lease', gmail_thread_id: 'thread-lease', received_at: '2025-02-03T09:00:00.000Z' }, 'recovery-run');

    expect(claim).toMatchObject({ claimed: true, shouldClassify: true, record: { run_id: 'recovery-run', state: PROCESSED_MESSAGE_STATE.IN_PROGRESS, attempt_count: 2 } });
    expect(new Date(claim.record.lease_expires_at).getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it('keeps a retryable failure non-terminal and allows its retry when the mock clock reaches next_attempt_at', () => {
    const clock = new Clock();
    const repository = new SheetsMock({ [SHEET_NAMES.PROCESSED_MESSAGES]: [] });
    const ledger = new ProcessedMessageLedger(repository, { lock: ledgerLock(), now: clock.now, leaseDurationMs: 60_000 });
    const message = { gmail_message_id: 'message-retry', gmail_thread_id: 'thread-retry', received_at: '2025-02-03T09:00:00.000Z' };
    ledger.claim(message, 'run-1');
    const retryAt = new Date(clock.now().getTime() + 30_000);
    ledger.markRetryableFailure(message.gmail_message_id, 'run-1', retryAt);

    expect(repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records[0]).toMatchObject({
      state: PROCESSED_MESSAGE_STATE.RETRYABLE_FAILURE, lease_expires_at: null, next_attempt_at: retryAt.toISOString()
    });
    clock.advance(30_000);
    expect(ledger.claim(message, 'run-2')).toMatchObject({ claimed: true, record: { run_id: 'run-2', attempt_count: 2 } });
  });

  it('persists a contiguous checkpoint only through the first incomplete Gmail message', () => {
    const clock = new Clock();
    const first = gmailMessage('message-1', '2025-02-03T09:00:00.000Z');
    const incomplete = gmailMessage('message-2', '2025-02-03T09:01:00.000Z');
    const laterTerminal = gmailMessage('message-3', '2025-02-03T09:02:00.000Z');
    const repository = new SheetsMock({
      [SHEET_NAMES.CONFIGURATION]: [], [SHEET_NAMES.PROCESSING_CHECKPOINT]: [],
      [SHEET_NAMES.PROCESSED_MESSAGES]: [
        { gmail_message_id: 'message-1', state: PROCESSED_MESSAGE_STATE.COMPLETED },
        { gmail_message_id: 'message-2', state: PROCESSED_MESSAGE_STATE.RETRYABLE_FAILURE },
        { gmail_message_id: 'message-3', state: PROCESSED_MESSAGE_STATE.COMPLETED }
      ]
    });
    const scheduler = new IncrementalProcessingScheduler(repository, new GmailIncrementalReader(gmailMock([first, incomplete, laterTerminal])), { now: clock.now, createId: () => 'checkpoint-1' });

    const plan = scheduler.plan();
    const result = scheduler.advanceCheckpoint(plan, 'run-1');

    expect(result).toMatchObject({ advanced: true, checkpoint: { checkpoint_id: 'checkpoint-1', last_completed_message_id: 'message-1', last_completed_received_at: '2025-02-03T09:00:00.000Z', last_run_id: 'run-1' } });
    expect(repository.readTable(SHEET_NAMES.PROCESSING_CHECKPOINT).records).toHaveLength(1);
    expect(repository.readTable(SHEET_NAMES.PROCESSING_CHECKPOINT).records[0].last_completed_message_id).toBe('message-1');
  });
});