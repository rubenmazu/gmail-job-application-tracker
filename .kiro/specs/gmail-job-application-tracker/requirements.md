# Requirements Document

## Introduction

Gmail_Job_Application_Tracker este un sistem automat care identifică și urmărește aplicațiile la job primite sau confirmate prin Gmail, fără dependență de un calculator personal. Sistemul rulează programat în cloud, clasifică exclusiv mesajele noi relevante, menține o evidență unică a aplicațiilor și expune indicatori printr-un dashboard.

Documentul descrie rezultatele cerute. Google Apps Script, Gmail, Gemini API prin Google AI Studio, Google Sheets și Looker Studio sunt constrângeri de platformă preferate; mecanismele concrete de implementare vor fi definite în design.

## Glossary

- **Gmail_Job_Application_Tracker**: Sistemul care urmărește aplicațiile la job dintr-un cont Gmail autorizat.
- **Mailbox**: Contul Gmail autorizat pentru citire de către Gmail_Job_Application_Tracker.
- **New_Message**: Mesaj din Mailbox cu identificator Gmail care nu a fost procesat anterior de Gmail_Job_Application_Tracker.
- **Job_Application**: Înregistrarea unică a unei candidaturi pentru un rol la o companie.
- **Initial_Application**: Job_Application creată dintr-o confirmare a unei candidaturi.
- **Follow_Up_Message**: Mesaj ulterior referitor la o Initial_Application.
- **Application_Status**: Una dintre valorile `Applied`, `Interview`, `Rejected` sau `Offer` ale unei Job_Application.
- **Classification**: Categoria atribuită unui New_Message: `Application_Confirmation`, `Rejection`, `Interview_or_Test`, `Offer` sau `Irrelevant`.
- **Relevant_Message**: New_Message a cărui Classification este diferită de `Irrelevant`.
- **Classification_Service**: Serviciul Gemini API accesat cu o cheie Google AI Studio eligibilă pentru nivelul gratuit.
- **Free_Tier_Limit**: Limită curentă publicată de Google pentru modelul și nivelul gratuit selectate, inclusiv limitele de cereri, tokenuri sau alte cote aplicabile.
- **Execution_Quota**: Cotă publicată de Google care limitează operațiile Gmail sau Google Apps Script ale Mailbox autorizat, inclusiv numărul de apeluri sau durata cumulată de execuție.
- **Quota_Deferral**: Înregistrare care identifică o operație amânată, cota care a cauzat amânarea și momentul amânării.
- **Structured_Job_Data**: Rolul, compania, data, platforma de aplicare și locația extrase dintr-un Relevant_Message, cu valori lipsă marcate ca indisponibile.
- **Status_History**: Lista cronologică a schimbărilor de Application_Status pentru o Job_Application.
- **Reporting_Dataset**: Datele pregătite pentru dashboard, derivate din Job_Application și Status_History.
- **Dashboard**: Raport Looker Studio conectat la Reporting_Dataset.
- **Processing_Failure**: Eroare care împiedică procesarea completă a unui New_Message.

## Requirements

### Requirement 1: Execuție automată în cloud

**User Story:** Ca persoană care aplică la joburi, vreau ca evidența să fie actualizată fără ca un calculator personal să fie pornit, astfel încât să pot urmări aplicațiile continuu.

#### Acceptance Criteria

1. THE Gmail_Job_Application_Tracker SHALL execute scheduled processing in a cloud-hosted Google Apps Script environment.
2. WHEN one scheduled processing interval elapses, THE Gmail_Job_Application_Tracker SHALL start one processing run at an interval configured to 60 minutes by default.
3. WHERE the processing interval is changed by an authorized user, THE Gmail_Job_Application_Tracker SHALL use the configured interval for subsequent scheduled processing runs.
4. IF a scheduled processing run cannot complete, THEN THE Gmail_Job_Application_Tracker SHALL record one Processing_Failure through a failure-recording operation independent from normal processing-state writes, containing both the run timestamp and failure reason.

