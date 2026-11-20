// Apps Script entry bundle.
import { SheetsRepository, SHEETS_REPOSITORY_METADATA } from './adapters/sheets-repository.js';
import { QuotaPersistenceAdapter } from './adapters/quota-persistence-adapter.js';
import { ProcessedMessageLedger } from './core/processed-message-ledger.js';
import { ApplicationStateMachine } from './core/application-state-machine.js';
import { GeminiClient } from './services/gemini-client.js';
import { GmailIncrementalReader, IncrementalProcessingScheduler } from './services/gmail-incremental-reader.js';
import { ReportingDatasetService } from './services/reporting-dataset.js';
import { ScheduledProcessingCoordinator } from './services/scheduled-processing-coordinator.js';
import { RelationshipResolutionService } from './services/relationship-resolution-service.js';
import {
  ConfigurationService,
  CONFIGURATION_SERVICE_METADATA,
  createAppsScriptGeminiAdministration,
  GEMINI_API_KEY_PROPERTY,
  GEMINI_PRIVACY_NOTICE,
  GeminiConfigurationAdministration,
  getGeminiSubmissionAuthorization,
  assertGeminiSubmissionAuthorized
} from './services/configuration-service.js';

function activeSpreadsheetRepository() {
  if (typeof SpreadsheetApp === 'undefined' || typeof SpreadsheetApp.getActiveSpreadsheet !== 'function') {
    throw new Error('An active Google Spreadsheet is required for tracker administration.');
  }
  return new SheetsRepository(SpreadsheetApp.getActiveSpreadsheet());
}

function geminiAdministration() {
  return createAppsScriptGeminiAdministration(activeSpreadsheetRepository());
}

function relationshipResolutionAdministration() {
  return new RelationshipResolutionService(activeSpreadsheetRepository());
}

function scheduledProcessingCoordinator() {
  const repository = activeSpreadsheetRepository();
  const ledger = new ProcessedMessageLedger(repository, {
    // The coordinator holds the script-wide lock for the entire run, so ledger
    // mutations execute under that same global critical section.
    lock: { execute: (operation) => operation() }
  });
  const quotaPersistence = new QuotaPersistenceAdapter(repository);
  return new ScheduledProcessingCoordinator({
    repository,
    scheduler: new IncrementalProcessingScheduler(repository, new GmailIncrementalReader()),
    ledger,
    quotaPersistence,
    gemini: new GeminiClient({ ledger, quotaPersistence, configuration: quotaPersistence }),
    domain: new ApplicationStateMachine(repository),
    reporting: new ReportingDatasetService(repository)
  });
}

/** Runs the single lock-protected scheduled Gmail processing cycle. */
export function runScheduledProcessing() {
  return scheduledProcessingCoordinator().runScheduledProcessing();
}

/** Manually links one unresolved follow-up and applies its replay-safe status transition. */
export function resolveRelationship(input) {
  return relationshipResolutionAdministration().resolveRelationship(input);
}

/** Saves Gemini model/free-tier settings and stores apiKey solely in Script Properties. */
export function saveGeminiConfiguration(input) {
  return geminiAdministration().saveGeminiConfiguration(input);
}

/** Returns the versioned notice that must be displayed before acknowledgement. */
export function getGeminiPrivacyNotice() {
  return GEMINI_PRIVACY_NOTICE;
}

/** Records acknowledgement of the currently displayed privacy notice and enables Gemini processing. */
export function recordAcknowledgement(input) {
  return geminiAdministration().recordAcknowledgement(input);
}

/** Records withdrawal and immediately disables all Gemini message-content submissions. */
export function withdrawAcknowledgement() {
  return geminiAdministration().withdrawAcknowledgement();
}

