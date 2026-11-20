import { describe, expect, it } from 'vitest';
import { CLASSIFICATION, CONFIGURATION_KEY, QUOTA_OPERATION } from '../src/core/domain-constants.js';
import { GeminiClient, GeminiClientError } from '../src/services/gemini-client.js';

const NOW = new Date('2025-02-03T10:00:00.000Z');
const KEY = CONFIGURATION_KEY;

function configuration(overrides = {}) {
  return {
    [KEY.GEMINI_ENABLED]: true,
    [KEY.GEMINI_MODEL_ID]: 'gemini-free-test',
    [KEY.GEMINI_MODEL_VERIFIED_AT]: '2025-02-01T00:00:00.000Z',
    [KEY.GEMINI_FREE_TIER_RPM]: 15,
    [KEY.GEMINI_FREE_TIER_TPM]: 1000000,
    [KEY.GEMINI_FREE_TIER_RPD]: 1000,
    [KEY.GEMINI_INPUT_CHAR_LIMIT]: 12,
    [KEY.PRIVACY_ACKNOWLEDGED_AT]: '2025-02-01T00:00:00.000Z',
    ...overrides
  };
}

function validClassification() {
  return {
    classification: CLASSIFICATION.APPLICATION_CONFIRMATION,
    role: 'Engineer', company: 'Example', applicationDate: '2025-02-01',
    platform: 'LinkedIn', location: 'Remote', evidence: { confidence: 0.9, excerpt: 'Application received' }
  };
}

function providerResponse(status, body = '') {
  return {
    getResponseCode: () => status,
    getContentText: () => body
  };
}

function createClient(overrides = {}) {
  const ledger = overrides.ledger ?? {
    persisted: null,
    persistedWrites: [],
    getPersistedClassification() { return this.persisted; },
    persistClassification(messageId, runId, classification) {
      const record = { gmail_message_id: messageId, run_id: runId, classification_json: JSON.stringify(classification) };
      this.persistedWrites.push(record);
      return record;
    }
  };
  const quotaPersistence = overrides.quotaPersistence ?? {
    reservations: [], usage: [], deferrals: [],
    reserveBeforeOperation(request) {
      this.reservations.push(request);
      return { allowed: true, reservation: { reservation_id: 'reservation-1' }, estimate: [{ quota_name: 'gemini_rpm', units: 1 }] };
    },
    recordOperationUsage(request) { this.usage.push(request); },
    deferQuotaExceeded(request) { this.deferrals.push(request); return { deferral_id: 'deferral-1' }; }
  };
  const urlFetchApp = overrides.urlFetchApp ?? { fetch() { throw new Error('Unexpected Gemini request.'); } };
  const client = new GeminiClient({
    ledger,
    quotaPersistence,
    configuration: overrides.configuration ?? configuration(),
    urlFetchApp,
    propertiesService: overrides.propertiesService ?? { getScriptProperties: () => ({ getProperty: () => 'test-api-key' }) },
    now: () => NOW
  });
  return { client, ledger, quotaPersistence, urlFetchApp };
}

function message(overrides = {}) {
  return {
    gmail_message_id: 'message-1', subject: 'Application confirmation', sender: 'Recruiter <jobs@example.test>',
    received_at: '2025-02-03T09:00:00.000Z', body: 'Short safe message body',
    ...overrides
  };
}