### Requirement 2: Procesarea exclusivă a mesajelor noi

**User Story:** Ca persoană care aplică la joburi, vreau ca sistemul să verifice numai emailurile noi, astfel încât aceleași mesaje să nu consume în mod repetat cota disponibilă.

#### Acceptance Criteria

1. WHEN a scheduled processing run starts, THE Gmail_Job_Application_Tracker SHALL select only New_Message records received after the latest successfully recorded processing checkpoint.
2. WHEN a New_Message is selected, THE Gmail_Job_Application_Tracker SHALL record the Gmail message identifier no later than immediately before the next scheduled processing run starts.
3. IF a Gmail message identifier is already recorded as processed, THEN THE Gmail_Job_Application_Tracker SHALL exclude the corresponding message from Classification_Service submission.
4. IF processing a New_Message fails before completion, THEN THE Gmail_Job_Application_Tracker SHALL retain the New_Message as eligible for a later processing run and record a Processing_Failure.

### Requirement 3: Clasificarea mesajelor relevante

**User Story:** Ca persoană care aplică la joburi, vreau ca mesajele despre recrutare să fie clasificate automat, astfel încât evidența să conțină numai informații utile.

#### Acceptance Criteria

1. WHEN a New_Message is eligible for classification, THE Gmail_Job_Application_Tracker SHALL request from Classification_Service exactly one Classification value from `Application_Confirmation`, `Rejection`, `Interview_or_Test`, `Offer` and `Irrelevant`.
2. WHEN Classification_Service returns `Irrelevant`, THE Gmail_Job_Application_Tracker SHALL record the message as processed without creating or updating a Job_Application.
3. WHEN Classification_Service returns `Application_Confirmation`, `Rejection`, `Interview_or_Test` or `Offer`, THE Gmail_Job_Application_Tracker SHALL create or update a Job_Application according to the message relationship rules.
4. IF Classification_Service returns no valid Classification value, THEN THE Gmail_Job_Application_Tracker SHALL record a Processing_Failure and retain the New_Message as eligible for later processing.

### Requirement 4: Extragerea datelor despre aplicație

**User Story:** Ca persoană care aplică la joburi, vreau ca detaliile disponibile ale candidaturii să fie extrase din email, astfel încât să pot analiza aplicațiile fără introducere manuală repetată.

#### Acceptance Criteria

1. WHEN a Relevant_Message is processed, THE Gmail_Job_Application_Tracker SHALL extract Structured_Job_Data from the message content.
2. WHEN processing a Relevant_Message whose role, company, application date, platform or location is absent, THE Gmail_Job_Application_Tracker SHALL store the corresponding Structured_Job_Data field as unavailable.
3. WHEN a platform is extracted, THE Gmail_Job_Application_Tracker SHALL preserve the platform value stated in the Relevant_Message, including `LinkedIn` or `eJobs` when present.
4. WHEN a Job_Application is created from an Application_Confirmation, THE Gmail_Job_Application_Tracker SHALL set Application_Status to `Applied`.
5. WHEN a Job_Application is created from an Application_Confirmation, THE Gmail_Job_Application_Tracker SHALL append an `Applied` Status_History entry with the status-change timestamp.
6. WHILE a Job_Application does not exist, THE Gmail_Job_Application_Tracker SHALL retain no Status_History entry for that Job_Application.

### Requirement 5: Corelarea răspunsurilor și tranzițiile de status

**User Story:** Ca persoană care aplică la joburi, vreau ca răspunsurile ulterioare să actualizeze candidatura corectă, astfel încât statusul curent să reflecte evoluția reală.

#### Acceptance Criteria

