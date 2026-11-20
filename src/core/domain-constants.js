export const UNAVAILABLE = 'Unavailable';

export const SHEET_NAMES = Object.freeze({
  APPLICATIONS: 'Applications', STATUS_HISTORY: 'Status_History', PROCESSED_MESSAGES: 'Processed_Messages',
  PROCESSING_CHECKPOINT: 'Processing_Checkpoint', CONFIGURATION: 'Configuration', CONFIGURATION_AUDIT: 'Configuration_Audit',
  PROCESSING_FAILURES: 'Processing_Failures', QUOTA_DEFERRALS: 'Quota_Deferrals',
  RELATIONSHIP_EXCEPTIONS: 'Relationship_Exceptions', REPORTING_DATASET: 'Reporting_Dataset'
});

export const APPLICATION_STATUS = Object.freeze({ APPLIED: 'Applied', INTERVIEW: 'Interview', REJECTED: 'Rejected', OFFER: 'Offer' });
export const CLASSIFICATION = Object.freeze({ APPLICATION_CONFIRMATION: 'Application_Confirmation', REJECTION: 'Rejection', INTERVIEW_OR_TEST: 'Interview_or_Test', OFFER: 'Offer', IRRELEVANT: 'Irrelevant' });
export const PROCESSED_MESSAGE_STATE = Object.freeze({ IN_PROGRESS: 'IN_PROGRESS', CLASSIFIED: 'CLASSIFIED', COMPLETED: 'COMPLETED', RETRYABLE_FAILURE: 'RETRYABLE_FAILURE', DEFERRED: 'DEFERRED', UNRESOLVED: 'UNRESOLVED' });
export const QUOTA_OPERATION = Object.freeze({ GMAIL_READ: 'gmail_read', SHEETS_WRITE: 'sheets_write', RUN: 'run', GEMINI_REQUEST: 'gemini_request' });
export const RELATIONSHIP_EXCEPTION_REASON = Object.freeze({ NO_CANDIDATE: 'NO_CANDIDATE', MULTIPLE_CANDIDATES: 'MULTIPLE_CANDIDATES', WEAK_MATCH: 'WEAK_MATCH' });
export const RELATIONSHIP_RESOLUTION = Object.freeze({ PENDING: 'PENDING', LINKED: 'LINKED', IGNORED: 'IGNORED' });

export const APPLICATION_HEADERS = Object.freeze(['application_id', 'dedup_key', 'initial_message_id', 'initial_thread_id', 'role', 'company', 'application_date', 'platform', 'location', 'role_normalized', 'company_normalized', 'sender_domain_normalized', 'current_status', 'applied_at', 'first_response_at', 'interview_at', 'rejected_at', 'offer_at', 'last_status_changed_at', 'created_at', 'updated_at', 'last_message_id']);
export const STATUS_HISTORY_HEADERS = Object.freeze(['history_id', 'event_key', 'application_id', 'source_message_id', 'previous_status', 'new_status', 'classification', 'changed_at', 'run_id']);
export const PROCESSED_MESSAGE_HEADERS = Object.freeze(['gmail_message_id', 'gmail_thread_id', 'received_at', 'run_id', 'state', 'lease_expires_at', 'attempt_count', 'next_attempt_at', 'classification', 'classification_json', 'classification_hash', 'application_id', 'outcome', 'completed_at', 'last_error_id']);
export const PROCESSING_CHECKPOINT_HEADERS = Object.freeze(['checkpoint_id', 'last_completed_received_at', 'last_completed_message_id', 'updated_at', 'last_run_id']);
export const CONFIGURATION_HEADERS = Object.freeze(['config_key', 'config_value', 'updated_at']);
export const CONFIGURATION_AUDIT_HEADERS = Object.freeze(['audit_id', 'config_key', 'previous_value', 'new_value', 'version', 'updated_by', 'updated_at']);
export const PROCESSING_FAILURE_HEADERS = Object.freeze(['failure_id', 'run_id', 'gmail_message_id', 'stage', 'reason_code', 'reason_detail_redacted', 'occurred_at', 'retryable', 'attempt_count']);
export const QUOTA_DEFERRAL_HEADERS = Object.freeze(['deferral_id', 'run_id', 'gmail_message_id', 'operation', 'quota_name', 'estimated_units', 'observed_units', 'deferred_at', 'eligible_after', 'reason', 'resolved_at']);
export const RELATIONSHIP_EXCEPTION_HEADERS = Object.freeze(['exception_id', 'gmail_message_id', 'classification', 'candidate_application_ids', 'evidence_summary', 'reason', 'created_at', 'resolution', 'resolved_application_id', 'resolved_at', 'resolved_by']);
export const REPORTING_DATASET_HEADERS = Object.freeze(['application_id', 'current_status', 'role', 'company', 'application_date', 'platform', 'location', 'applied_at', 'first_response_at', 'interview_at', 'rejected_at', 'offer_at', 'last_status_changed_at', 'application_day', 'application_week_start', 'application_month', 'has_response', 'reached_interview', 'reached_offer', 'elapsed_to_first_response_hours', 'company_application_rank', 'dataset_updated_at']);

