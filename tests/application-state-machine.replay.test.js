import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApplicationStateMachine } from '../src/core/application-state-machine.js';
import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  PROCESSED_MESSAGE_STATE,
  SHEET_NAMES
} from '../src/core/domain-constants.js';
import { ProcessedMessageLedger } from '../src/core/processed-message-ledger.js';

const PRIMARY_KEYS = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key',
  [SHEET_NAMES.PROCESSED_MESSAGES]: 'gmail_message_id'
});
const COMMIT_STEPS = Object.freeze([
  'claim', 'classification', 'application', 'history', 'completion'
]);
const STARTED_AT = new Date('2025-02-03T10:00:00.000Z');

/** In-memory Sheets double that commits the mutation, then can simulate a crash. */
class InterruptingRepository {
  constructor(recordsBySheet, interruptAfterCommit = null) {
    this.recordsBySheet = Object.fromEntries(Object.entries(recordsBySheet)
      .map(([sheet, records]) => [sheet, records.map((record) => ({ ...record }))]));
    this.interruptAfterCommit = interruptAfterCommit;
    this.commitCount = 0;
    this.interrupted = false;
  }

  readTable(sheetName) {
    const records = this.recordsBySheet[sheetName] ?? [];
    const gmailMessageIndex = new Map();
    for (const record of records) {
      if (record.gmail_message_id) gmailMessageIndex.set(String(record.gmail_message_id), [record]);
    }
    return { records, indexes: { gmail_message_id: gmailMessageIndex } };
  }

