import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  SHEET_NAMES,
  UNAVAILABLE
} from './domain-constants.js';
import { MATCH_DECISION, matchApplicationConfirmation, matchFollowUp, normalizeMatchingEvidence } from './application-matcher.js';
import { normalizeGeminiJobData } from './gemini-job-data.js';

const FOLLOW_UP_TARGET_STATUS = Object.freeze({
  [CLASSIFICATION.INTERVIEW_OR_TEST]: APPLICATION_STATUS.INTERVIEW,
  [CLASSIFICATION.REJECTION]: APPLICATION_STATUS.REJECTED,
  [CLASSIFICATION.OFFER]: APPLICATION_STATUS.OFFER
});
const DISPLAY_FIELDS = Object.freeze(['role', 'company', 'application_date', 'platform', 'location']);
const NORMALIZED_FIELDS = Object.freeze(['role_normalized', 'company_normalized', 'sender_domain_normalized']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBlank(value) {
  return value === null || value === undefined || value === '' || value === UNAVAILABLE;
}

function identifier(value, name) {
  if (value === null || value === undefined || String(value).trim() === '') throw new TypeError(`${name} is required.`);
  return String(value);
}

function asIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid timestamp.`);
  return date.toISOString();
}

function sourceMessageId(message) {
  return identifier(message?.gmail_message_id ?? message?.message_id, 'gmail_message_id');
}

function sourceThreadId(message) {
  const value = message?.gmail_thread_id ?? message?.thread_id;
  return value === null || value === undefined || String(value).trim() === '' ? null : String(value);
}

function displayData(message) {
  const source = message?.structuredJobData ?? message?.structured_job_data ?? message;
  if (!isRecord(source)) throw new TypeError('A structured job-data record is required.');
  return normalizeGeminiJobData({
    role: source.role,
    company: source.company,
    applicationDate: source.application_date ?? source.applicationDate,
    platform: source.platform,
    location: source.location
  });
}

function defaultCreateId() {
  if (typeof Utilities !== 'undefined' && typeof Utilities.getUuid === 'function') return Utilities.getUuid();
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  throw new Error('An application/history ID generator is required outside Google Apps Script.');
}

function eventKey(messageId, status) {
  return `status:${messageId}:${status}`;
}

function eventTime(message, now) {
  return asIso(message?.changed_at ?? message?.received_at ?? message?.receivedAt ?? now(), 'message timestamp');
}

function eventTimestamp(record) {
  const timestamp = new Date(record.changed_at).getTime();
  return Number.isNaN(timestamp) ? -Infinity : timestamp;
}

function orderedEvents(history, plannedEvent) {
  return [...history, ...(plannedEvent ? [plannedEvent] : [])]
    .filter((entry) => Object.values(APPLICATION_STATUS).includes(entry.new_status))
    .sort((left, right) => eventTimestamp(left) - eventTimestamp(right) ||
      String(left.event_key).localeCompare(String(right.event_key)));
}

function latestEventBefore(history, timestamp, key, fallbackStatus) {
  const point = new Date(timestamp).getTime();
  const earlier = history.filter((entry) => entry.event_key !== key && eventTimestamp(entry) <= point);
  const latest = orderedEvents(earlier).at(-1);
  return latest?.new_status ?? fallbackStatus;
}

function mergeMissing(existing, candidate) {
  const merged = { ...existing };
  for (const field of [...DISPLAY_FIELDS, ...NORMALIZED_FIELDS, 'dedup_key', 'initial_message_id', 'initial_thread_id']) {
    if (isBlank(merged[field]) && !isBlank(candidate[field])) merged[field] = candidate[field];
  }
  return merged;
}

function eventForApplication(applicationId, messageId, previousStatus, newStatus, classification, changedAt, runId, createId) {
  return {
    history_id: createId(),
    event_key: eventKey(messageId, newStatus),
    application_id: applicationId,
    source_message_id: messageId,
    previous_status: previousStatus,
    new_status: newStatus,
    classification,
    changed_at: changedAt,
    run_id: runId ?? null
  };
}

function applicationProjection(application, history, plannedEvent) {
  const applicationHistory = history.filter((entry) =>
    String(entry.application_id) === String(application.application_id));
  const events = orderedEvents(applicationHistory, plannedEvent);
  if (events.length === 0) return application;
  const projected = { ...application };
  const firstByStatus = (status) => events.find((entry) => entry.new_status === status)?.changed_at ?? null;
  const firstResponse = events.find((entry) => entry.classification !== CLASSIFICATION.APPLICATION_CONFIRMATION)?.changed_at ?? null;
  const latest = events.at(-1);
  projected.current_status = latest.new_status;
  projected.last_status_changed_at = latest.changed_at;
  projected.applied_at = firstByStatus(APPLICATION_STATUS.APPLIED) ?? projected.applied_at ?? null;
  projected.first_response_at = firstResponse ?? projected.first_response_at ?? null;
  projected.interview_at = firstByStatus(APPLICATION_STATUS.INTERVIEW) ?? projected.interview_at ?? null;
  projected.rejected_at = firstByStatus(APPLICATION_STATUS.REJECTED) ?? projected.rejected_at ?? null;
  projected.offer_at = firstByStatus(APPLICATION_STATUS.OFFER) ?? projected.offer_at ?? null;
  return projected;
}

function assertHistoryHasApplications(history, applications) {
  const applicationIds = new Set(applications.map((application) => String(application.application_id)));
  const orphan = history.find((entry) => !applicationIds.has(String(entry.application_id)));
  if (orphan) throw new Error(`Status history event "${orphan.event_key}" references a missing application.`);
}

function findByApplicationId(applications, applicationId) {
  return applications.find((application) => String(application.application_id) === String(applicationId)) ?? null;
}

function findEvent(history, key) {
  return history.find((entry) => entry.event_key === key) ?? null;
}

function unchangedResult(outcome, match) {
  return Object.freeze({ outcome, application: null, historyEvent: null, applicationCreated: false, historyCreated: false, match });
}

/**
 * Persists application domain effects with application-first writes and
 * event-key idempotency. A retry after an interrupted write recomputes the
 * same event and never writes a history row for a missing application.
 */
export class ApplicationStateMachine {
  constructor(repository, { now = () => new Date(), createId = defaultCreateId } = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    if (typeof now !== 'function' || typeof createId !== 'function') throw new TypeError('now and createId must be functions.');
    this.repository = repository;
    this.now = now;
    this.createId = createId;
  }

  _tables() {
    const applications = this.repository.readTable(SHEET_NAMES.APPLICATIONS).records;
    const history = this.repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
    assertHistoryHasApplications(history, applications);
    return { applications, history };
  }

  /** Creates a persistent Applied application or enriches a deterministic duplicate without status regression. */
  upsertConfirmation(message, { match, runId } = {}) {
    if (!isRecord(message) || message.classification !== CLASSIFICATION.APPLICATION_CONFIRMATION) {
      throw new TypeError('Confirmation upsert requires Application_Confirmation classification.');
    }
    const { applications, history } = this._tables();
    const decision = match ?? matchApplicationConfirmation(message, applications);
    if (decision.decision === MATCH_DECISION.UNRESOLVED) return unchangedResult('UNRESOLVED', decision);
    if (decision.decision !== MATCH_DECISION.CREATE && decision.decision !== MATCH_DECISION.MATCHED) {
      throw new TypeError('Confirmation match must be CREATE, MATCHED, or UNRESOLVED.');
    }

    const messageId = sourceMessageId(message);
    const changedAt = eventTime(message, this.now);
    const evidence = normalizeMatchingEvidence(message);
    const candidate = {
      dedup_key: message.dedup_key ?? null,
      initial_message_id: messageId,
      initial_thread_id: sourceThreadId(message),
      ...displayData(message),
      role_normalized: evidence.role,
      company_normalized: evidence.company,
      sender_domain_normalized: evidence.senderDomain
    };
    const existing = decision.decision === MATCH_DECISION.MATCHED
      ? findByApplicationId(applications, decision.applicationId) : null;
    if (decision.decision === MATCH_DECISION.MATCHED && !existing) throw new Error('Confirmation match references an application that no longer exists.');

    const applicationCreated = !existing;
    let application = applicationCreated ? {
      application_id: this.createId(), ...candidate,
      current_status: APPLICATION_STATUS.APPLIED,
      applied_at: changedAt, first_response_at: null, interview_at: null, rejected_at: null, offer_at: null,
      last_status_changed_at: changedAt, created_at: changedAt, updated_at: changedAt, last_message_id: messageId
    } : mergeMissing(existing, candidate);
    application = { ...application, updated_at: changedAt, last_message_id: messageId };
    const ownsInitialMessage = String(application.initial_message_id) === messageId;
    const key = eventKey(messageId, APPLICATION_STATUS.APPLIED);
    const existingEvent = findEvent(history, key);
    if (existingEvent && String(existingEvent.application_id) !== String(application.application_id)) {
      throw new Error(`Status event "${key}" belongs to another application.`);
    }
    if (ownsInitialMessage && !existingEvent) {
      const appliedEvent = eventForApplication(application.application_id, messageId, null, APPLICATION_STATUS.APPLIED,
        CLASSIFICATION.APPLICATION_CONFIRMATION, changedAt, runId, this.createId);
      application = applicationProjection(application, history, appliedEvent);
      this.repository.upsert(SHEET_NAMES.APPLICATIONS, [application]);
      this.repository.upsert(SHEET_NAMES.STATUS_HISTORY, [appliedEvent]);
      return Object.freeze({ outcome: applicationCreated ? 'CREATED' : 'RECOVERED', application, historyEvent: appliedEvent,
        applicationCreated, historyCreated: true, match: decision });
    }

    this.repository.upsert(SHEET_NAMES.APPLICATIONS, [application]);
    return Object.freeze({ outcome: applicationCreated ? 'CREATED' : 'UPDATED', application, historyEvent: existingEvent,
      applicationCreated, historyCreated: false, match: decision });
  }

  /** Applies one uniquely linked Interview, Rejected, or Offer event. Different messages may repeat the same target status. */
  applyFollowUp(message, { match, applicationId, runId } = {}) {
    const targetStatus = FOLLOW_UP_TARGET_STATUS[message?.classification];
    if (!isRecord(message) || !targetStatus) throw new TypeError('Follow-up requires Interview_or_Test, Rejection, or Offer classification.');
    const { applications, history } = this._tables();
    const decision = match ?? (applicationId ? { decision: MATCH_DECISION.MATCHED, applicationId } : matchFollowUp(message, applications));
    if (decision.decision === MATCH_DECISION.UNRESOLVED) return unchangedResult('UNRESOLVED', decision);
    const targetApplicationId = identifier(applicationId ?? decision.applicationId, 'application_id');
    const application = findByApplicationId(applications, targetApplicationId);
    if (!application) throw new Error('Follow-up match references an application that does not exist.');
    const messageId = sourceMessageId(message);
    const changedAt = eventTime(message, this.now);
    const key = eventKey(messageId, targetStatus);
    const existingEvent = findEvent(history, key);
    if (existingEvent && String(existingEvent.application_id) !== targetApplicationId) throw new Error(`Status event "${key}" belongs to another application.`);
    const previousStatus = existingEvent?.previous_status ?? latestEventBefore(history.filter((entry) =>
      String(entry.application_id) === targetApplicationId), changedAt, key, application.current_status);
    const plannedEvent = existingEvent ?? eventForApplication(targetApplicationId, messageId, previousStatus, targetStatus,
      message.classification, changedAt, runId, this.createId);
    const nextApplication = { ...applicationProjection(application, history, plannedEvent), updated_at: changedAt, last_message_id: messageId };
    this.repository.upsert(SHEET_NAMES.APPLICATIONS, [nextApplication]);
    if (!existingEvent) this.repository.upsert(SHEET_NAMES.STATUS_HISTORY, [plannedEvent]);
    return Object.freeze({ outcome: existingEvent ? 'REPLAYED' : 'TRANSITIONED', application: nextApplication,
      historyEvent: plannedEvent, applicationCreated: false, historyCreated: !existingEvent, match: decision });
  }

  /** Dispatches only resolved domain effects; ambiguous matching remains non-mutating. */
  apply(message, options = {}) {
    if (message?.classification === CLASSIFICATION.APPLICATION_CONFIRMATION) return this.upsertConfirmation(message, options);
    if (FOLLOW_UP_TARGET_STATUS[message?.classification]) return this.applyFollowUp(message, options);
    throw new TypeError('Application domain effects require a relevant confirmation or follow-up classification.');
  }
}

export const APPLICATION_STATE_MACHINE_METADATA = Object.freeze({ FOLLOW_UP_TARGET_STATUS, eventKey });
