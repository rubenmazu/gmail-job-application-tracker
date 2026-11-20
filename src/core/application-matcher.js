import {
  CLASSIFICATION,
  RELATIONSHIP_EXCEPTION_REASON
} from './domain-constants.js';

export const MATCH_DECISION = Object.freeze({
  MATCHED: 'MATCHED',
  CREATE: 'CREATE',
  UNRESOLVED: 'UNRESOLVED'
});

export const APPLICATION_MATCHER_DEFAULTS = Object.freeze({
  followUpThreshold: 6,
  temporalWindowDays: 90
});

const FOLLOW_UP_CLASSIFICATIONS = new Set([
  CLASSIFICATION.INTERVIEW_OR_TEST,
  CLASSIFICATION.REJECTION,
  CLASSIFICATION.OFFER
]);
const UNAVAILABLE_VALUES = new Set(['', 'unavailable']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value) {
  if (value === null || value === undefined || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !UNAVAILABLE_VALUES.has(trimmed.toLocaleLowerCase()) ? trimmed : null;
}

/** Normalizes human-readable matching fields without changing display fields. */
export function normalizeMatchText(value) {
  const text = asText(value);
  return text
    ? text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    : null;
}

/** Extracts a lower-case domain from a sender address or an already supplied domain. */
export function normalizeSenderDomain(value) {
  const text = asText(value);
  if (!text) return null;
  const address = text.match(/<\s*[^@\s<>]+@([^\s<>]+)\s*>/) ?? text.match(/@([^\s<>]+)/);
  const domain = (address?.[1] ?? text).replace(/[>,;]+$/g, '').trim().toLocaleLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain)
    ? domain
    : null;
}

function readField(record, field, aliases = []) {
  const structured = isRecord(record?.structuredJobData) ? record.structuredJobData
    : isRecord(record?.structured_job_data) ? record.structured_job_data : {};
  for (const key of [field, ...aliases]) {
    if (record?.[key] !== undefined && record[key] !== null) return record[key];
    if (structured[key] !== undefined && structured[key] !== null) return structured[key];
  }
  return null;
}

