import { SheetsRepository } from '../adapters/sheets-repository.js';
import { initializeSpreadsheetSchema } from '../adapters/spreadsheet-schema.js';
import { CONFIGURATION_KEY, DEFAULT_CONFIGURATION } from '../core/domain-constants.js';
import { ConfigurationService } from './configuration-service.js';

export const SCHEDULED_PROCESSING_HANDLER = 'runScheduledProcessing';

const MINUTE_INTERVALS = new Set([1, 5, 10, 15, 30]);
const HOUR_INTERVALS = new Map([
  [60, 1], [120, 2], [240, 4], [360, 6], [480, 8], [720, 12]
]);

export const SUPPORTED_SCHEDULE_INTERVAL_MINUTES = Object.freeze([
  ...MINUTE_INTERVALS,
  ...HOUR_INTERVALS.keys()
]);

/**
 * Ensures a user-provided interval can be represented by an Apps Script
 * time-driven trigger. Apps Script only supports these documented cadences.
 */
export function validateScheduleIntervalMinutes(value) {
  const minutes = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(minutes) || !SUPPORTED_SCHEDULE_INTERVAL_MINUTES.includes(minutes)) {
    throw new RangeError(
      `Schedule interval must be one of: ${SUPPORTED_SCHEDULE_INTERVAL_MINUTES.join(', ')} minutes.`
    );
  }
  return minutes;
}

function requireScriptApp(scriptApp) {
  if (!scriptApp || typeof scriptApp.getProjectTriggers !== 'function' || typeof scriptApp.newTrigger !== 'function') {
    throw new TypeError('ScriptApp with getProjectTriggers and newTrigger is required.');
  }
  return scriptApp;
}

function triggerHandler(trigger) {
  return trigger && typeof trigger.getHandlerFunction === 'function'
    ? trigger.getHandlerFunction()
    : null;
}

/** Manages the one installable time-driven trigger owned by this tracker. */
export class ScheduledProcessingTriggerManager {
  constructor(scriptApp, { handlerFunction = SCHEDULED_PROCESSING_HANDLER } = {}) {
    this.scriptApp = requireScriptApp(scriptApp);
    if (typeof handlerFunction !== 'string' || handlerFunction.trim() === '') {
      throw new TypeError('A non-empty scheduled processing handler name is required.');
    }
    this.handlerFunction = handlerFunction;
  }

  listManagedTriggers() {
    return this.scriptApp.getProjectTriggers()
      .filter((trigger) => triggerHandler(trigger) === this.handlerFunction);
  }

  createTrigger(intervalMinutes) {
    const minutes = validateScheduleIntervalMinutes(intervalMinutes);
    const timeBased = this.scriptApp.newTrigger(this.handlerFunction).timeBased();
    const triggerBuilder = MINUTE_INTERVALS.has(minutes)
      ? timeBased.everyMinutes(minutes)
      : timeBased.everyHours(HOUR_INTERVALS.get(minutes));
    return triggerBuilder.create();
  }

  /**
   * Replaces every pre-existing tracker trigger after the new one has been
   * created, leaving exactly one handler trigger when the operation succeeds.
   */
  replaceTrigger(intervalMinutes) {
    const minutes = validateScheduleIntervalMinutes(intervalMinutes);
    const existingTriggers = this.listManagedTriggers();
    const trigger = this.createTrigger(minutes);
    for (const existingTrigger of existingTriggers) this.scriptApp.deleteTrigger(existingTrigger);
    return { trigger, intervalMinutes: minutes, replacedTriggerCount: existingTriggers.length };
  }

  /** Idempotently restores the single tracker trigger without recreating it. */
  ensureTrigger(intervalMinutes) {
    const minutes = validateScheduleIntervalMinutes(intervalMinutes);
    const managedTriggers = this.listManagedTriggers();
    if (managedTriggers.length === 1) {
      return { trigger: managedTriggers[0], intervalMinutes: minutes, replacedTriggerCount: 0 };
    }
    return this.replaceTrigger(minutes);
  }
}

function defaultSpreadsheet() {
  if (typeof SpreadsheetApp === 'undefined' || typeof SpreadsheetApp.getActiveSpreadsheet !== 'function') {
    throw new Error('An active Google Spreadsheet is required outside Google Apps Script.');
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function defaultScriptApp() {
  if (typeof ScriptApp === 'undefined') {
    throw new Error('ScriptApp is required outside Google Apps Script.');
  }
  return ScriptApp;
}

function defaultAuthorizedUser() {
  if (typeof Session === 'undefined' || typeof Session.getActiveUser !== 'function') {
    throw new Error('An authorized user identity is required outside Google Apps Script.');
  }
  return Session.getActiveUser().getEmail();
}

function createServices(options) {
  const spreadsheet = options.spreadsheet ?? defaultSpreadsheet();
  const repository = options.repository ?? new SheetsRepository(spreadsheet, options.repositoryOptions);
  const configurationService = options.configurationService ?? new ConfigurationService(repository, {
    ...options.configurationServiceOptions,
    getAuthorizedUser: options.getAuthorizedUser ?? defaultAuthorizedUser
  });
  const triggerManager = options.triggerManager ?? new ScheduledProcessingTriggerManager(
    options.scriptApp ?? defaultScriptApp(),
    options.triggerManagerOptions
  );
  return { spreadsheet, repository, configurationService, triggerManager };
}

function configuredInterval(configurationService) {
  const configuration = configurationService.readConfiguration();
  return validateScheduleIntervalMinutes(
    configuration[CONFIGURATION_KEY.SCHEDULE_INTERVAL_MINUTES]
      ?? DEFAULT_CONFIGURATION[CONFIGURATION_KEY.SCHEDULE_INTERVAL_MINUTES]
  );
}

/**
 * Initializes the Sheet schema and creates exactly one installable trigger for
 * runScheduledProcessing. Calling it again also reconciles manually-created
 * duplicate tracker triggers.
 */
export function initializeTracker(options = {}) {
  const { spreadsheet, configurationService, triggerManager } = createServices(options);
  const schema = initializeSpreadsheetSchema(spreadsheet, options.schemaOptions);
  const intervalMinutes = configuredInterval(configurationService);
  const schedule = triggerManager.ensureTrigger(intervalMinutes);
  return { ...schema, schedule };
}

/**
 * Validates and persists a new cadence, then replaces the tracker trigger only
 * when the stored interval changed. The caller must be an authorized admin.
 */
export function configureSchedule(intervalMinutes, options = {}) {
  const { configurationService, triggerManager } = createServices(options);
  const normalizedInterval = validateScheduleIntervalMinutes(intervalMinutes);
  const saved = configurationService.saveConfiguration({
    [CONFIGURATION_KEY.SCHEDULE_INTERVAL_MINUTES]: normalizedInterval
  }, { updatedBy: options.updatedBy });
  const schedule = saved.changed
    ? triggerManager.replaceTrigger(normalizedInterval)
    : triggerManager.ensureTrigger(normalizedInterval);
  return { ...saved, schedule };
}

export const TRIGGER_MANAGER_METADATA = Object.freeze({
  SCHEDULED_PROCESSING_HANDLER,
  SUPPORTED_SCHEDULE_INTERVAL_MINUTES
});
