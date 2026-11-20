import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApplicationStateMachine } from '../src/core/application-state-machine.js';
import { APPLICATION_STATUS, CLASSIFICATION, SHEET_NAMES } from '../src/core/domain-constants.js';

const PRIMARY_KEY = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key'
});
const FOLLOW_UPS = Object.freeze([
  [CLASSIFICATION.INTERVIEW_OR_TEST, APPLICATION_STATUS.INTERVIEW],
  [CLASSIFICATION.REJECTION, APPLICATION_STATUS.REJECTED],
  [CLASSIFICATION.OFFER, APPLICATION_STATUS.OFFER]
]);

class InMemoryRepository {
  constructor() {
    this.records = { [SHEET_NAMES.APPLICATIONS]: [], [SHEET_NAMES.STATUS_HISTORY]: [] };
  }

  readTable(sheetName) {
    return { records: this.records[sheetName] ?? [] };
  }

  upsert(sheetName, patches) {
    const records = this.records[sheetName] ?? (this.records[sheetName] = []);
    const key = PRIMARY_KEY[sheetName];
    for (const patch of patches) {
      const index = records.findIndex((record) => String(record[key]) === String(patch[key]));
      if (index < 0) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
  }
}

function at(step) {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, step)).toISOString();
}

function confirmation(key, messageId, threadId, receivedAt) {
  return {
    classification: CLASSIFICATION.APPLICATION_CONFIRMATION,
    gmail_message_id: messageId,
    gmail_thread_id: threadId,
    received_at: receivedAt,
    dedup_key: `dedup:${key}`,
    structuredJobData: {
      role: `Role ${key}`,
      company: `Company ${key}`,
      applicationDate: '2025-01-01',
      platform: 'LinkedIn',
      location: 'Remote'
    },
    from: `recruiter-${key}@example.test`
  };
}

describe('Property 5: Confirmation creation is unique and auditable', () => {
  // Feature: gmail-job-application-tracker, Property 5: Confirmation creation is unique and auditable
  // Validates: Requirements 3.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3
  it('creates one stable application and one null-to-Applied event per deterministic key despite duplicates after follow-ups', () => {
    const scenarioArbitrary = fc.uniqueArray(fc.record({
      key: fc.uuid(),
      followUp: fc.constantFrom(...FOLLOW_UPS),
      duplicateCount: fc.integer({ min: 1, max: 4 })
    }), { selector: (scenario) => scenario.key, minLength: 1, maxLength: 8 });

    fc.assert(fc.property(scenarioArbitrary, (scenarios) => {
      const repository = new InMemoryRepository();
      let generatedId = 0;
      const stateMachine = new ApplicationStateMachine(repository, {
        now: () => new Date(at(0)),
        createId: () => `generated-id-${generatedId++}`
      });
      const applicationIds = new Map();
      let step = 1;

      for (const scenario of scenarios) {
        const result = stateMachine.upsertConfirmation(
          confirmation(scenario.key, `initial:${scenario.key}`, `thread:${scenario.key}`, at(step++)),
          { runId: 'property-run' }
        );
        applicationIds.set(scenario.key, result.application.application_id);
        expect(result).toMatchObject({ applicationCreated: true, historyCreated: true });
      }

      for (const scenario of scenarios) {
        const [classification] = scenario.followUp;
        stateMachine.applyFollowUp({
          classification,
          gmail_message_id: `follow-up:${scenario.key}`,
          gmail_thread_id: `thread:${scenario.key}`,
          received_at: at(step++)
        }, { runId: 'property-run' });
      }

      for (const scenario of scenarios) {
        for (let duplicate = 0; duplicate < scenario.duplicateCount; duplicate += 1) {
          const result = stateMachine.upsertConfirmation(
            confirmation(scenario.key, `duplicate:${scenario.key}:${duplicate}`, `duplicate-thread:${scenario.key}:${duplicate}`, at(step++)),
            { runId: 'property-run' }
          );
          expect(result).toMatchObject({ applicationCreated: false, historyCreated: false });
          expect(result.application.application_id).toBe(applicationIds.get(scenario.key));
        }
      }

      const applications = repository.readTable(SHEET_NAMES.APPLICATIONS).records;
      const history = repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
      expect(applications).toHaveLength(scenarios.length);
      expect(history).toHaveLength(scenarios.length * 2);

      for (const scenario of scenarios) {
        const applicationId = applicationIds.get(scenario.key);
        const [, targetStatus] = scenario.followUp;
        const matchingApplications = applications.filter(({ dedup_key }) => dedup_key === `dedup:${scenario.key}`);
        const appliedEvents = history.filter((event) =>
          event.application_id === applicationId && event.previous_status === null &&
          event.new_status === APPLICATION_STATUS.APPLIED && event.source_message_id === `initial:${scenario.key}`
        );
        const followUpEvents = history.filter((event) =>
          event.application_id === applicationId && event.source_message_id === `follow-up:${scenario.key}` &&
          event.new_status === targetStatus
        );

        expect(matchingApplications).toHaveLength(1);
        expect(matchingApplications[0]).toMatchObject({ application_id: applicationId, current_status: targetStatus });
        expect(appliedEvents).toHaveLength(1);
        expect(followUpEvents).toHaveLength(1);
      }
    }), { numRuns: 100 });
  });
});


