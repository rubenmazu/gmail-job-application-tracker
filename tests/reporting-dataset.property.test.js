import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUS, CLASSIFICATION, UNAVAILABLE } from '../src/core/domain-constants.js';
import { projectReportingDataset } from '../src/services/reporting-dataset.js';

const NOW = new Date('2031-01-01T00:00:00.000Z');
const STATUSES = Object.values(APPLICATION_STATUS);
const RESPONSE_CLASSIFICATIONS = new Set([
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.OFFER
]);
const timestampArbitrary = fc.date({
  min: new Date('2020-01-01T00:00:00.000Z'),
  max: new Date('2030-12-31T23:59:59.999Z')
}).map((date) => date.toISOString());
const valueArbitrary = fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null });

function dateOnly(value) { return value ? new Date(value).toISOString().slice(0, 10) : null; }

function weekStart(day) {
  if (!day) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function referenceRow(application, history, companyRank) {
  const events = history.filter(({ application_id }) => application_id === application.application_id)
    .sort((left, right) => new Date(left.changed_at) - new Date(right.changed_at) || left.event_key.localeCompare(right.event_key));
  const first = (predicate, fallback) => events.find(predicate)?.changed_at ?? fallback ?? null;
  const appliedAt = first(({ new_status }) => new_status === APPLICATION_STATUS.APPLIED, application.applied_at);
  const firstResponseAt = first(({ classification }) => RESPONSE_CLASSIFICATIONS.has(classification), application.first_response_at);
  const interviewAt = first(({ new_status }) => new_status === APPLICATION_STATUS.INTERVIEW, application.interview_at);
  const rejectedAt = first(({ new_status }) => new_status === APPLICATION_STATUS.REJECTED, application.rejected_at);
  const offerAt = first(({ new_status }) => new_status === APPLICATION_STATUS.OFFER, application.offer_at);
  const applicationDay = dateOnly(application.application_date);
  return {
    application_id: application.application_id,
    current_status: events.at(-1)?.new_status ?? application.current_status,
    role: application.role ?? UNAVAILABLE,
    company: application.company ?? UNAVAILABLE,
    application_date: application.application_date ?? UNAVAILABLE,
    platform: application.platform ?? UNAVAILABLE,
    location: application.location ?? UNAVAILABLE,
    applied_at: appliedAt,
    first_response_at: firstResponseAt,
    interview_at: interviewAt,
    rejected_at: rejectedAt,
    offer_at: offerAt,
    last_status_changed_at: events.at(-1)?.changed_at ?? application.last_status_changed_at ?? null,
    application_day: applicationDay,
    application_week_start: weekStart(applicationDay),
    application_month: applicationDay?.slice(0, 7) ?? null,
    has_response: firstResponseAt !== null,
    reached_interview: interviewAt !== null,
    reached_offer: offerAt !== null,
    elapsed_to_first_response_hours: appliedAt && firstResponseAt
      ? (new Date(firstResponseAt) - new Date(appliedAt)) / 3_600_000 : null,
    company_application_rank: companyRank,
    dataset_updated_at: NOW.toISOString()
  };
}

const applicationArbitrary = fc.record({
  application_id: fc.uuid(), current_status: fc.constantFrom(...STATUSES),
  role: valueArbitrary, company: valueArbitrary, platform: valueArbitrary, location: valueArbitrary,
  application_date: fc.option(timestampArbitrary, { nil: null }), applied_at: fc.option(timestampArbitrary, { nil: null }),
  first_response_at: fc.option(timestampArbitrary, { nil: null }), interview_at: fc.option(timestampArbitrary, { nil: null }),
  rejected_at: fc.option(timestampArbitrary, { nil: null }), offer_at: fc.option(timestampArbitrary, { nil: null }),
  last_status_changed_at: fc.option(timestampArbitrary, { nil: null })
});

const scenarioArbitrary = fc.uniqueArray(applicationArbitrary, {
  selector: ({ application_id }) => application_id, maxLength: 12
}).chain((applications) => {
  if (applications.length === 0) return fc.constant({ applications, history: [] });
  return fc.array(fc.record({
    application_id: fc.constantFrom(...applications.map(({ application_id }) => application_id)),
    new_status: fc.constantFrom(...STATUSES),
    classification: fc.constantFrom(...Object.values(CLASSIFICATION)),
    changed_at: timestampArbitrary, event_key: fc.uuid()
  }), { maxLength: 40 }).map((history) => ({ applications, history }));
});

describe('Property 10: Reporting is a faithful one-row projection', () => {
  // Feature: gmail-job-application-tracker, Property 10: Reporting is a faithful one-row projection
  // Validates: Requirements 8.1, 8.3, 8.4
  it('projects every application into one faithful reporting row', () => {
    fc.assert(fc.property(scenarioArbitrary, ({ applications, history }) => {
      const projected = projectReportingDataset(applications, history, { now: NOW });
      const companyCounts = new Map();
      for (const application of applications) {
        const company = String(application.company ?? UNAVAILABLE);
        companyCounts.set(company, (companyCounts.get(company) ?? 0) + 1);
      }
      const countRanks = [...new Set(companyCounts.values())].sort((left, right) => right - left);
      const expected = applications.map((application) => referenceRow(
        application,
        history,
        countRanks.indexOf(companyCounts.get(String(application.company ?? UNAVAILABLE))) + 1
      ));

      expect(projected).toHaveLength(applications.length);
      expect(new Set(projected.map(({ application_id }) => application_id)).size).toBe(applications.length);
      expect(projected).toEqual(expected);
    }), { numRuns: 100 });
  });
});