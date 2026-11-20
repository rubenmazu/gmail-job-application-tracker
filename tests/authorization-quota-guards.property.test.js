import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { QuotaPersistenceAdapter, QUOTA_USAGE_CONFIGURATION_KEY } from '../src/adapters/quota-persistence-adapter.js';
import { CONFIGURATION_KEY, PROCESSED_MESSAGE_STATE, QUOTA_OPERATION, SHEET_NAMES } from '../src/core/domain-constants.js';
import { GeminiClient, GeminiClientError } from '../src/services/gemini-client.js';
import { QUOTA_NAME } from '../src/core/quota-guard.js';

const NOW = new Date('2025-02-03T10:00:00.000Z');
const MESSAGE_ID = 'candidate-1';
const responseBody = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ classification: 'Irrelevant', role: null, company: null, applicationDate: null, platform: null, location: null, evidence: { confidence: 0, excerpt: '' } }) }] } }] });

class MemoryRepository {
  constructor(configuration) { this.records = { [SHEET_NAMES.CONFIGURATION]: Object.entries(configuration).filter(([, value]) => value !== undefined).map(([config_key, config_value]) => ({ config_key, config_value })), [SHEET_NAMES.PROCESSED_MESSAGES]: [{ gmail_message_id: MESSAGE_ID, state: PROCESSED_MESSAGE_STATE.IN_PROGRESS }], [SHEET_NAMES.QUOTA_DEFERRALS]: [] }; }
  readTable(sheetName) { return { records: this.records[sheetName] ?? (this.records[sheetName] = []) }; }
  upsert(sheetName, patches) { const key = sheetName === SHEET_NAMES.CONFIGURATION ? 'config_key' : sheetName === SHEET_NAMES.PROCESSED_MESSAGES ? 'gmail_message_id' : 'deferral_id'; const records = this.readTable(sheetName).records; for (const patch of patches) { const index = records.findIndex((record) => record[key] === patch[key]); if (index < 0) records.push({ ...patch }); else records[index] = { ...records[index], ...patch }; } return { records }; }
}

function configurationFor(authorization, rpmLimit, consumedUnits) {
  return {
    [CONFIGURATION_KEY.GEMINI_ENABLED]: authorization === 'absent' ? 'false' : 'true',
    [CONFIGURATION_KEY.GEMINI_MODEL_ID]: 'gemini-test-model', [CONFIGURATION_KEY.GEMINI_MODEL_VERIFIED_AT]: NOW.toISOString(),
    [CONFIGURATION_KEY.GEMINI_FREE_TIER_RPM]: String(rpmLimit), [CONFIGURATION_KEY.GEMINI_FREE_TIER_TPM]: '10000', [CONFIGURATION_KEY.GEMINI_FREE_TIER_RPD]: '10000', [CONFIGURATION_KEY.GEMINI_INPUT_CHAR_LIMIT]: '1000',
    [CONFIGURATION_KEY.PRIVACY_ACKNOWLEDGED_AT]: authorization === 'absent' ? undefined : NOW.toISOString(),
    [CONFIGURATION_KEY.PRIVACY_WITHDRAWN_AT]: authorization === 'withdrawn' ? NOW.toISOString() : undefined,
    [QUOTA_USAGE_CONFIGURATION_KEY]: JSON.stringify([{ quota_name: QUOTA_NAME.GEMINI_RPM, window_started_at: NOW.toISOString(), consumed_units: consumedUnits, reserved_units: 0 }])
  };
}

function nonterminalState(repository) { return repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).records[0].state; }

describe('Property 9: Authorization and quota guards prevent prohibited submission and preserve retries', () => {
  // Feature: gmail-job-application-tracker, Property 9: Authorization and quota guards prevent prohibited submission and preserve retries
  // Validates: Requirements 7.3, 7.4, 7.5, 7.7, 7.10, 10.2, 10.3, 10.4, 10.5
  it('blocks absent or withdrawn acknowledgement, defers quota cases exactly once, and retries in the eligible window', () => {
    const scenarioArbitrary = fc.record({ authorization: fc.constantFrom('active', 'absent', 'withdrawn'), quotaAvailable: fc.boolean(), providerQuotaError: fc.boolean(), rpmLimit: fc.integer({ min: 1, max: 20 }) });
    fc.assert(fc.property(scenarioArbitrary, ({ authorization, quotaAvailable, providerQuotaError, rpmLimit }) => {
      const repository = new MemoryRepository(configurationFor(authorization, rpmLimit, quotaAvailable ? rpmLimit - 1 : rpmLimit));
      const quota = new QuotaPersistenceAdapter(repository, { createId: () => 'deferral-1' });
      let persisted = null; let fetches = 0;
      const ledger = { getPersistedClassification: () => null, persistClassification: (_messageId, _runId, classification) => (persisted = { classification }) };
      const fetchApp = { fetch() { fetches += 1; const status = authorization === 'active' && quotaAvailable && providerQuotaError && fetches === 1 ? 429 : 200; return { getResponseCode: () => status, getContentText: () => responseBody }; } };
      const classifyAt = (now) => new GeminiClient({ ledger, quotaPersistence: quota, configuration: configurationFor(authorization, rpmLimit, quotaAvailable ? rpmLimit - 1 : rpmLimit), urlFetchApp: fetchApp, propertiesService: { getScriptProperties: () => ({ getProperty: () => 'test-key' }) }, now: () => now }).classifyClaimedMessage({ gmail_message_id: MESSAGE_ID, body: 'application' }, 'run-1');
      if (authorization !== 'active') {
        expect(() => classifyAt(NOW)).toThrow(GeminiClientError); expect(fetches).toBe(0); expect(repository.readTable(SHEET_NAMES.QUOTA_DEFERRALS).records).toHaveLength(0); expect(nonterminalState(repository)).toBe(PROCESSED_MESSAGE_STATE.IN_PROGRESS); return;
      }
      const result = classifyAt(NOW);
      const deferrals = repository.readTable(SHEET_NAMES.QUOTA_DEFERRALS).records;
      if (!quotaAvailable || providerQuotaError) {
        expect(result.status).toBe('DEFERRED'); expect(deferrals).toHaveLength(1); expect(nonterminalState(repository)).toBe(PROCESSED_MESSAGE_STATE.DEFERRED); expect(fetches).toBe(quotaAvailable ? 1 : 0); expect(quota.eligibleRetries(new Date(deferrals[0].eligible_after))).toHaveLength(1);
        const retried = classifyAt(new Date(deferrals[0].eligible_after)); expect(retried.status).toBe('CLASSIFIED'); expect(persisted?.classification.classification).toBe('Irrelevant');
      } else { expect(result.status).toBe('CLASSIFIED'); expect(fetches).toBe(1); expect(deferrals).toHaveLength(0); expect(persisted?.classification.classification).toBe('Irrelevant'); }
    }), { numRuns: 150 });
  });
});