1. WHEN a Relevant_Message is a Follow_Up_Message that can be linked to one Initial_Application, THE Gmail_Job_Application_Tracker SHALL associate the Relevant_Message with that Initial_Application.
2. WHEN a Follow_Up_Message associated with a Job_Application has Classification `Interview_or_Test`, THE Gmail_Job_Application_Tracker SHALL set Application_Status to `Interview` and append the previous status, new status, message identifier and timestamp to Status_History.
3. WHEN a Follow_Up_Message associated with a Job_Application has Classification `Rejection`, THE Gmail_Job_Application_Tracker SHALL set Application_Status to `Rejected` and append the previous status, new status, message identifier and timestamp to Status_History.
4. WHEN a Follow_Up_Message associated with a Job_Application has Classification `Offer`, THE Gmail_Job_Application_Tracker SHALL set Application_Status to `Offer` and append the previous status, new status, message identifier and timestamp to Status_History.
5. IF a Relevant_Message cannot be linked to exactly one Initial_Application, THEN THE Gmail_Job_Application_Tracker SHALL record the unresolved relationship with the message identifier and SHALL preserve existing Job_Application records without status changes.

### Requirement 6: Integritatea evidenței aplicațiilor

**User Story:** Ca persoană care aplică la joburi, vreau ca fiecare candidatură să fie înregistrată o singură dată și să îi văd istoricul, astfel încât indicatorii să nu fie distorsionați de duplicate.

#### Acceptance Criteria

1. WHEN an Application_Confirmation corresponds to an existing Job_Application, THE Gmail_Job_Application_Tracker SHALL update the existing Job_Application rather than create a second Job_Application.
2. WHEN a new Job_Application is created, THE Gmail_Job_Application_Tracker SHALL assign a persistent unique application identifier.
3. THE Gmail_Job_Application_Tracker SHALL retain every Status_History entry after a subsequent Application_Status change.
4. WHILE processing for a New_Message is incomplete, THE Gmail_Job_Application_Tracker SHALL block or queue another processing submission for the same Gmail message identifier.
5. WHEN the same New_Message is submitted for processing more than once, THE Gmail_Job_Application_Tracker SHALL preserve the count of Job_Application records and the count of Status_History entries produced by the first completed processing.

### Requirement 7: Utilizarea și transparența nivelului gratuit Gemini

**User Story:** Ca persoană care aplică la joburi, vreau ca sistemul să funcționeze fără costuri neacceptate și să îmi comunice clar implicațiile prelucrării mesajelor, astfel încât să pot decide informat dacă autorizez clasificarea AI.

#### Acceptance Criteria

1. THE Gmail_Job_Application_Tracker SHALL use only a Classification_Service model that Google identifies as eligible for the Gemini API Free Tier at the time of configuration.
2. WHEN Classification_Service configuration is created or changed, THE Gmail_Job_Application_Tracker SHALL store the selected model identifier, the verification timestamp and the applicable Free_Tier_Limit values published by Google.
3. WHEN a planned classification request would exceed a stored Free_Tier_Limit, THE Gmail_Job_Application_Tracker SHALL defer the classification request without submitting the message content.
4. WHEN a classification request is deferred because a stored Free_Tier_Limit would be exceeded, THE Gmail_Job_Application_Tracker SHALL record the quota deferral.
5. WHEN a classification request is deferred because a stored Free_Tier_Limit would be exceeded, THE Gmail_Job_Application_Tracker SHALL retain the New_Message for automatic retry after quota becomes available.
6. WHEN an authorized user enables Classification_Service processing, THE Gmail_Job_Application_Tracker SHALL present a notice that message content sent to Classification_Service is external processing.
7. WHEN an authorized user enables Classification_Service processing, THE Gmail_Job_Application_Tracker SHALL require recorded acknowledgement before the first Classification_Service submission.
8. THE Gmail_Job_Application_Tracker SHALL state in the notice that privacy and data-use terms for the configured Gemini API tier must be verified against Google documentation.
9. THE Gmail_Job_Application_Tracker SHALL state in the notice that a free Gemini API tier does not by itself establish that submitted message content is private.
10. WHEN the authorized user withdraws the recorded acknowledgement, THE Gmail_Job_Application_Tracker SHALL stop submitting message content to Classification_Service.
11. WHEN the authorized user withdraws the recorded acknowledgement, THE Gmail_Job_Application_Tracker SHALL record the withdrawal timestamp.

