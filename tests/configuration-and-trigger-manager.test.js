import { afterEach, describe, expect, it } from 'vitest';
import { CONFIGURATION_KEY, SHEET_NAMES } from '../src/core/domain-constants.js';
import {
  createAppsScriptGeminiAdministration,
  GEMINI_API_KEY_PROPERTY,
  GEMINI_PRIVACY_NOTICE
} from '../src/services/configuration-service.js';
import { ScheduledProcessingTriggerManager } from '../src/services/trigger-manager.js';

const ADMIN_EMAIL = 'admin@example.test';
const GEMINI_INPUT = Object.freeze({
  modelId: 'gemini-free-test',
  modelVerifiedAt: '2025-02-03T09:00:00.000Z',
  freeTierRpm: 15,
  freeTierTpm: 1000000,
  freeTierRpd: 1500,
  dailyResetReference: 'UTC midnight',
  inputCharLimit: 1200,
  apiKey: 'AIza0123456789abcdefghijklmno'
});

class InMemoryConfigurationRepository {
  constructor() {
    this.recordsBySheet = {
      [SHEET_NAMES.CONFIGURATION]: [],
      [SHEET_NAMES.CONFIGURATION_AUDIT]: []
    };
  }

  readTable(sheetName) {
    return { records: (this.recordsBySheet[sheetName] ?? []).map((record) => ({ ...record })) };
  }

  upsertAll(recordsBySheet) {
    for (const [sheetName, patches] of Object.entries(recordsBySheet)) {
      const key = sheetName === SHEET_NAMES.CONFIGURATION ? 'config_key' : 'audit_id';
      const records = this.recordsBySheet[sheetName] ?? (this.recordsBySheet[sheetName] = []);
      for (const patch of patches) {
        const index = records.findIndex((record) => record[key] === patch[key]);
        if (index === -1) records.push({ ...patch });
        else records[index] = { ...records[index], ...patch };
      }
    }
  }
}

function installAppsScriptAdministrationMocks() {
  const originals = {
    propertiesService: globalThis.PropertiesService,
    session: globalThis.Session
  };
  const properties = new Map();
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, value)
    })
  };
  globalThis.Session = { getActiveUser: () => ({ getEmail: () => ADMIN_EMAIL }) };
  return { properties, originals };
}

function restoreGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

const installedMocks = [];
afterEach(() => {
  while (installedMocks.length) {
    const { originals } = installedMocks.pop();
    restoreGlobal('PropertiesService', originals.propertiesService);
    restoreGlobal('Session', originals.session);
  }
});

function createScriptAppMock(existingTriggers) {
  const triggers = [...existingTriggers];
  const created = [];
  const deleted = [];
  const calls = [];
  return {
    created,
    deleted,
    calls,
    getProjectTriggers: () => triggers,
    deleteTrigger(trigger) {
      deleted.push(trigger);
      const index = triggers.indexOf(trigger);
      if (index >= 0) triggers.splice(index, 1);
    },
    newTrigger(handler) {
      calls.push({ handler });
      return {
        timeBased: () => ({
          everyMinutes: (minutes) => ({ create: () => create(handler, 'minutes', minutes) }),
          everyHours: (hours) => ({ create: () => create(handler, 'hours', hours) })
        })
      };
    }
  };

  function create(handler, unit, interval) {
    const trigger = { handler, unit, interval, getHandlerFunction: () => handler };
    created.push(trigger);
    triggers.push(trigger);
    return trigger;
  }
}

