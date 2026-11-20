import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  SHEET_NAMES,
  UNAVAILABLE
} from '../core/domain-constants.js';

const VALID_STATUSES = new Set(Object.values(APPLICATION_STATUS));
const RESPONSE_CLASSIFICATIONS = new Set([
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.OFFER
]);

function isBlank(value) {
  return value === null || value === undefined || value === '' || value === UNAVAILABLE;
}

function requireApplicationId(value) {
  if (isBlank(value) || String(value).trim() === '') {
    throw new TypeError('Reporting projection requires every application to have an application_id.');
  }
  return String(value);
}

function asIsoTimestamp(value, field) {
  if (isBlank(value)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Reporting field "${field}" must be a valid timestamp.`);
  return date.toISOString();
}

function dateOnly(value) {
  const timestamp = asIsoTimestamp(value, 'application_date');
  return timestamp ? timestamp.slice(0, 10) : null;
}

function weekStart(day) {
  if (!day) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function earliest(events, predicate, fallback) {
  return events.find(predicate)?.changed_at ?? asIsoTimestamp(fallback, 'application timestamp');
}

function eventTimestamp(event) {
  return new Date(event.changed_at).getTime();
}

function orderedApplicationHistory(history, applicationId) {
  return history
    .filter((event) => String(event.application_id) === applicationId && VALID_STATUSES.has(event.new_status))
    .map((event) => ({ ...event, changed_at: asIsoTimestamp(event.changed_at, 'Status_History.changed_at') }))
    .sort((left, right) => eventTimestamp(left) - eventTimestamp(right) ||
      String(left.event_key ?? '').localeCompare(String(right.event_key ?? '')));
}

function applicationTimestamps(application, history) {
  const appliedAt = earliest(history, (event) => event.new_status === APPLICATION_STATUS.APPLIED, application.applied_at);
  const firstResponseAt = earliest(history, (event) => RESPONSE_CLASSIFICATIONS.has(event.classification), application.first_response_at);
  const interviewAt = earliest(history, (event) => event.new_status === APPLICATION_STATUS.INTERVIEW, application.interview_at);
  const rejectedAt = earliest(history, (event) => event.new_status === APPLICATION_STATUS.REJECTED, application.rejected_at);
  const offerAt = earliest(history, (event) => event.new_status === APPLICATION_STATUS.OFFER, application.offer_at);
  const latest = history.at(-1);
  return {
    applied_at: appliedAt,
    first_response_at: firstResponseAt,
    interview_at: interviewAt,
    rejected_at: rejectedAt,
    offer_at: offerAt,
    current_status: latest?.new_status ?? application.current_status,
    last_status_changed_at: latest?.changed_at ?? asIsoTimestamp(application.last_status_changed_at, 'last_status_changed_at')
  };
}

function elapsedHours(appliedAt, firstResponseAt) {
  if (!appliedAt || !firstResponseAt) return null;
  return (new Date(firstResponseAt).getTime() - new Date(appliedAt).getTime()) / 3_600_000;
}

function companyRanks(rows) {
  const counts = new Map();
  for (const row of rows) {
    const company = String(row.company ?? UNAVAILABLE);
    counts.set(company, (counts.get(company) ?? 0) + 1);
  }
  const distinctCounts = [...new Set(counts.values())].sort((left, right) => right - left);
  const rankByCompany = new Map([...counts.entries()].map(([company, count]) => [company, distinctCounts.indexOf(count) + 1]));
  return rows.map((row) => ({ ...row, company_application_rank: rankByCompany.get(String(row.company ?? UNAVAILABLE)) }));
}

/**
 * Builds the Looker-facing, one-row-per-application projection. Timestamps
 * from Status_History take precedence over denormalized application values so
 * recovery runs cannot leave stale reporting flags or funnel milestones.
 */
export function projectReportingDataset(applications, statusHistory, { now = new Date() } = {}) {
  if (!Array.isArray(applications) || !Array.isArray(statusHistory)) {
    throw new TypeError('Reporting projection requires application and status-history arrays.');
  }
  const datasetUpdatedAt = asIsoTimestamp(now, 'dataset_updated_at');
  const seenApplicationIds = new Set();
  const rows = applications.map((application) => {
    if (!application || typeof application !== 'object' || Array.isArray(application)) {
      throw new TypeError('Every reporting application must be a record.');
    }
    const applicationId = requireApplicationId(application.application_id);
    if (seenApplicationIds.has(applicationId)) {
      throw new Error(`Duplicate application_id "${applicationId}" cannot be projected into Reporting_Dataset.`);
    }
    seenApplicationIds.add(applicationId);

    const history = orderedApplicationHistory(statusHistory, applicationId);
    const timestamps = applicationTimestamps(application, history);
    const applicationDay = dateOnly(application.application_date);
    const hasResponse = timestamps.first_response_at !== null;
    return {
      application_id: applicationId,
      current_status: timestamps.current_status,
      role: application.role ?? UNAVAILABLE,
      company: application.company ?? UNAVAILABLE,
      application_date: application.application_date ?? UNAVAILABLE,
      platform: application.platform ?? UNAVAILABLE,
      location: application.location ?? UNAVAILABLE,
      applied_at: timestamps.applied_at,
      first_response_at: timestamps.first_response_at,
      interview_at: timestamps.interview_at,
      rejected_at: timestamps.rejected_at,
      offer_at: timestamps.offer_at,
      last_status_changed_at: timestamps.last_status_changed_at,
      application_day: applicationDay,
      application_week_start: weekStart(applicationDay),
      application_month: applicationDay?.slice(0, 7) ?? null,
      has_response: hasResponse,
      reached_interview: timestamps.interview_at !== null,
      reached_offer: timestamps.offer_at !== null,
      elapsed_to_first_response_hours: elapsedHours(timestamps.applied_at, timestamps.first_response_at),
      company_application_rank: null,
      dataset_updated_at: datasetUpdatedAt
    };
  });
  return companyRanks(rows);
}

/** Rebuilds and batch-upserts Reporting_Dataset after application/history changes. */
export class ReportingDatasetService {
  constructor(repository, { now = () => new Date() } = {}) {
    if (!repository || typeof repository.readTable !== 'function' || typeof repository.upsert !== 'function') {
      throw new TypeError('A SheetsRepository-compatible repository is required.');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.repository = repository;
    this.now = now;
  }

  rebuildAndUpsert() {
    const applications = this.repository.readTable(SHEET_NAMES.APPLICATIONS).records;
    const statusHistory = this.repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
    const records = projectReportingDataset(applications, statusHistory, { now: this.now() });
    const result = this.repository.upsert(SHEET_NAMES.REPORTING_DATASET, records);
    return { ...result, records };
  }
}

export const REPORTING_DATASET_METADATA = Object.freeze({
  RESPONSE_CLASSIFICATIONS: [...RESPONSE_CLASSIFICATIONS]
});