function normalizeDate(value) {
  const text = asText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function asIdentifierSet(record) {
  const values = [
    record?.quoted_identifiers, record?.quotedIdentifiers,
    record?.referenced_message_ids, record?.referencedMessageIds
  ].flatMap((value) => Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);
  return new Set(values.map((value) => asText(String(value))).filter(Boolean));
}

function applicationEvidence(application) {
  return Object.freeze({
    applicationId: asText(String(application?.application_id ?? '')),
    threadId: asText(String(application?.initial_thread_id ?? '')),
    messageId: asText(String(application?.initial_message_id ?? '')),
    dedupKey: asText(String(application?.dedup_key ?? '')),
    company: normalizeMatchText(application?.company_normalized) ?? normalizeMatchText(application?.company),
    role: normalizeMatchText(application?.role_normalized) ?? normalizeMatchText(application?.role),
    senderDomain: normalizeSenderDomain(application?.sender_domain_normalized) ?? normalizeSenderDomain(application?.sender_domain),
    platform: normalizeMatchText(application?.platform),
    applicationDate: normalizeDate(application?.application_date),
    appliedAt: normalizeDate(application?.applied_at)
  });
}

/** Produces only normalized, persistence-safe matching evidence; message bodies are never inspected or returned. */
export function normalizeMatchingEvidence(message) {
  if (!isRecord(message)) throw new TypeError('A message record is required for matching.');
  return Object.freeze({
    messageId: asText(String(message.gmail_message_id ?? message.message_id ?? '')),
    threadId: asText(String(message.gmail_thread_id ?? message.thread_id ?? '')),
    dedupKey: asText(String(message.dedup_key ?? '')),
    company: asText(message.company_normalized) ?? normalizeMatchText(readField(message, 'company')),
    role: asText(message.role_normalized) ?? normalizeMatchText(readField(message, 'role')),
    senderDomain: normalizeSenderDomain(message.sender_domain_normalized) ??
      normalizeSenderDomain(message.sender_domain ?? message.from ?? message.sender),
    platform: normalizeMatchText(readField(message, 'platform')),
    applicationDate: normalizeDate(readField(message, 'application_date', ['applicationDate'])),
    receivedAt: normalizeDate(message.received_at ?? message.receivedAt),
    quotedIdentifiers: Object.freeze([...asIdentifierSet(message)].sort())
  });
}

function compatible(left, right) {
  return !left || !right || left === right;
}

function same(left, right) {
  return Boolean(left && right && left === right);
}

function matchingIdentifier(message, application) {
  const identifiers = new Set(message.quotedIdentifiers);
  return [application.applicationId, application.threadId, application.messageId, application.dedupKey]
    .some((identifier) => identifier && identifiers.has(identifier));
}

function isTemporallyClose(message, application, windowDays) {
  if (!message.receivedAt || !application.appliedAt) return false;
  const difference = Math.abs(new Date(message.receivedAt).getTime() - new Date(application.appliedAt).getTime());
  return difference <= windowDays * 24 * 60 * 60 * 1000;
}

function validateOptions(options = {}) {
  const normalized = { ...APPLICATION_MATCHER_DEFAULTS, ...options };
  if (!Number.isFinite(normalized.followUpThreshold) || normalized.followUpThreshold <= 0) {
    throw new TypeError('followUpThreshold must be a positive finite number.');
  }
  if (!Number.isFinite(normalized.temporalWindowDays) || normalized.temporalWindowDays < 0) {
    throw new TypeError('temporalWindowDays must be a non-negative finite number.');
  }
  return normalized;
}

function ensureApplications(applications) {
  if (!Array.isArray(applications)) throw new TypeError('Applications must be an array.');
  return applications.map((application) => {
    if (!isRecord(application) || !asText(String(application.application_id ?? ''))) {
      throw new TypeError('Each application must have an application_id.');
    }
    return { application, evidence: applicationEvidence(application) };
  });
}

function evidenceSummary(strategy, details = {}) {
  const matches = Object.entries(details).filter(([, value]) => value === true).map(([key]) => key);
  return `${strategy}; matched=${matches.join(',') || 'none'}; score=${details.score ?? 'n/a'}; threshold=${details.threshold ?? 'n/a'}`;
}

function freezeOutcome(outcome) {
  return Object.freeze({
    ...outcome,
    candidateApplicationIds: Object.freeze([...(outcome.candidateApplicationIds ?? [])]),
    evidence: Object.freeze({ ...(outcome.evidence ?? {}) })
  });
}

function unresolved(message, classification, candidates, reason, evidence, summary) {
  return freezeOutcome({
    decision: MATCH_DECISION.UNRESOLVED,
    application: null,
    applicationId: null,
    candidateApplicationIds: candidates.map(({ evidence: candidate }) => candidate.applicationId).filter(Boolean),
    relationshipException: {
      gmail_message_id: message.messageId,
      classification,
      candidate_application_ids: candidates.map(({ evidence: candidate }) => candidate.applicationId).filter(Boolean),
      evidence_summary: summary,
      reason
    },
    evidence
  });
}

function matched(applicationEntry, strategy, evidence) {
  return freezeOutcome({
    decision: MATCH_DECISION.MATCHED,
    application: applicationEntry.application,
    applicationId: applicationEntry.evidence.applicationId,
    candidateApplicationIds: [applicationEntry.evidence.applicationId],
    matchedBy: strategy,
    relationshipException: null,
    evidence
  });
}

function scoreFollowUp(message, application, options) {
  const company = same(message.company, application.company);
  const role = same(message.role, application.role);
  const senderDomain = same(message.senderDomain, application.senderDomain);
  const platform = same(message.platform, application.platform);
  const temporalProximity = isTemporallyClose(message, application, options.temporalWindowDays);
  const quotedIdentifier = matchingIdentifier(message, application);
  const score = (company ? 4 : 0) + (role ? 3 : 0) + (senderDomain ? 2 : 0) +
    (platform ? 1 : 0) + (temporalProximity ? 1 : 0) + (quotedIdentifier ? 6 : 0);
  return { company, role, senderDomain, platform, temporalProximity, quotedIdentifier, score };
}

/**
 * Matches a confirmation in deterministic order: initial Gmail thread, exact
 * dedup key, then normalized company/role with compatible platform/date and
 * corroborating sender domain. A weak possible duplicate is not auto-created.
 */
export function matchApplicationConfirmation(messageRecord, applications) {
  const message = normalizeMatchingEvidence(messageRecord);
  const candidates = ensureApplications(applications);
  const classification = messageRecord.classification ?? CLASSIFICATION.APPLICATION_CONFIRMATION;

  const threadCandidates = candidates.filter(({ evidence }) => same(message.threadId, evidence.threadId));
  if (threadCandidates.length === 1) {
    return matched(threadCandidates[0], 'initial_thread', { strategy: 'initial_thread', thread: true });
  }
  if (threadCandidates.length > 1) {
    return unresolved(message, classification, threadCandidates, RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES,
      { strategy: 'initial_thread', thread: true }, evidenceSummary('initial_thread', { thread: true }));
  }

  const dedupCandidates = candidates.filter(({ evidence }) => same(message.dedupKey, evidence.dedupKey));
  if (dedupCandidates.length === 1) {
    return matched(dedupCandidates[0], 'dedup_key', { strategy: 'dedup_key', dedupKey: true });
  }
  if (dedupCandidates.length > 1) {
    return unresolved(message, classification, dedupCandidates, RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES,
      { strategy: 'dedup_key', dedupKey: true }, evidenceSummary('dedup_key', { dedupKey: true }));
  }

  const deterministic = candidates.filter(({ evidence }) => same(message.company, evidence.company) &&
    same(message.role, evidence.role) && same(message.senderDomain, evidence.senderDomain) &&
    compatible(message.platform, evidence.platform) && compatible(message.applicationDate, evidence.applicationDate));
  if (deterministic.length === 1) {
    return matched(deterministic[0], 'normalized_evidence', {
      strategy: 'normalized_evidence', company: true, role: true, senderDomain: true,
      platform: same(message.platform, deterministic[0].evidence.platform),
      applicationDate: same(message.applicationDate, deterministic[0].evidence.applicationDate)
    });
  }
  if (deterministic.length > 1) {
    return unresolved(message, classification, deterministic, RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES,
      { strategy: 'normalized_evidence', company: true, role: true, senderDomain: true },
      evidenceSummary('normalized_evidence', { company: true, role: true, senderDomain: true }));
  }

  const weakCandidates = candidates.filter(({ evidence }) =>
    same(message.company, evidence.company) && same(message.role, evidence.role));
  if (weakCandidates.length > 0) {
    return unresolved(message, classification, weakCandidates, RELATIONSHIP_EXCEPTION_REASON.WEAK_MATCH,
      { strategy: 'normalized_evidence', company: true, role: true, senderDomain: false },
      evidenceSummary('normalized_evidence', { company: true, role: true, senderDomain: false }));
  }

  return freezeOutcome({
    decision: MATCH_DECISION.CREATE,
    application: null,
    applicationId: null,
    candidateApplicationIds: [],
    matchedBy: null,
    relationshipException: null,
    evidence: { strategy: 'none' }
  });
}

/**
 * Links a non-confirmation message by initial thread when possible; otherwise
 * uses a transparent weighted score and returns a non-destructive exception
 * for absent, tied, or below-threshold evidence.
 */
export function matchFollowUp(messageRecord, applications, options = {}) {
  if (!isRecord(messageRecord)) throw new TypeError('A follow-up message record is required.');
  const classification = messageRecord.classification;
  if (!FOLLOW_UP_CLASSIFICATIONS.has(classification)) {
    throw new TypeError('Follow-up matching requires Interview_or_Test, Rejection, or Offer classification.');
  }
  const message = normalizeMatchingEvidence(messageRecord);
  const candidates = ensureApplications(applications);
  const settings = validateOptions(options);
  const threadCandidates = candidates.filter(({ evidence }) => same(message.threadId, evidence.threadId));
  if (threadCandidates.length === 1) {
    return matched(threadCandidates[0], 'initial_thread', { strategy: 'initial_thread', thread: true });
  }
  if (threadCandidates.length > 1) {
    return unresolved(message, classification, threadCandidates, RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES,
      { strategy: 'initial_thread', thread: true }, evidenceSummary('initial_thread', { thread: true }));
  }

  const scored = candidates.map((candidate) => ({
    ...candidate,
    scoreEvidence: scoreFollowUp(message, candidate.evidence, settings)
  })).filter(({ scoreEvidence }) => scoreEvidence.score > 0)
    .sort((left, right) => right.scoreEvidence.score - left.scoreEvidence.score ||
      left.evidence.applicationId.localeCompare(right.evidence.applicationId));
  if (scored.length === 0) {
    return unresolved(message, classification, [], RELATIONSHIP_EXCEPTION_REASON.NO_CANDIDATE,
      { strategy: 'scored_evidence', threshold: settings.followUpThreshold },
      evidenceSummary('scored_evidence', { threshold: settings.followUpThreshold, score: 0 }));
  }

  const top = scored[0];
  const ties = scored.filter(({ scoreEvidence }) => scoreEvidence.score === top.scoreEvidence.score);
  const evidence = {
    strategy: 'scored_evidence', threshold: settings.followUpThreshold,
    ...top.scoreEvidence,
    candidateScores: scored.map(({ evidence: candidate, scoreEvidence }) => ({
      applicationId: candidate.applicationId, score: scoreEvidence.score
    }))
  };
  const summary = evidenceSummary('scored_evidence', { ...top.scoreEvidence, threshold: settings.followUpThreshold });
  if (ties.length > 1) {
    return unresolved(message, classification, ties, RELATIONSHIP_EXCEPTION_REASON.MULTIPLE_CANDIDATES, evidence, summary);
  }
  if (top.scoreEvidence.score < settings.followUpThreshold) {
    return unresolved(message, classification, [top], RELATIONSHIP_EXCEPTION_REASON.WEAK_MATCH, evidence, summary);
  }
  return matched(top, 'scored_evidence', evidence);
}
