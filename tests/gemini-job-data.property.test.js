import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, UNAVAILABLE } from '../src/core/domain-constants.js';
import { extractGeminiDomainEffect } from '../src/core/gemini-job-data.js';
import { ScheduledProcessingCoordinator } from '../src/services/scheduled-processing-coordinator.js';

const NOW = new Date('2025-02-03T10:00:00.000Z');
const RELEVANT_CLASSIFICATIONS = [
  CLASSIFICATION.APPLICATION_CONFIRMATION,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.OFFER
];
const DISPLAY_FIELD_MAPPINGS = [
  ['role', 'role'],
  ['company', 'company'],
  ['applicationDate', 'application_date'],
  ['platform', 'platform'],
  ['location', 'location']
];

const unicodeTextArbitrary = fc.oneof(
  fc.string(),
  fc.constantFrom('Inginer șef', 'Développeur', '開発者', 'مُهندس', '🚀 Remote', 'Київ')
);
const optionalDisplayValueArbitrary = fc.option(
  fc.oneof(unicodeTextArbitrary, fc.constant(''), fc.constant(' \t ')),
  { nil: undefined }
);
const relevantResultArbitrary = fc.record({
  classification: fc.constantFrom(...RELEVANT_CLASSIFICATIONS),
  role: optionalDisplayValueArbitrary,
  company: optionalDisplayValueArbitrary,
  applicationDate: optionalDisplayValueArbitrary,
  platform: optionalDisplayValueArbitrary,
  location: optionalDisplayValueArbitrary
});

function expectedDisplayValue(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'string' && value.trim() === '')
    ? UNAVAILABLE
    : value;
}

function completeIrrelevantMessage(existingApplications, existingHistory) {
  const applications = structuredClone(existingApplications);
  const history = structuredClone(existingHistory);
  let domainCalls = 0;
  const candidate = {
    gmail_message_id: 'irrelevant-message',
    gmail_thread_id: 'irrelevant-thread',
    received_at: NOW.toISOString()
  };
  const coordinator = new ScheduledProcessingCoordinator({
    repository: { appendProcessingFailure() {}, appendRelationshipException() {} },
    scheduler: {
      plan: () => ({ candidates: [candidate], discoveredMessages: [candidate] }),
      advanceCheckpoint() {}
    },
    ledger: {
      claim: () => ({ claimed: true, shouldClassify: false, classification: { classification: CLASSIFICATION.IRRELEVANT }, record: { attempt_count: 1 } }),
      complete() {}, markRetryableFailure() {}, defer() {}
    },
    quotaPersistence: {
      reserveBeforeOperation: () => ({ allowed: true, reservation: {} }),
      recordOperationUsage() {}, defer() {}
    },
    gemini: { classifyClaimedMessage() { throw new Error('Irrelevant classification must be reused.'); } },
    domain: { apply() { domainCalls += 1; applications.push({ application_id: 'unexpected' }); history.push({ event_key: 'unexpected' }); } },
    reporting: { rebuildAndUpsert() {} },
    lockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    now: () => NOW,
    createId: () => 'run-1',
    runtimeBudgetMs: 1_000,
    runtimeSafetyMarginMs: 1,
    retryDelayMs: 1_000
  });

  return { result: coordinator.runScheduledProcessing(), applications, history, domainCalls };
}

const existingStateArbitrary = fc.record({
  applications: fc.array(fc.record({
    application_id: fc.uuid(),
    role: unicodeTextArbitrary,
    platform: fc.constantFrom('LinkedIn', 'eJobs', 'Platformă internă')
  }), { maxLength: 5 }),
  history: fc.array(fc.record({
    event_key: fc.uuid(),
    application_id: fc.uuid(),
    new_status: fc.constantFrom('Applied', 'Interview', 'Rejected', 'Offer')
  }), { maxLength: 5 })
});

describe('Property 4: Irrelevant and incomplete data are safely normalized', () => {
  // Feature: gmail-job-application-tracker, Property 4: Irrelevant and incomplete data are safely normalized
  // Validates: Requirements 3.2, 4.1, 4.2, 4.3
  it('leaves irrelevant messages non-mutating and normalizes every missing relevant display field without altering platform text', () => {
    fc.assert(fc.property(existingStateArbitrary, relevantResultArbitrary, (existingState, result) => {
      const irrelevantEffect = extractGeminiDomainEffect({ classification: CLASSIFICATION.IRRELEVANT });
      expect(irrelevantEffect).toEqual({
        classification: CLASSIFICATION.IRRELEVANT,
        shouldMutateDomain: false,
        structuredJobData: null
      });

      const irrelevantOutcome = completeIrrelevantMessage(existingState.applications, existingState.history);
      expect(irrelevantOutcome.result).toMatchObject({ status: 'COMPLETED', completed: 1, failed: 0 });
      expect(irrelevantOutcome.domainCalls).toBe(0);
      expect(irrelevantOutcome.applications).toEqual(existingState.applications);
      expect(irrelevantOutcome.history).toEqual(existingState.history);

      const effect = extractGeminiDomainEffect(result);
      expect(effect).toMatchObject({ classification: result.classification, shouldMutateDomain: true });
      for (const [sourceField, displayField] of DISPLAY_FIELD_MAPPINGS) {
        expect(effect.structuredJobData[displayField]).toBe(expectedDisplayValue(result[sourceField]));
      }
      for (const platform of ['LinkedIn', 'eJobs']) {
        const platformEffect = extractGeminiDomainEffect({ ...result, platform });
        expect(platformEffect.structuredJobData.platform).toBe(platform);
      }
    }), { numRuns: 100 });
  });
});
