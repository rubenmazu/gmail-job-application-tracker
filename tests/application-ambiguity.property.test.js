import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApplicationStateMachine } from '../src/core/application-state-machine.js';
import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  PROCESSED_MESSAGE_STATE,
  QUOTA_OPERATION,
  RELATIONSHIP_EXCEPTION_REASON,
  SHEET_NAMES
} from '../src/core/domain-constants.js';
import { ScheduledProcessingCoordinator } from '../src/services/scheduled-processing-coordinator.js';

const FOLLOW_UP_CLASSIFICATIONS = Object.freeze([
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.OFFER
]);
const PRIMARY_KEYS = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key'
});
const FIXED_NOW = new Date('2025-02-03T10:00:00.000Z');

class InMemoryRepository {
  constructor(applications, history) {
    this.records = {
      [SHEET_NAMES.APPLICATIONS]: applications.map((record) => ({ ...record })),
      [SHEET_NAMES.STATUS_HISTORY]: history.map((record) => ({ ...record }))
    };
    this.relationships = [];
    this.failures = [];
  }

  readTable(sheetName) { return { records: this.records[sheetName] ?? [] }; }

  upsert(sheetName, patches) {
    const records = this.records[sheetName] ?? (this.records[sheetName] = []);
    const key = PRIMARY_KEYS[sheetName];
    for (const patch of patches) {
      const index = records.findIndex((record) => String(record[key]) === String(patch[key]));
      if (index === -1) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
  }

  appendRelationshipException(record) { this.relationships.push({ ...record }); }
  appendProcessingFailure(record) { this.failures.push({ ...record }); }
}

function application(applicationId, suffix, status, { weak = false } = {}) {
  return {
    application_id: applicationId,
    initial_thread_id: `initial-thread:${suffix}:${applicationId}`,
    initial_message_id: `initial-message:${suffix}:${applicationId}`,
    company: 'Example Company', role: weak ? 'Different Role' : 'Engineering',
    sender_domain_normalized: weak ? 'other.example.test' : 'example.test',
    platform: weak ? 'Other Platform' : 'LinkedIn', application_date: '2025-01-01',
    applied_at: '2025-01-01T09:00:00.000Z', current_status: status
  };
}

function history(applicationId, status) {
  return [{
    history_id: `history:${applicationId}`, event_key: `status:seed:${applicationId}:${status}`,
    application_id: applicationId, source_message_id: `seed:${applicationId}`,
    previous_status: null, new_status: status, classification: CLASSIFICATION.APPLICATION_CONFIRMATION,
    changed_at: '2025-01-01T09:00:00.000Z', run_id: 'seed-run'
  }];
}

function scenarioFor(kind, suffix, classification, status) {
  const message = {
    gmail_message_id: `follow-up:${kind}:${suffix}`,
    gmail_thread_id: `follow-up-thread:${kind}:${suffix}`,
    classification, company: 'Example Company', role: kind === 'below-threshold' ? 'Unrelated Role' : 'Engineering',
    from: kind === 'below-threshold' ? 'recruiter@unrelated.example.test' : 'recruiter@example.test',
    platform: kind === 'below-threshold' ? 'Unrelated Platform' : 'LinkedIn',
    received_at: '2025-01-02T09:00:00.000Z'
  };
  if (kind === 'zero-candidates') return { message, applications: [], history: [], reason: RELATIONSHIP_EXCEPTION_REASON.NO_CANDIDATE };
  const first = application(`application:${kind}:a:${suffix}`, suffix, status, { weak: kind === 'below-threshold' });
  const applications = kind === 'tied-candidates'
    ? [first, application(`application:${kind}:b:${suffix}`, suffix, status)]
    : [first];
  return {
    message,
    applications,
    history: applications.flatMap((record) => history(record.application_id, status)),
    reason: kind === 'tied-candidates' ? RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES : RELATIONSHIP_EXCEPTION_REASON.WEAK_MATCH
  };
}

function processScenario(scenario) {
  const repository = new InMemoryRepository(scenario.applications, scenario.history);
  const completions = [];
  const coordinator = new ScheduledProcessingCoordinator({
    repository,
    scheduler: { plan: () => ({ candidates: [scenario.message], discoveredMessages: [scenario.message] }), advanceCheckpoint() {} },
    ledger: {
      claim: () => ({ claimed: true, shouldClassify: false, classification: { classification: scenario.message.classification }, record: { attempt_count: 1 } }),
      complete(messageId, runId, outcome, details) { completions.push({ messageId, runId, outcome, details }); },
      markRetryableFailure() {}, defer() {}
    },
    quotaPersistence: {
      reserveBeforeOperation: (request) => ({ allowed: true, reservation: { operation: request.operation } }),
      recordOperationUsage() {}, defer() {}
    },
    gemini: { classifyClaimedMessage() { throw new Error('A reused classification must not call Gemini.'); } },
    domain: new ApplicationStateMachine(repository, { now: () => FIXED_NOW, createId: () => 'unused-id' }),
    reporting: { rebuildAndUpsert() {} },
    lockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    now: () => FIXED_NOW, createId: () => 'property-run', runtimeSafetyMarginMs: 1, logError: () => {}
  });
  const before = structuredClone({ applications: repository.records[SHEET_NAMES.APPLICATIONS], history: repository.records[SHEET_NAMES.STATUS_HISTORY] });
  const result = coordinator.runScheduledProcessing();
  return { repository, completions, before, result };
}

describe('Property 7: Ambiguity is non-destructive', () => {
  // Feature: gmail-job-application-tracker, Property 7: Ambiguity is non-destructive
  // Validates: Requirements 5.5, 4.6
  it('records exactly one unresolved relationship for zero candidates, ties, and below-threshold scores without changing applications or history', () => {
    const scenarioArbitrary = fc.record({
      suffix: fc.uuid(),
      classification: fc.constantFrom(...FOLLOW_UP_CLASSIFICATIONS),
      status: fc.constantFrom(...Object.values(APPLICATION_STATUS))
    });

    fc.assert(fc.property(scenarioArbitrary, ({ suffix, classification, status }) => {
      for (const kind of ['zero-candidates', 'tied-candidates', 'below-threshold']) {
        const scenario = scenarioFor(kind, suffix, classification, status);
        const { repository, completions, before, result } = processScenario(scenario);
        const exception = repository.relationships[0];

        expect(result).toMatchObject({ status: 'COMPLETED', planned: 1, completed: 1 });
        expect(repository.failures).toHaveLength(0);
        expect(repository.relationships).toHaveLength(1);
        expect(exception).toMatchObject({
          gmail_message_id: scenario.message.gmail_message_id,
          classification, reason: scenario.reason
        });
        expect(repository.records[SHEET_NAMES.APPLICATIONS]).toEqual(before.applications);
        expect(repository.records[SHEET_NAMES.STATUS_HISTORY]).toEqual(before.history);
        expect(completions).toEqual([{
          messageId: scenario.message.gmail_message_id, runId: 'property-run', outcome: 'UNRESOLVED',
          details: { state: PROCESSED_MESSAGE_STATE.UNRESOLVED }
        }]);
        if (kind === 'zero-candidates') expect(exception.candidate_application_ids).toEqual([]);
        else if (kind === 'tied-candidates') expect(exception.candidate_application_ids).toEqual(
          expect.arrayContaining(scenario.applications.map(({ application_id }) => application_id))
        );
        else expect(exception.evidence_summary).toMatch(/score=5; threshold=6/);
      }
    }), { numRuns: 100 });
  });
});