// Apps Script invokes top-level global functions from the bundled file.
if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    runScheduledProcessing,
    resolveRelationship,
    saveGeminiConfiguration,
    getGeminiPrivacyNotice,
    recordAcknowledgement,
    withdrawAcknowledgement
  });
}
export { SheetsRepository, SHEETS_REPOSITORY_METADATA } from './adapters/sheets-repository.js';
export { QuotaPersistenceAdapter, QUOTA_USAGE_CONFIGURATION_KEY } from './adapters/quota-persistence-adapter.js';
export {
  QUOTA_GUARD_CONSTANTS, QUOTA_NAME, canStart, estimateGeminiRequest,
  estimateGmailRead, estimateOperation, estimateRuntime, estimateSheetsWrite,
  isRetryEligible, quotaLimitsFromConfiguration, recordUsage, reserveQuota
} from './core/quota-guard.js';
export {
  ProcessedMessageLedger,
  createAppsScriptLedgerLock,
  NON_TERMINAL_PROCESSED_MESSAGE_STATES,
  PROCESSED_MESSAGE_LEDGER_DEFAULTS,
  TERMINAL_PROCESSED_MESSAGE_STATES
} from './core/processed-message-ledger.js';
export {
  ConfigurationService,
  CONFIGURATION_SERVICE_METADATA,
  createAppsScriptGeminiAdministration,
  GEMINI_API_KEY_PROPERTY,
  GEMINI_PRIVACY_NOTICE,
  GeminiConfigurationAdministration,
  getGeminiSubmissionAuthorization,
  assertGeminiSubmissionAuthorized
};
export {
  createGeminiClassificationPayload,
  createGeminiGenerateContentRequest,
  GEMINI_CLASSIFICATION_JSON_SCHEMA,
  GEMINI_CLIENT_DEFAULTS,
  GeminiClient,
  GeminiClientError,
  parseGeminiClassificationResponse
} from './services/gemini-client.js';
export {
  buildIncrementalGmailQuery,
  compareMessageOrder,
  findContiguousTerminalCheckpoint,
  GMAIL_INCREMENTAL_READER_DEFAULTS,
  GmailIncrementalReader,
  IncrementalProcessingScheduler,
  isAfterCheckpoint,
  selectIncrementalCandidates
} from './services/gmail-incremental-reader.js';
export {
  configureSchedule,
  initializeTracker,
  ScheduledProcessingTriggerManager,
  SCHEDULED_PROCESSING_HANDLER,
  SUPPORTED_SCHEDULE_INTERVAL_MINUTES,
  TRIGGER_MANAGER_METADATA,
  validateScheduleIntervalMinutes
} from './services/trigger-manager.js';
export {
  extractGeminiDomainEffect,
  GEMINI_JOB_DATA_METADATA,
  normalizeGeminiJobData
} from './core/gemini-job-data.js';
export {
  APPLICATION_MATCHER_DEFAULTS,
  MATCH_DECISION,
  matchApplicationConfirmation,
  matchFollowUp,
  normalizeMatchingEvidence,
  normalizeMatchText,
  normalizeSenderDomain
} from './core/application-matcher.js';
export {
  ApplicationStateMachine,
  APPLICATION_STATE_MACHINE_METADATA
} from './core/application-state-machine.js';
export {
  RelationshipResolutionService,
  RELATIONSHIP_RESOLUTION_METADATA
} from './services/relationship-resolution-service.js';
export {
  ScheduledProcessingCoordinator,
  SCHEDULED_PROCESSING_COORDINATOR_DEFAULTS
} from './services/scheduled-processing-coordinator.js';
export {
  projectReportingDataset,
  ReportingDatasetService,
  REPORTING_DATASET_METADATA
} from './services/reporting-dataset.js';

// Apps Script invokes administrative functions and installable-trigger handlers
// by global name; retain module exports for local build and test usage.
import { configureSchedule, initializeTracker } from './services/trigger-manager.js';
if (typeof globalThis !== 'undefined') {
  globalThis.initializeTracker = initializeTracker;
  globalThis.configureSchedule = configureSchedule;
}
