import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CLASSIFICATION } from '../src/core/domain-constants.js';
import { GeminiClientError, parseGeminiClassificationResponse } from '../src/services/gemini-client.js';
import { ScheduledProcessingCoordinator } from '../src/services/scheduled-processing-coordinator.js';

const NOW = new Date('2025-02-03T10:00:00.000Z');
const CLASSIFICATIONS = Object.values(CLASSIFICATION);
const RESULT_FIELDS = ['classification', 'role', 'company', 'applicationDate', 'platform', 'location', 'evidence'];
const EVIDENCE_FIELDS = ['confidence', 'excerpt'];

function hasExactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function expectedClassification(responseText) {
  if (typeof responseText !== 'string' || responseText.trim() === '') return null;
  let value;
  try { value = JSON.parse(responseText); } catch (_) { return null; }
  if (!hasExactFields(value, RESULT_FIELDS) || !CLASSIFICATIONS.includes(value.classification)) return null;
  if (!['role', 'company', 'platform', 'location'].every((field) => value[field] === null || typeof value[field] === 'string')) return null;
  if (value.applicationDate !== null && !isValidDateOnly(value.applicationDate)) return null;
  if (!hasExactFields(value.evidence, EVIDENCE_FIELDS) || typeof value.evidence.confidence !== 'number' ||
    !Number.isFinite(value.evidence.confidence) || value.evidence.confidence < 0 || value.evidence.confidence > 1 ||
    typeof value.evidence.excerpt !== 'string' || Array.from(value.evidence.excerpt).length > 500) return null;
  return value;
}

function validResult(overrides = {}) {
  return {
    classification: CLASSIFICATION.APPLICATION_CONFIRMATION, role: null, company: 'Example', applicationDate: '2025-02-03',
    platform: 'LinkedIn', location: null, evidence: { confidence: 0.5, excerpt: 'confirmation' }, ...overrides
  };
}

function runInvalidResponse(responseText) {
  const failures = [];
  const retries = [];
  let domainCalls = 0;
  const candidate = { gmail_message_id: 'message-1', received_at: NOW.toISOString() };
  const coordinator = new ScheduledProcessingCoordinator({
    repository: { appendProcessingFailure: (failure) => failures.push(failure), appendRelationshipException() {} },
    scheduler: { plan: () => ({ candidates: [candidate], discoveredMessages: [candidate] }), advanceCheckpoint() {} },
    ledger: {
      claim: () => ({ claimed: true, shouldClassify: true, record: { attempt_count: 1 } }), complete() {},
      markRetryableFailure: (...args) => retries.push(args), defer() {}
    },
    quotaPersistence: {
      reserveBeforeOperation: () => ({ allowed: true, reservation: {} }), recordOperationUsage() {}, defer() {}
    },
    gemini: { classifyClaimedMessage: () => parseGeminiClassificationResponse(responseText) },
    domain: { apply: () => { domainCalls += 1; } }, reporting: { rebuildAndUpsert() {} },
    lockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    now: () => NOW, createId: () => 'run-1', runtimeBudgetMs: 1000, runtimeSafetyMarginMs: 1, retryDelayMs: 1000
  });
  return { result: coordinator.runScheduledProcessing(), failures, retries, domainCalls };
}

const boundaryBodies = [
  JSON.stringify(validResult({ evidence: { confidence: 0, excerpt: '' } })),
  JSON.stringify(validResult({ classification: CLASSIFICATION.IRRELEVANT, evidence: { confidence: 1, excerpt: 'x'.repeat(500) } })),
  JSON.stringify(validResult({ applicationDate: '2024-02-29' })),
  JSON.stringify(validResult({ applicationDate: '2025-02-29' })),
  JSON.stringify(validResult({ evidence: { confidence: -0.000001, excerpt: '' } })),
  JSON.stringify(validResult({ evidence: { confidence: 1.000001, excerpt: '' } })),
  JSON.stringify(validResult({ evidence: { confidence: 0.5, excerpt: 'x'.repeat(501) } })),
  JSON.stringify({ ...validResult(), unexpected: true }),
  JSON.stringify({ classification: CLASSIFICATION.OFFER }),
  '{"classification":', '', 'not-json', 'null', '[]'
];

const arbitraryResponseBody = fc.oneof(
  fc.string(),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.constantFrom(...boundaryBodies)
);

describe('Property 3: Classification contract is strict and non-mutating on invalid data', () => {
  // Feature: gmail-job-application-tracker, Property 3: Classification contract is strict and non-mutating on invalid data
  // Validates: Requirements 3.1, 3.4
  it('accepts exactly conforming JSON and retries every rejected body without domain mutation', () => {
    fc.assert(fc.property(arbitraryResponseBody, (responseText) => {
      const expected = expectedClassification(responseText);
      if (expected) {
        expect(parseGeminiClassificationResponse(responseText)).toEqual(expected);
        return;
      }

      expect(() => parseGeminiClassificationResponse(responseText)).toThrow(GeminiClientError);
      const outcome = runInvalidResponse(responseText);
      expect(outcome.result).toMatchObject({ status: 'COMPLETED', failed: 1, completed: 0 });
      expect(outcome.domainCalls).toBe(0);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]).toMatchObject({
        gmail_message_id: 'message-1', reason_code: 'INVALID_RESPONSE', retryable: true, attempt_count: 1
      });
      expect(outcome.retries).toHaveLength(1);
      expect(outcome.retries[0][0]).toBe('message-1');
      expect(outcome.retries[0][1]).toBe('run-1');
    }), { numRuns: 150 });
  });
});