describe('GeminiClient', () => {
  it('sends only minimized metadata and a bounded normalized excerpt, never attachments or full body', () => {
    let request;
    const { client } = createClient({
      urlFetchApp: {
        fetch(_url, options) {
          request = JSON.parse(options.payload);
          return providerResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(validClassification()) }] } }] }));
        }
      }
    });
    const originalBody = '1234567890ABCD applicant@example.test trailing private content';

    const result = client.classifyClaimedMessage(message({ body: originalBody, attachments: [{ name: 'resume.pdf', content: 'secret attachment' }], thread_history: 'private history' }), 'run-1');

    expect(result.status).toBe('CLASSIFIED');
    const sentText = request.contents[0].parts[0].text;
    expect(sentText).toContain('"excerpt":"1234567890AB"');
    expect(sentText).not.toContain('trailing private content');
    expect(sentText).not.toContain('applicant@example.test');
    expect(sentText).not.toContain('resume.pdf');
    expect(sentText).not.toContain('secret attachment');
    expect(sentText).not.toContain('private history');
  });

  it('uses a quota deferral without persisting a classification when Gemini returns HTTP 429', () => {
    const { client, ledger, quotaPersistence } = createClient({
      urlFetchApp: { fetch: () => providerResponse(429, '{"error":"rate limited"}') }
    });

    const result = client.classifyClaimedMessage(message(), 'run-1');

    expect(result).toMatchObject({ status: 'DEFERRED', deferral: { deferral_id: 'deferral-1' } });
    expect(quotaPersistence.deferrals).toHaveLength(1);
    expect(quotaPersistence.deferrals[0]).toMatchObject({
      runId: 'run-1', gmailMessageId: 'message-1', operation: QUOTA_OPERATION.GEMINI_REQUEST
    });
    expect(ledger.persistedWrites).toHaveLength(0);
  });

  it.each([401, 403])('rejects HTTP %i as a non-retryable authorization failure', (status) => {
    const { client, ledger, quotaPersistence } = createClient({
      urlFetchApp: { fetch: () => providerResponse(status, '{"error":"unauthorized"}') }
    });

    expect(() => client.classifyClaimedMessage(message(), 'run-1')).toThrow(expect.objectContaining({
      code: 'GEMINI_AUTHORIZATION_FAILED', retryable: false, status
    }));
    expect(quotaPersistence.deferrals).toHaveLength(0);
    expect(ledger.persistedWrites).toHaveLength(0);
  });

  it.each([500, 502, 503])('rejects HTTP %i as a retryable provider failure', (status) => {
    const { client, ledger, quotaPersistence } = createClient({
      urlFetchApp: { fetch: () => providerResponse(status, '{"error":"unavailable"}') }
    });

    expect(() => client.classifyClaimedMessage(message(), 'run-1')).toThrow(expect.objectContaining({
      code: 'GEMINI_PROVIDER_FAILED', retryable: true, status
    }));
    expect(quotaPersistence.deferrals).toHaveLength(0);
    expect(ledger.persistedWrites).toHaveLength(0);
  });

  it('blocks an unverified model before reserving quota or submitting message content', () => {
    let fetchCalls = 0;
    const { client, quotaPersistence } = createClient({
      configuration: configuration({ [KEY.GEMINI_MODEL_VERIFIED_AT]: '' }),
      urlFetchApp: { fetch() { fetchCalls += 1; } }
    });

    expect(() => client.classifyClaimedMessage(message(), 'run-1')).toThrow(GeminiClientError);
    expect(fetchCalls).toBe(0);
    expect(quotaPersistence.reservations).toHaveLength(0);
  });

  it('reuses a valid persisted classification JSON without quota reservation, provider request, or new persistence', () => {
    let fetchCalls = 0;
    const persistedClassification = validClassification();
    const { client, ledger, quotaPersistence } = createClient({
      ledger: {
        getPersistedClassification: () => ({ classification: persistedClassification, record: { classification_json: JSON.stringify(persistedClassification) } }),
        persistClassification() { throw new Error('A reused classification must not be persisted again.'); }
      },
      urlFetchApp: { fetch() { fetchCalls += 1; } }
    });

    const result = client.classifyClaimedMessage(message(), 'run-1');

    expect(result).toMatchObject({ status: 'REUSED', classification: persistedClassification });
    expect(fetchCalls).toBe(0);
    expect(quotaPersistence.reservations).toHaveLength(0);
    expect(ledger.getPersistedClassification).toBeDefined();
  });
});