export const CONFIGURATION_KEY = Object.freeze({
  SCHEDULE_INTERVAL_MINUTES: 'schedule_interval_minutes',
  MAX_MESSAGES_PER_RUN: 'max_messages_per_run',
  OVERLAP_MINUTES: 'overlap_minutes',
  GEMINI_ENABLED: 'gemini_enabled',
  GEMINI_MODEL_ID: 'gemini_model_id',
  GEMINI_MODEL_VERIFIED_AT: 'gemini_model_verified_at',
  GEMINI_FREE_TIER_RPM: 'gemini_free_tier_rpm',
  GEMINI_FREE_TIER_TPM: 'gemini_free_tier_tpm',
  GEMINI_FREE_TIER_RPD: 'gemini_free_tier_rpd',
  GEMINI_FREE_TIER_DAILY_RESET_REFERENCE: 'gemini_free_tier_daily_reset_reference',
  GEMINI_INPUT_CHAR_LIMIT: 'gemini_input_char_limit',
  EXECUTION_QUOTA_GMAIL_READS: 'execution_quota_gmail_reads',
  EXECUTION_QUOTA_SHEET_WRITES: 'execution_quota_sheet_writes',
  EXECUTION_QUOTA_RUNTIME_MINUTES: 'execution_quota_runtime_minutes',
  EXECUTION_QUOTA_VERIFIED_AT: 'execution_quota_verified_at',
  MAX_RETRIES_PER_RUN: 'max_retries_per_run',
  RETRY_INITIAL_BACKOFF_SECONDS: 'retry_initial_backoff_seconds',
  RETRY_MAX_BACKOFF_SECONDS: 'retry_max_backoff_seconds',
  PRIVACY_NOTICE_VERSION: 'privacy_notice_version',
  PRIVACY_ACKNOWLEDGED_AT: 'privacy_acknowledged_at',
  PRIVACY_ACKNOWLEDGED_BY: 'privacy_acknowledged_by',
  PRIVACY_WITHDRAWN_AT: 'privacy_withdrawn_at',
  CONFIG_UPDATED_AT: 'config_updated_at'
});
export const DEFAULT_CONFIGURATION = Object.freeze({ [CONFIGURATION_KEY.SCHEDULE_INTERVAL_MINUTES]: 60, [CONFIGURATION_KEY.OVERLAP_MINUTES]: 120 });

export const SHEET_HEADERS = Object.freeze({
  [SHEET_NAMES.APPLICATIONS]: APPLICATION_HEADERS, [SHEET_NAMES.STATUS_HISTORY]: STATUS_HISTORY_HEADERS,
  [SHEET_NAMES.PROCESSED_MESSAGES]: PROCESSED_MESSAGE_HEADERS, [SHEET_NAMES.PROCESSING_CHECKPOINT]: PROCESSING_CHECKPOINT_HEADERS,
  [SHEET_NAMES.CONFIGURATION]: CONFIGURATION_HEADERS, [SHEET_NAMES.CONFIGURATION_AUDIT]: CONFIGURATION_AUDIT_HEADERS,
  [SHEET_NAMES.PROCESSING_FAILURES]: PROCESSING_FAILURE_HEADERS, [SHEET_NAMES.QUOTA_DEFERRALS]: QUOTA_DEFERRAL_HEADERS,
  [SHEET_NAMES.RELATIONSHIP_EXCEPTIONS]: RELATIONSHIP_EXCEPTION_HEADERS, [SHEET_NAMES.REPORTING_DATASET]: REPORTING_DATASET_HEADERS
});

export const SHEET_ORDER = Object.freeze(Object.keys(SHEET_HEADERS));