const PRIOR_STATUSES = Object.freeze(Object.values(APPLICATION_STATUS));

function applicationForTransition(applicationId, priorStatus) {
  return {
    application_id: applicationId,
    current_status: priorStatus,
    applied_at: at(0),
    first_response_at: priorStatus === APPLICATION_STATUS.APPLIED ? null : at(0),
    interview_at: priorStatus === APPLICATION_STATUS.INTERVIEW ? at(0) : null,
    rejected_at: priorStatus === APPLICATION_STATUS.REJECTED ? at(0) : null,
    offer_at: priorStatus === APPLICATION_STATUS.OFFER ? at(0) : null,
    last_status_changed_at: at(0),
    created_at: at(0),
    updated_at: at(0),
    last_message_id: `seed:${applicationId}`
  };
}

function historyForPriorStatus(applicationId, priorStatus) {
  const classificationByStatus = {
    [APPLICATION_STATUS.APPLIED]: CLASSIFICATION.APPLICATION_CONFIRMATION,
    [APPLICATION_STATUS.INTERVIEW]: CLASSIFICATION.INTERVIEW_OR_TEST,
    [APPLICATION_STATUS.REJECTED]: CLASSIFICATION.REJECTION,
    [APPLICATION_STATUS.OFFER]: CLASSIFICATION.OFFER
  };
  return {
    history_id: `seed-history:${applicationId}`,
    event_key: `status:seed:${applicationId}:${priorStatus}`,
    application_id: applicationId,
    source_message_id: `seed:${applicationId}`,
    previous_status: priorStatus === APPLICATION_STATUS.APPLIED ? null : APPLICATION_STATUS.APPLIED,
    new_status: priorStatus,
    classification: classificationByStatus[priorStatus],
    changed_at: at(0),
    run_id: 'seed-run'
  };
}

describe('Property 6: A uniquely linked follow-up produces one prescribed transition', () => {
  // Feature: gmail-job-application-tracker, Property 6: A uniquely linked follow-up produces one prescribed transition
  // Validates: Requirements 5.1, 5.2, 5.3, 5.4, 6.3
  it('transitions every prior status for every permitted follow-up classification and preserves an exact event', () => {
    const scenarioArbitrary = fc.record({
      suffix: fc.uuid(),
      receivedSecond: fc.integer({ min: 1, max: 59 })
    });

    fc.assert(fc.property(scenarioArbitrary, ({ suffix, receivedSecond }) => {
      const repository = new InMemoryRepository();
      let generatedId = 0;
      const stateMachine = new ApplicationStateMachine(repository, {
        now: () => new Date(at(0)),
        createId: () => `generated-transition-id-${generatedId++}`
      });
      const changedAt = at(receivedSecond);

      for (const priorStatus of PRIOR_STATUSES) {
        for (const [classification, targetStatus] of FOLLOW_UPS) {
          const applicationId = `application:${suffix}:${priorStatus}:${targetStatus}`;
          const messageId = `follow-up:${suffix}:${priorStatus}:${targetStatus}`;
          repository.records[SHEET_NAMES.APPLICATIONS].push(applicationForTransition(applicationId, priorStatus));
          repository.records[SHEET_NAMES.STATUS_HISTORY].push(historyForPriorStatus(applicationId, priorStatus));

          const result = stateMachine.applyFollowUp({
            classification,
            gmail_message_id: messageId,
            gmail_thread_id: `thread:${suffix}:${priorStatus}:${targetStatus}`,
            received_at: changedAt
          }, { applicationId, runId: 'property-run' });

          const events = repository.records[SHEET_NAMES.STATUS_HISTORY]
            .filter((event) => event.application_id === applicationId);
          const transition = events.find((event) => event.source_message_id === messageId);
          const application = repository.records[SHEET_NAMES.APPLICATIONS]
            .find((record) => record.application_id === applicationId);

          expect(result).toMatchObject({ outcome: 'TRANSITIONED', applicationCreated: false, historyCreated: true });
          expect(events).toHaveLength(2);
          expect(transition).toMatchObject({
            event_key: `status:${messageId}:${targetStatus}`,
            application_id: applicationId,
            source_message_id: messageId,
            previous_status: priorStatus,
            new_status: targetStatus,
            classification,
            changed_at: changedAt,
            run_id: 'property-run'
          });
          expect(application).toMatchObject({
            application_id: applicationId,
            current_status: targetStatus,
            last_status_changed_at: changedAt,
            last_message_id: messageId
          });
        }
      }
    }), { numRuns: 100 });
  });
});