describe('Apps Script configuration administration', () => {
  it('audits Gemini configuration, presents the required notice, and stores the API key only in Script Properties', () => {
    const mocks = installAppsScriptAdministrationMocks();
    installedMocks.push(mocks);
    const repository = new InMemoryConfigurationRepository();
    const timestamps = [
      '2025-02-03T10:00:00.000Z', '2025-02-03T10:01:00.000Z',
      '2025-02-03T10:02:00.000Z', '2025-02-03T10:03:00.000Z',
      '2025-02-03T10:04:00.000Z'
    ];
    let id = 0;
    const administration = createAppsScriptGeminiAdministration(repository, {
      now: () => timestamps.shift(),
      createId: () => `audit-${++id}`
    });

    const saved = administration.saveGeminiConfiguration(GEMINI_INPUT);
    administration.configurationService.saveConfiguration({
      [CONFIGURATION_KEY.EXECUTION_QUOTA_GMAIL_READS]: 1000,
      [CONFIGURATION_KEY.EXECUTION_QUOTA_SHEET_WRITES]: 500,
      [CONFIGURATION_KEY.EXECUTION_QUOTA_RUNTIME_MINUTES]: 90,
      [CONFIGURATION_KEY.EXECUTION_QUOTA_VERIFIED_AT]: '2025-02-03T09:30:00.000Z'
    });
    const notice = administration.getPrivacyNotice();

    expect(saved.apiKeyStored).toBe(true);
    expect(mocks.properties.get(GEMINI_API_KEY_PROPERTY)).toBe(GEMINI_INPUT.apiKey);
    expect(repository.readTable(SHEET_NAMES.CONFIGURATION).records).not.toContainEqual(
      expect.objectContaining({ config_value: GEMINI_INPUT.apiKey })
    );
    expect(repository.readTable(SHEET_NAMES.CONFIGURATION_AUDIT).records).not.toContainEqual(
      expect.objectContaining({ new_value: GEMINI_INPUT.apiKey })
    );
    expect(repository.readTable(SHEET_NAMES.CONFIGURATION_AUDIT).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ config_key: CONFIGURATION_KEY.GEMINI_MODEL_ID, new_value: GEMINI_INPUT.modelId, updated_by: ADMIN_EMAIL }),
      expect.objectContaining({ config_key: CONFIGURATION_KEY.GEMINI_FREE_TIER_RPM, new_value: String(GEMINI_INPUT.freeTierRpm), updated_by: ADMIN_EMAIL }),
      expect.objectContaining({ config_key: CONFIGURATION_KEY.EXECUTION_QUOTA_GMAIL_READS, new_value: '1000', updated_by: ADMIN_EMAIL }),
      expect.objectContaining({ config_key: CONFIGURATION_KEY.EXECUTION_QUOTA_VERIFIED_AT, new_value: '2025-02-03T09:30:00.000Z', updated_by: ADMIN_EMAIL })
    ]));
    expect(notice).toMatchObject({ version: GEMINI_PRIVACY_NOTICE.version });
    expect(notice.message).toMatch(/external processing service/i);
    expect(notice.message).toMatch(/privacy and data-use terms/i);
    expect(notice.message).toMatch(/does not, by itself, establish.*private/i);
    expect(notice.links.map(({ url }) => url)).toEqual(GEMINI_PRIVACY_NOTICE.links.map(({ url }) => url));
  });

  it('records acknowledgement from Session and withdrawal that immediately blocks Gemini submissions', () => {
    const mocks = installAppsScriptAdministrationMocks();
    installedMocks.push(mocks);
    const repository = new InMemoryConfigurationRepository();
    const timestamps = [
      '2025-02-03T10:00:00.000Z', '2025-02-03T10:01:00.000Z',
      '2025-02-03T10:02:00.000Z', '2025-02-03T10:03:00.000Z',
      '2025-02-03T10:04:00.000Z'
    ];
    let id = 0;
    const administration = createAppsScriptGeminiAdministration(repository, {
      now: () => timestamps.shift(),
      createId: () => `audit-${++id}`
    });
    administration.saveGeminiConfiguration(GEMINI_INPUT);

    const acknowledgement = administration.recordAcknowledgement({ noticeVersion: GEMINI_PRIVACY_NOTICE.version });
    const withdrawal = administration.withdrawAcknowledgement();
    const configuration = Object.fromEntries(repository.readTable(SHEET_NAMES.CONFIGURATION).records
      .map(({ config_key: key, config_value: value }) => [key, value]));

    expect(acknowledgement).toMatchObject({ acknowledgedBy: ADMIN_EMAIL, noticeVersion: GEMINI_PRIVACY_NOTICE.version });
    expect(configuration).toMatchObject({
      [CONFIGURATION_KEY.PRIVACY_NOTICE_VERSION]: GEMINI_PRIVACY_NOTICE.version,
      [CONFIGURATION_KEY.PRIVACY_ACKNOWLEDGED_BY]: ADMIN_EMAIL,
      [CONFIGURATION_KEY.GEMINI_ENABLED]: 'false',
      [CONFIGURATION_KEY.PRIVACY_WITHDRAWN_AT]: withdrawal.withdrawnAt
    });
    expect(withdrawal.authorization).toEqual({ allowed: false, reason: 'gemini_disabled' });
    expect(repository.readTable(SHEET_NAMES.CONFIGURATION_AUDIT).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ config_key: CONFIGURATION_KEY.PRIVACY_ACKNOWLEDGED_AT, updated_by: ADMIN_EMAIL }),
      expect.objectContaining({ config_key: CONFIGURATION_KEY.PRIVACY_WITHDRAWN_AT, updated_by: ADMIN_EMAIL })
    ]));
  });
});

describe('ScheduledProcessingTriggerManager', () => {
  it('uses the ScriptApp mock to replace only tracker triggers with one new configured trigger', () => {
    const oldTrackerTrigger = { getHandlerFunction: () => 'runScheduledProcessing' };
    const duplicateTrackerTrigger = { getHandlerFunction: () => 'runScheduledProcessing' };
    const unrelatedTrigger = { getHandlerFunction: () => 'anotherHandler' };
    const scriptApp = createScriptAppMock([oldTrackerTrigger, duplicateTrackerTrigger, unrelatedTrigger]);
    const manager = new ScheduledProcessingTriggerManager(scriptApp);

    const replacement = manager.replaceTrigger(120);
    const ensured = manager.ensureTrigger(120);

    expect(replacement).toMatchObject({ intervalMinutes: 120, replacedTriggerCount: 2 });
    expect(scriptApp.created).toEqual([expect.objectContaining({ handler: 'runScheduledProcessing', unit: 'hours', interval: 2 })]);
    expect(scriptApp.deleted).toEqual([oldTrackerTrigger, duplicateTrackerTrigger]);
    expect(scriptApp.getProjectTriggers()).toEqual([unrelatedTrigger, replacement.trigger]);
    expect(ensured).toMatchObject({ trigger: replacement.trigger, intervalMinutes: 120, replacedTriggerCount: 0 });
    expect(scriptApp.created).toHaveLength(1);
  });
});
