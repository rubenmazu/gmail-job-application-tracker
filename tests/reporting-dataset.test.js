import { describe, expect, it } from 'vitest';
import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  REPORTING_DATASET_HEADERS,
  SHEET_NAMES
} from '../src/core/domain-constants.js';
import {
  projectReportingDataset,
  ReportingDatasetService
} from '../src/services/reporting-dataset.js';

class InMemoryRepository {
  constructor(recordsBySheet) {
    this.recordsBySheet = Object.fromEntries(Object.entries(recordsBySheet)
      .map(([sheetName, records]) => [sheetName, records.map((record) => ({ ...record }))]));
  }

  readTable(sheetName) {
    return { records: this.recordsBySheet[sheetName] ?? [] };
  }

  upsert(sheetName, patches) {
    const records = this.recordsBySheet[sheetName] ?? (this.recordsBySheet[sheetName] = []);
    let inserted = 0;
    let updated = 0;
    for (const patch of patches) {
      const index = records.findIndex((record) => record.application_id === patch.application_id);
      if (index === -1) {
        records.push({ ...patch });
        inserted += 1;
      } else {
        records[index] = { ...records[index], ...patch };
        updated += 1;
      }
    }
    return { inserted, updated, records };
  }
}

const applications = [
  {
    application_id: 'app-1', current_status: APPLICATION_STATUS.APPLIED,
    role: 'Platform Engineer', company: 'Acme', application_date: '2025-01-02T12:00:00.000Z',
    platform: 'LinkedIn', location: 'Remote', applied_at: '2025-01-02T09:00:00.000Z'
  },
  {
    application_id: 'app-2', current_status: APPLICATION_STATUS.OFFER,
    role: 'Developer', company: 'Acme', application_date: '2025-01-06',
    platform: 'eJobs', location: 'Bucharest', applied_at: '2025-01-06T08:00:00.000Z'
  },
  {
    application_id: 'app-3', current_status: APPLICATION_STATUS.INTERVIEW,
    role: 'Analyst', company: 'Globex', application_date: '2025-02-01',
    platform: 'Direct', location: 'Cluj-Napoca', applied_at: '2025-02-01T10:00:00.000Z'
  }
];

const statusHistory = [
  { application_id: 'app-1', event_key: 'status:app-1:Applied', new_status: APPLICATION_STATUS.APPLIED, classification: CLASSIFICATION.APPLICATION_CONFIRMATION, changed_at: '2025-01-02T09:00:00.000Z' },
  { application_id: 'app-1', event_key: 'status:app-1:Interview', new_status: APPLICATION_STATUS.INTERVIEW, classification: CLASSIFICATION.INTERVIEW_OR_TEST, changed_at: '2025-01-04T09:30:00.000Z' },
  { application_id: 'app-2', event_key: 'status:app-2:Applied', new_status: APPLICATION_STATUS.APPLIED, classification: CLASSIFICATION.APPLICATION_CONFIRMATION, changed_at: '2025-01-06T08:00:00.000Z' },
  { application_id: 'app-2', event_key: 'status:app-2:Offer', new_status: APPLICATION_STATUS.OFFER, classification: CLASSIFICATION.OFFER, changed_at: '2025-01-10T08:00:00.000Z' },
  { application_id: 'app-3', event_key: 'status:app-3:Applied', new_status: APPLICATION_STATUS.APPLIED, classification: CLASSIFICATION.APPLICATION_CONFIRMATION, changed_at: '2025-02-01T10:00:00.000Z' }
];

describe('Reporting_Dataset', () => {
  it('projects the required reporting columns, dashboard filters, buckets, and dashboard measures', () => {
    const rows = projectReportingDataset(applications, statusHistory, { now: new Date('2025-02-03T10:00:00.000Z') });
    const interview = rows.find((row) => row.application_id === 'app-1');
    const offer = rows.find((row) => row.application_id === 'app-2');

    expect(rows).toHaveLength(3);
    expect(Object.keys(interview)).toEqual(REPORTING_DATASET_HEADERS);
    expect(interview).toMatchObject({
      current_status: APPLICATION_STATUS.INTERVIEW,
      role: 'Platform Engineer', company: 'Acme', application_date: '2025-01-02T12:00:00.000Z',
      platform: 'LinkedIn', location: 'Remote', application_day: '2025-01-02',
      application_week_start: '2024-12-30', application_month: '2025-01',
      has_response: true, reached_interview: true, reached_offer: false,
      elapsed_to_first_response_hours: 48.5, company_application_rank: 1,
      dataset_updated_at: '2025-02-03T10:00:00.000Z'
    });
    expect(offer).toMatchObject({
      current_status: APPLICATION_STATUS.OFFER, platform: 'eJobs', has_response: true,
      reached_interview: false, reached_offer: true, elapsed_to_first_response_hours: 96,
      company_application_rank: 1
    });
    expect(rows.find((row) => row.application_id === 'app-3')).toMatchObject({
      has_response: false, reached_interview: false, reached_offer: false,
      elapsed_to_first_response_hours: null, company_application_rank: 2
    });
  });

  it('upserts the reporting row after application and status-history changes', () => {
    const repository = new InMemoryRepository({
      [SHEET_NAMES.APPLICATIONS]: [applications[0]],
      [SHEET_NAMES.STATUS_HISTORY]: [statusHistory[0]],
      [SHEET_NAMES.REPORTING_DATASET]: []
    });
    const service = new ReportingDatasetService(repository, {
      now: () => new Date('2025-02-03T10:00:00.000Z')
    });

    expect(service.rebuildAndUpsert()).toMatchObject({ inserted: 1, updated: 0 });
    repository.recordsBySheet[SHEET_NAMES.APPLICATIONS][0].current_status = APPLICATION_STATUS.INTERVIEW;
    repository.recordsBySheet[SHEET_NAMES.STATUS_HISTORY].push(statusHistory[1]);

    expect(service.rebuildAndUpsert()).toMatchObject({ inserted: 0, updated: 1 });
    expect(repository.recordsBySheet[SHEET_NAMES.REPORTING_DATASET]).toEqual([
      expect.objectContaining({
        application_id: 'app-1', current_status: APPLICATION_STATUS.INTERVIEW,
        first_response_at: '2025-01-04T09:30:00.000Z', has_response: true,
        reached_interview: true, elapsed_to_first_response_hours: 48.5
      })
    ]);
  });
});