  upsert(sheetName, patches) {
    const key = PRIMARY_KEYS[sheetName];
    const records = this.recordsBySheet[sheetName] ?? (this.recordsBySheet[sheetName] = []);
    for (const patch of patches) {
      const index = records.findIndex((record) => String(record[key]) === String(patch[key]));
      if (index === -1) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
    this.commitCount += 1;
    if (!this.interrupted && this.commitCount === this.interruptAfterCommit) {
      this.interrupted = true;
      throw Object.assign(new Error(`Interrupted after ${COMMIT_STEPS[this.commitCount - 1]} commit.`), {
        code: 'SIMULATED_COMMIT_INTERRUPTION'
      });
    }
    return { records };
  }
}

function initialRecords(message) {
  if (message.classification === CLASSIFICATION.APPLICATION_CONFIRMATION) {
    return {
      [SHEET_NAMES.APPLICATIONS]: [],
      [SHEET_NAMES.STATUS_HISTORY]: [],
      [SHEET_NAMES.PROCESSED_MESSAGES]: []
    };
  }

  const applicationId = `application-${message.gmail_message_id}`;
  return {
    [SHEET_NAMES.APPLICATIONS]: [{
      application_id: applicationId,
      initial_message_id: `initial-${message.gmail_message_id}`,
      initial_thread_id: message.gmail_thread_id,
      current_status: APPLICATION_STATUS.APPLIED,
      role: message.role,
      company: message.company,
      application_date: message.applicationDate,
      platform: message.platform,
      location: message.location,
      applied_at: '2025-01-01T09:00:00.000Z',
      first_response_at: null,
      interview_at: null,
      rejected_at: null,
      offer_at: null,
      last_status_changed_at: '2025-01-01T09:00:00.000Z',
      created_at: '2025-01-01T09:00:00.000Z',
      updated_at: '2025-01-01T09:00:00.000Z',
      last_message_id: `initial-${message.gmail_message_id}`
    }],
    [SHEET_NAMES.STATUS_HISTORY]: [{
      history_id: `history-initial-${message.gmail_message_id}`,
      event_key: `status:initial-${message.gmail_message_id}:Applied`,
      application_id: applicationId,
      source_message_id: `initial-${message.gmail_message_id}`,
      previous_status: null,
      new_status: APPLICATION_STATUS.APPLIED,
      classification: CLASSIFICATION.APPLICATION_CONFIRMATION,
      changed_at: '2025-01-01T09:00:00.000Z',
      run_id: 'initial-run'
    }],
    [SHEET_NAMES.PROCESSED_MESSAGES]: []
  };
}

function domainSnapshot(repository) {
  const applications = repository.readTable(SHEET_NAMES.APPLICATIONS).records
    .map((record) => ({ ...record })).sort((left, right) => left.application_id.localeCompare(right.application_id));
  const history = repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
  return {
    applications,
    applicationCount: applications.length,
    historyEventKeys: history.map(({ event_key }) => event_key).sort(),
    historyCount: history.length
  };
}

function runReplayScenario(message, interruptAfterCommit, replayCount) {
  const repository = new InterruptingRepository(initialRecords(message), interruptAfterCommit);
  let now = new Date(STARTED_AT);
  const ledger = new ProcessedMessageLedger(repository, {
    lock: (operation) => operation(),
    now: () => now,
    leaseDurationMs: 60_000,
    hashClassification: () => 'classification-hash'
  });
  const domain = new ApplicationStateMachine(repository, {
    now: () => now,
    createId: () => `persistent-${message.gmail_message_id}`
  });
  const classified = {
    classification: message.classification,
    role: message.role,
    company: message.company,
    applicationDate: message.applicationDate,
    platform: message.platform,
    location: message.location
  };
  let classificationSubmissions = 0;

  const submit = (runId) => {
    const claim = ledger.claim(message, runId);
    if (!claim.claimed) return 'SKIPPED_TERMINAL';
    if (claim.shouldClassify) {
      classificationSubmissions += 1;
      ledger.persistClassification(message.gmail_message_id, runId, classified);
    }
    domain.apply({ ...message, ...(claim.classification ?? classified) }, { runId });
    ledger.complete(message.gmail_message_id, runId, 'COMPLETED');
    return 'COMPLETED';
  };

  let interruption = null;
  try {
    submit('run-first');
  } catch (error) {
    interruption = error;
  }
  if (interruptAfterCommit !== null) {
    expect(interruption).toMatchObject({ code: 'SIMULATED_COMMIT_INTERRUPTION' });
    // The interrupted claim lease must expire before a later scheduled run can resume it.
    now = new Date(now.getTime() + 60_001);
  } else {
    expect(interruption).toBeNull();
  }

  for (let replay = 0; replay < replayCount; replay += 1) submit(`run-resume-${replay}`);

  return {
    snapshot: domainSnapshot(repository),
    classificationSubmissions,
    ledgerRecord: repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records[0]
  };
}

const messageArbitrary = fc.record({
  gmail_message_id: fc.uuid(),
  classification: fc.constantFrom(
    CLASSIFICATION.APPLICATION_CONFIRMATION,
    CLASSIFICATION.INTERVIEW_OR_TEST,
    CLASSIFICATION.REJECTION,
    CLASSIFICATION.OFFER
  ),
  role: fc.string({ minLength: 1, maxLength: 30 }).filter((value) => value.trim().length > 0),
  company: fc.string({ minLength: 1, maxLength: 30 }).filter((value) => value.trim().length > 0),
  applicationDate: fc.date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2030-12-31T23:59:59.999Z')
  }).map((date) => date.toISOString().slice(0, 10)),
  platform: fc.constantFrom('LinkedIn', 'eJobs', 'Direct'),
  location: fc.string({ minLength: 1, maxLength: 30 }).filter((value) => value.trim().length > 0)
}).map((message) => ({
  ...message,
  gmail_thread_id: `thread-${message.gmail_message_id}`,
  received_at: '2025-02-01T12:00:00.000Z',
  sender_domain: 'example.test'
}));

describe('Property 8: Replay has exactly-once domain effects', () => {
  // Feature: gmail-job-application-tracker, Property 8: Replay has exactly-once domain effects
  // Validates: Requirements 2.2, 6.4, 6.5
  it('preserves first-completion applications and history after every commit interruption and repeated resumes', () => {
    fc.assert(fc.property(
      messageArbitrary,
      fc.integer({ min: 1, max: 8 }),
      (message, replayCount) => {
        const firstCompleted = runReplayScenario(message, null, replayCount);
        expect(firstCompleted.classificationSubmissions).toBe(1);
        expect(firstCompleted.ledgerRecord.state).toBe(PROCESSED_MESSAGE_STATE.COMPLETED);

        for (let commit = 1; commit <= COMMIT_STEPS.length; commit += 1) {
          const recovered = runReplayScenario(message, commit, replayCount);
          expect(recovered.snapshot).toEqual(firstCompleted.snapshot);
          expect(recovered.classificationSubmissions).toBe(1);
          expect(recovered.ledgerRecord.state).toBe(PROCESSED_MESSAGE_STATE.COMPLETED);
        }
      }
    ), { numRuns: 100 });
  });
});
