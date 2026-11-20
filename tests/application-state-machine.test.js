import { describe, expect, it } from 'vitest';
import { ApplicationStateMachine } from '../src/core/application-state-machine.js';
import { MATCH_DECISION, matchApplicationConfirmation } from '../src/core/application-matcher.js';
import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  RELATIONSHIP_EXCEPTION_REASON,
  SHEET_NAMES,
  UNAVAILABLE
} from '../src/core/domain-constants.js';

const PRIMARY_KEYS = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key'
});

// Synthetic, redacted fixtures only: no personal names, addresses, or email bodies.
const REDACTED_THREAD_ID = 'thread-redacted-001';
const REDACTED_DEDUP_KEY = 'sha256:redacted-confirmation-key';
const REDACTED_SENDER = 'recruiting@redacted.example.test';
const APPLIED_AT = '2025-01-10T09:00:00.000Z';

class InMemoryRepository {
  constructor(records = {}) {
    this.records = Object.fromEntries(Object.entries(records).map(([sheetName, rows]) => [
      sheetName, rows.map((row) => ({ ...row }))
    ]));
  }

  readTable(sheetName) {
    return { records: this.records[sheetName] ?? [] };
  }

  upsert(sheetName, patches) {
    const records = this.records[sheetName] ?? (this.records[sheetName] = []);
    const key = PRIMARY_KEYS[sheetName];
    for (const patch of patches) {
      const index = records.findIndex((row) => String(row[key]) === String(patch[key]));
      if (index === -1) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
  }
}

function createStateMachine(records) {
  let id = 0;
  const repository = new InMemoryRepository(records);
  return {
    repository,
    stateMachine: new ApplicationStateMachine(repository, {
      now: () => new Date('2025-02-01T10:00:00.000Z'),
      createId: () => `fixture-id-${id++}`
    })
  };
}

function redactedConfirmation(overrides = {}) {
  return {
    classification: CLASSIFICATION.APPLICATION_CONFIRMATION,
    gmail_message_id: 'message-confirmation-redacted-001',
    gmail_thread_id: REDACTED_THREAD_ID,
    received_at: APPLIED_AT,
    dedup_key: REDACTED_DEDUP_KEY,
    from: REDACTED_SENDER,
    structuredJobData: {
      role: 'Role [REDACTED]',
      company: 'Company [REDACTED]',
      applicationDate: '2025-01-10',
      platform: 'LinkedIn',
      location: 'Remote'
    },
    ...overrides
  };
}

function redactedFollowUp(classification, overrides = {}) {
  return {
    classification,
    gmail_message_id: `message-${classification}-redacted-001`,
    gmail_thread_id: REDACTED_THREAD_ID,
    received_at: '2025-01-15T09:00:00.000Z',
    from: REDACTED_SENDER,
    ...overrides
  };
}

describe('ApplicationStateMachine redacted fixtures', () => {
  it('links a follow-up in the shared thread and appends the prescribed status event', () => {
    const { repository, stateMachine } = createStateMachine();
    const created = stateMachine.upsertConfirmation(redactedConfirmation(), { runId: 'fixture-run' });

    const result = stateMachine.applyFollowUp(
      redactedFollowUp(CLASSIFICATION.INTERVIEW_OR_TEST),
      { runId: 'fixture-run' }
    );

    expect(result).toMatchObject({ outcome: 'TRANSITIONED', historyCreated: true });
    expect(result.match).toMatchObject({ decision: MATCH_DECISION.MATCHED, matchedBy: 'initial_thread' });
    expect(repository.readTable(SHEET_NAMES.APPLICATIONS).records).toMatchObject([{
      application_id: created.application.application_id,
      current_status: APPLICATION_STATUS.INTERVIEW,
      first_response_at: '2025-01-15T09:00:00.000Z'
    }]);
    expect(repository.readTable(SHEET_NAMES.STATUS_HISTORY).records).toContainEqual(expect.objectContaining({
      application_id: created.application.application_id,
      source_message_id: 'message-Interview_or_Test-redacted-001',
      previous_status: APPLICATION_STATUS.APPLIED,
      new_status: APPLICATION_STATUS.INTERVIEW
    }));
  });

  it('selects exactly one existing application by deterministic dedup key', () => {
    const application = {
      application_id: 'application-dedup-redacted',
      dedup_key: REDACTED_DEDUP_KEY,
      initial_thread_id: 'other-thread-redacted',
      role: 'Role [REDACTED]', company: 'Company [REDACTED]',
      current_status: APPLICATION_STATUS.APPLIED
    };

    const match = matchApplicationConfirmation(redactedConfirmation({
      gmail_thread_id: 'new-thread-redacted',
      gmail_message_id: 'message-confirmation-redacted-duplicate'
    }), [application]);

    expect(match).toMatchObject({
      decision: MATCH_DECISION.MATCHED,
      applicationId: 'application-dedup-redacted',
      matchedBy: 'dedup_key'
    });
  });

  it('leaves applications and status history untouched for an ambiguous follow-up match', () => {
    const applications = ['a', 'b'].map((suffix) => ({
      application_id: `application-ambiguous-${suffix}`,
      initial_thread_id: `thread-ambiguous-${suffix}`,
      initial_message_id: `message-ambiguous-${suffix}`,
      role: 'Role [REDACTED]', company: 'Company [REDACTED]',
      sender_domain_normalized: 'redacted.example.test', platform: 'LinkedIn', application_date: '2025-01-10',
      current_status: APPLICATION_STATUS.APPLIED, applied_at: APPLIED_AT
    }));
    const history = applications.map((application) => ({
      history_id: `history-${application.application_id}`,
      event_key: `status:${application.initial_message_id}:Applied`,
      application_id: application.application_id,
      source_message_id: application.initial_message_id,
      previous_status: null, new_status: APPLICATION_STATUS.APPLIED,
      classification: CLASSIFICATION.APPLICATION_CONFIRMATION, changed_at: APPLIED_AT
    }));
    const { repository, stateMachine } = createStateMachine({
      [SHEET_NAMES.APPLICATIONS]: applications,
      [SHEET_NAMES.STATUS_HISTORY]: history
    });
    const before = structuredClone(repository.records);

    const result = stateMachine.applyFollowUp(redactedFollowUp(CLASSIFICATION.OFFER, {
      gmail_thread_id: 'unrelated-thread-redacted',
      gmail_message_id: 'message-ambiguous-offer-redacted',
      structuredJobData: { role: 'Role [REDACTED]', company: 'Company [REDACTED]', platform: 'LinkedIn' }
    }));

    expect(result).toMatchObject({ outcome: 'UNRESOLVED', application: null, historyEvent: null });
    expect(result.match.relationshipException).toMatchObject({
      gmail_message_id: 'message-ambiguous-offer-redacted',
      reason: RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES,
      candidate_application_ids: ['application-ambiguous-a', 'application-ambiguous-b']
    });
    expect(repository.records).toEqual(before);
  });

  it('keeps a later status and history count when a duplicate confirmation is received', () => {
    const { repository, stateMachine } = createStateMachine();
    const created = stateMachine.upsertConfirmation(redactedConfirmation({
      structuredJobData: {
        role: null, company: 'Company [REDACTED]', applicationDate: null, platform: 'eJobs', location: null
      }
    }), { runId: 'fixture-run' });
    stateMachine.applyFollowUp(redactedFollowUp(CLASSIFICATION.INTERVIEW_OR_TEST), { runId: 'fixture-run' });

    const duplicate = stateMachine.upsertConfirmation(redactedConfirmation({
      gmail_message_id: 'message-confirmation-redacted-002',
      gmail_thread_id: 'different-thread-redacted',
      received_at: '2025-01-16T09:00:00.000Z',
      structuredJobData: { role: null, company: null, applicationDate: null, platform: null, location: null }
    }), { runId: 'fixture-run' });

    const [application] = repository.readTable(SHEET_NAMES.APPLICATIONS).records;
    const history = repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
    expect(duplicate).toMatchObject({ outcome: 'UPDATED', applicationCreated: false, historyCreated: false });
    expect(application).toMatchObject({
      application_id: created.application.application_id,
      current_status: APPLICATION_STATUS.INTERVIEW,
      role: UNAVAILABLE,
      application_date: UNAVAILABLE,
      platform: 'eJobs',
      location: UNAVAILABLE
    });
    expect(history).toHaveLength(2);
    expect(history.filter(({ new_status }) => new_status === APPLICATION_STATUS.APPLIED)).toHaveLength(1);
  });

  it.each([
    [CLASSIFICATION.INTERVIEW_OR_TEST, APPLICATION_STATUS.INTERVIEW],
    [CLASSIFICATION.REJECTION, APPLICATION_STATUS.REJECTED],
    [CLASSIFICATION.OFFER, APPLICATION_STATUS.OFFER]
  ])('applies %s as %s with one auditable transition', (classification, targetStatus) => {
    const { repository, stateMachine } = createStateMachine();
    const created = stateMachine.upsertConfirmation(redactedConfirmation(), { runId: 'fixture-run' });
    const message = redactedFollowUp(classification);

    const result = stateMachine.applyFollowUp(message, { runId: 'fixture-run' });
    const history = repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;

    expect(result).toMatchObject({ outcome: 'TRANSITIONED', applicationCreated: false, historyCreated: true });
    expect(result.historyEvent).toMatchObject({
      event_key: `status:${message.gmail_message_id}:${targetStatus}`,
      application_id: created.application.application_id,
      source_message_id: message.gmail_message_id,
      previous_status: APPLICATION_STATUS.APPLIED,
      new_status: targetStatus,
      classification,
      changed_at: message.received_at,
      run_id: 'fixture-run'
    });
    expect(history).toHaveLength(2);
    expect(repository.readTable(SHEET_NAMES.APPLICATIONS).records[0].current_status).toBe(targetStatus);
  });
});
