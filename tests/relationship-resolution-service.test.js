import { describe, expect, it } from 'vitest';
import { RelationshipResolutionService } from '../src/services/relationship-resolution-service.js';
import {
  APPLICATION_STATUS,
  CLASSIFICATION,
  PROCESSED_MESSAGE_STATE,
  RELATIONSHIP_RESOLUTION,
  SHEET_NAMES
} from '../src/core/domain-constants.js';

const PRIMARY_KEYS = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: 'application_id',
  [SHEET_NAMES.STATUS_HISTORY]: 'event_key',
  [SHEET_NAMES.PROCESSED_MESSAGES]: 'gmail_message_id',
  [SHEET_NAMES.RELATIONSHIP_EXCEPTIONS]: 'exception_id',
  [SHEET_NAMES.REPORTING_DATASET]: 'application_id'
});

class InMemoryRepository {
  constructor(recordsBySheet) {
    this.recordsBySheet = Object.fromEntries(Object.entries(recordsBySheet)
      .map(([sheetName, records]) => [sheetName, records.map((record) => ({ ...record }))]));
  }

  readTable(sheetName) {
    const records = this.recordsBySheet[sheetName] ?? [];
    const gmailIndex = new Map();
    for (const record of records) {
      if (record.gmail_message_id) gmailIndex.set(String(record.gmail_message_id), [record]);
    }
    return { records, indexes: { gmail_message_id: gmailIndex } };
  }

  upsert(sheetName, patches) {
    const key = PRIMARY_KEYS[sheetName];
    const records = this.recordsBySheet[sheetName] ?? (this.recordsBySheet[sheetName] = []);
    for (const patch of patches) {
      const index = records.findIndex((record) => String(record[key]) === String(patch[key]));
      if (index === -1) records.push({ ...patch });
      else records[index] = { ...records[index], ...patch };
    }
    return { records };
  }
}

describe('RelationshipResolutionService', () => {
  it('links one pending exception, transitions once by source message, and refreshes reporting on replay', () => {
    const now = () => new Date('2025-02-03T10:00:00.000Z');
    const repository = new InMemoryRepository({
      [SHEET_NAMES.APPLICATIONS]: [{
        application_id: 'application-1', current_status: APPLICATION_STATUS.APPLIED,
        role: 'Engineer', company: 'Example', application_date: '2025-01-01', platform: 'LinkedIn', location: 'Remote',
        applied_at: '2025-01-01T09:00:00.000Z', last_status_changed_at: '2025-01-01T09:00:00.000Z'
      }],
      [SHEET_NAMES.STATUS_HISTORY]: [{
        history_id: 'history-applied', event_key: 'status:initial-message:Applied', application_id: 'application-1',
        source_message_id: 'initial-message', previous_status: null, new_status: APPLICATION_STATUS.APPLIED,
        classification: CLASSIFICATION.APPLICATION_CONFIRMATION, changed_at: '2025-01-01T09:00:00.000Z', run_id: 'run-initial'
      }],
      [SHEET_NAMES.PROCESSED_MESSAGES]: [{
        gmail_message_id: 'follow-up-message', received_at: '2025-02-01T12:00:00.000Z',
        state: PROCESSED_MESSAGE_STATE.UNRESOLVED
      }],
      [SHEET_NAMES.RELATIONSHIP_EXCEPTIONS]: [{
        exception_id: 'exception-1', gmail_message_id: 'follow-up-message', classification: CLASSIFICATION.INTERVIEW_OR_TEST,
        resolution: RELATIONSHIP_RESOLUTION.PENDING, resolved_application_id: null, resolved_at: null, resolved_by: null
      }],
      [SHEET_NAMES.REPORTING_DATASET]: []
    });
    const service = new RelationshipResolutionService(repository, {
      now,
      resolvedBy: () => 'admin@example.test',
      createId: () => 'history-interview'
    });

    service.resolveRelationship({ gmailMessageId: 'follow-up-message', applicationId: 'application-1', runId: 'run-manual' });
    service.resolveRelationship({ gmailMessageId: 'follow-up-message', applicationId: 'application-1', runId: 'run-manual' });

    const history = repository.readTable(SHEET_NAMES.STATUS_HISTORY).records;
    const application = repository.readTable(SHEET_NAMES.APPLICATIONS).records[0];
    const exception = repository.readTable(SHEET_NAMES.RELATIONSHIP_EXCEPTIONS).records[0];
    const reporting = repository.readTable(SHEET_NAMES.REPORTING_DATASET).records[0];
    expect(history).toHaveLength(2);
    expect(history.at(-1)).toMatchObject({
      event_key: 'status:follow-up-message:Interview', source_message_id: 'follow-up-message',
      previous_status: APPLICATION_STATUS.APPLIED, new_status: APPLICATION_STATUS.INTERVIEW
    });
    expect(application.current_status).toBe(APPLICATION_STATUS.INTERVIEW);
    expect(exception).toMatchObject({
      resolution: RELATIONSHIP_RESOLUTION.LINKED, resolved_application_id: 'application-1', resolved_by: 'admin@example.test'
    });
    expect(reporting).toMatchObject({ application_id: 'application-1', current_status: APPLICATION_STATUS.INTERVIEW });
  });
});