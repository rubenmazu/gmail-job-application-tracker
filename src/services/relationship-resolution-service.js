import {
  CLASSIFICATION,
  RELATIONSHIP_RESOLUTION,
  SHEET_NAMES
} from '../core/domain-constants.js';
import { ApplicationStateMachine } from '../core/application-state-machine.js';
import { ReportingDatasetService } from './reporting-dataset.js';

const FOLLOW_UP_CLASSIFICATIONS = new Set([
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.OFFER
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredIdentifier(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new TypeError(`resolveRelationship requires "${field}".`);
  }
  return String(value);
}

function defaultNow() {
  return new Date();
}

function defaultResolvedBy() {
  if (typeof Session !== 'undefined' && typeof Session.getActiveUser === 'function') {
    return Session.getActiveUser().getEmail() || null;
  }
  return null;
}

function resolutionInput(input) {
  if (!isRecord(input)) throw new TypeError('resolveRelationship requires an input record.');
  const applicationId = input.application_id ?? input.applicationId;
  if (Array.isArray(applicationId)) {
    throw new TypeError('resolveRelationship must link exactly one application_id.');
  }
  return {
    gmailMessageId: requiredIdentifier(input.gmail_message_id ?? input.gmailMessageId ?? input.message_id ?? input.messageId,
      'gmail_message_id'),
    applicationId: requiredIdentifier(applicationId, 'application_id'),
    resolvedBy: input.resolved_by ?? input.resolvedBy ?? null,
    runId: input.run_id ?? input.runId ?? null
  };
}

function exactlyOneException(exceptions, messageId) {
  const matching = exceptions.filter((exception) => String(exception.gmail_message_id) === messageId);
  if (matching.length === 0) throw new Error(`No relationship exception exists for message "${messageId}".`);
  if (matching.length > 1) throw new Error(`Multiple relationship exceptions exist for message "${messageId}".`);
  return matching[0];
}

function sourceMessageFrom(exception, ledgerRecord, messageId) {
  if (!FOLLOW_UP_CLASSIFICATIONS.has(exception.classification)) {
    throw new TypeError(`Relationship exception "${exception.exception_id}" cannot produce a status transition.`);
  }
  return {
    gmail_message_id: messageId,
    received_at: ledgerRecord?.received_at ?? undefined,
    classification: exception.classification
  };
}

/**
 * Manually resolves one pending relationship exception. The state machine's
 * status:<source_message_id>:<target_status> event key makes the transition
 * replay-safe; the reporting rebuild is intentionally repeated on a replay.
 */
export class RelationshipResolutionService {
  constructor(repository, options = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    if (typeof options.now !== 'function' && options.now !== undefined) throw new TypeError('now must be a function.');
    if (typeof options.resolvedBy !== 'function' && options.resolvedBy !== undefined) {
      throw new TypeError('resolvedBy must be a function.');
    }
    this.repository = repository;
    this.now = options.now ?? defaultNow;
    this.resolvedBy = options.resolvedBy ?? defaultResolvedBy;
    this.stateMachine = options.stateMachine ?? new ApplicationStateMachine(repository, {
      now: this.now,
      createId: options.createId
    });
    this.reporting = options.reporting ?? new ReportingDatasetService(repository, { now: this.now });
    if (typeof this.stateMachine.applyFollowUp !== 'function') {
      throw new TypeError('stateMachine must provide applyFollowUp.');
    }
    if (typeof this.reporting.rebuildAndUpsert !== 'function') {
      throw new TypeError('reporting must provide rebuildAndUpsert.');
    }
  }

  resolveRelationship(input) {
    const request = resolutionInput(input);
    const exceptions = this.repository.readTable(SHEET_NAMES.RELATIONSHIP_EXCEPTIONS).records;
    const exception = exactlyOneException(exceptions, request.gmailMessageId);
    const ledgerRecord = this.repository.readTable(SHEET_NAMES.PROCESSED_MESSAGES).indexes.gmail_message_id
      .get(request.gmailMessageId)?.[0] ?? null;

    if (exception.resolution !== RELATIONSHIP_RESOLUTION.PENDING &&
        exception.resolution !== RELATIONSHIP_RESOLUTION.LINKED) {
      throw new Error(`Relationship exception "${exception.exception_id}" is already ignored.`);
    }
    if (exception.resolution === RELATIONSHIP_RESOLUTION.LINKED &&
        String(exception.resolved_application_id) !== request.applicationId) {
      throw new Error(`Relationship exception "${exception.exception_id}" is already linked to another application.`);
    }

    const transition = this.stateMachine.applyFollowUp(sourceMessageFrom(exception, ledgerRecord, request.gmailMessageId), {
      applicationId: request.applicationId,
      runId: request.runId
    });
    const resolvedAt = exception.resolved_at ?? this.now().toISOString();
    const resolvedBy = exception.resolved_by ?? request.resolvedBy ?? this.resolvedBy();
    const resolvedException = {
      ...exception,
      resolution: RELATIONSHIP_RESOLUTION.LINKED,
      resolved_application_id: request.applicationId,
      resolved_at: resolvedAt,
      resolved_by: resolvedBy
    };
    this.repository.upsert(SHEET_NAMES.RELATIONSHIP_EXCEPTIONS, [resolvedException]);
    const reporting = this.reporting.rebuildAndUpsert();
    return Object.freeze({ exception: resolvedException, transition, reporting });
  }
}

export const RELATIONSHIP_RESOLUTION_METADATA = Object.freeze({
  FOLLOW_UP_CLASSIFICATIONS: [...FOLLOW_UP_CLASSIFICATIONS]
});