### Requirement 8: Setul de date pentru raportare

**User Story:** Ca persoană care aplică la joburi, vreau indicatori și un tabel filtrabil despre candidaturi, astfel încât să pot evalua eficiența procesului de aplicare.

#### Acceptance Criteria

1. THE Gmail_Job_Application_Tracker SHALL maintain a Reporting_Dataset in Google Sheets containing one row per Job_Application and fields required for Application_Status, role, company, application date, platform, location and status timestamps.
2. WHEN a Job_Application or Status_History changes, THE Gmail_Job_Application_Tracker SHALL fully update Reporting_Dataset before the next scheduled processing run completes.
3. THE Gmail_Job_Application_Tracker SHALL provide Reporting_Dataset measures for application counts grouped by application day, week and month.
4. THE Gmail_Job_Application_Tracker SHALL provide Reporting_Dataset measures for response rate, funnel counts from `Applied` to `Interview` to `Offer`, company ranking by application count, platform distribution and average elapsed time from application timestamp to first response timestamp.
5. THE Gmail_Job_Application_Tracker SHALL provide Reporting_Dataset fields that permit Dashboard filtering by Application_Status, role, company, application date, platform and location.

### Requirement 9: Dashboard de analiză

**User Story:** Ca persoană care aplică la joburi, vreau un dashboard centralizat, astfel încât să urmăresc evoluția aplicațiilor și răspunsurilor dintr-un singur loc.

#### Acceptance Criteria

1. THE Dashboard SHALL read Reporting_Dataset from Google Sheets.
2. THE Dashboard SHALL display application counts for day, week and month groupings.
3. THE Dashboard SHALL display response rate, the `Applied` to `Interview` to `Offer` funnel, top companies, platform distribution and average time to first response.
4. THE Dashboard SHALL display a tabular view of Job_Application records with filters for Application_Status, role, company, application date, platform and location.
5. WHEN an automatic scheduled Dashboard data refresh occurs after Reporting_Dataset changes, THE Dashboard SHALL display the updated Reporting_Dataset values.

### Requirement 10: Respectarea cotelor gratuite de execuție și Gmail

**User Story:** Ca persoană care aplică la joburi, vreau ca sistemul să respecte cotele gratuite ale serviciilor Google, astfel încât procesarea programată să nu inițieze costuri sau blocări evitabile.

#### Acceptance Criteria

1. WHEN Gmail_Job_Application_Tracker configuration is created or changed, THE Gmail_Job_Application_Tracker SHALL store the applicable Execution_Quota values and the timestamp at which the authorized user verified the published Google quotas.
2. WHEN a planned Gmail read, Google Sheets write or scheduled processing run would exceed a stored Execution_Quota, THE Gmail_Job_Application_Tracker SHALL create one Quota_Deferral before initiating the operation.
3. WHEN a planned Gmail read, Google Sheets write or scheduled processing run would exceed a stored Execution_Quota, THE Gmail_Job_Application_Tracker SHALL retain affected New_Message records without marking the New_Message records as processed.
4. WHEN an Execution_Quota becomes available after a Quota_Deferral, THE Gmail_Job_Application_Tracker SHALL retry the deferred operation during a subsequent scheduled processing run.
5. IF Google returns a quota-exceeded response for a Gmail, Google Apps Script or Google Sheets operation, THEN THE Gmail_Job_Application_Tracker SHALL create one Quota_Deferral and retain the affected New_Message records for a later processing run.

## Source Notes

- Google publishes model-specific Gemini API rate limits and states that they regulate requests over time: [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
- Google documents the distinction between Free Tier and paid-tier billing: [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing).
- Google documents quota limits for Google Apps Script and Gmail service operations: [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas).
- Gemini API contractual conditions are maintained by Google and must be consulted for current data-use obligations: [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms).

Content from the linked sources was rephrased for compliance with licensing restrictions.
