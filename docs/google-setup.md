# Configurare Google Apps Script

Acest ghid configurează trackerul într-un proiect **Google Apps Script legat de un Google Spreadsheet**. Efectuați pașii din contul Google care deține mailbox-ul ce va fi citit; triggerul instalabil rulează ca acel utilizator și îi consumă cotele.

## 1. Leagă proiectul și autorizează accesul

1. Deschideți Spreadsheet-ul dorit, apoi **Extensii → Apps Script** și asigurați-vă că sursele compilate ale acestui proiect sunt publicate în proiectul legat (de exemplu, rulați local `npm run build`, apoi `npx clasp push`).
2. Verificați `appsscript.json`. Aplicația declară numai următoarele scope-uri:
   - `https://www.googleapis.com/auth/gmail.readonly` — citește Gmail, fără trimitere, ștergere sau marcare a mesajelor;
   - `https://www.googleapis.com/auth/spreadsheets` — citește/scrie foile operaționale ale Spreadsheet-ului;
   - `https://www.googleapis.com/auth/script.scriptapp` — creează și administrează triggerul instalabil;
   - `https://www.googleapis.com/auth/script.external_request` — trimite requestul către Gemini API.
3. Rulați manual `initializeTracker` din editorul Apps Script și finalizați fluxul de autorizare Google. `LockService` și `PropertiesService` nu necesită scope-uri OAuth declarate separat.
4. Confirmați că foile operaționale au fost create și că nu ați acordat acces unui alt cont decât celui administrativ necesar.

## 2. Alege mailbox-ul corect

- Autorizați și instalați triggerul **din contul Gmail care conține aplicațiile la job**. Apps Script nu permite alegerea arbitrară a altui mailbox prin acest proiect; Gmail este citit în identitatea instalatorului triggerului.
- Pentru separare, folosiți un cont Gmail dedicat ori mutați mesajele relevante într-un label/query de test înainte de activarea în producție. Trackerul are acces read-only, dar trimite către Gemini doar metadate și un extras limitat configurabil, fără atașamente.
- Nu rulați `initializeTracker` dintr-un cont administrativ diferit dacă acel cont nu este mailbox-ul dorit.

## 3. Setează cheia Gemini în Script Properties

1. Creați manual o cheie în Google AI Studio pentru modelul pe care îl veți verifica la pasul următor.
2. În proiectul Apps Script deschideți **Project Settings → Script properties**, adăugați proprietatea `GEMINI_API_KEY` și salvați cheia ca valoare. Nu folosiți User properties, Document properties sau celule Sheets.
3. Nu introduceți cheia în `Configuration`, `Configuration_Audit`, cod sursă, loguri sau Looker Studio. Implementarea citește cheia numai din Script Properties; funcția `saveGeminiConfiguration` poate de asemenea să o salveze acolo când primește `apiKey`.
4. Dacă o cheie a fost expusă, revocați-o în AI Studio, creați una nouă și înlocuiți numai valoarea `GEMINI_API_KEY`.

## 4. Verifică manual Free Tier, cotele și lipsa billing-ului

Înainte de a activa Gemini, verificați la data configurării documentația Google pentru [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [billing](https://ai.google.dev/gemini-api/docs/billing), [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas) și [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms).

1. În AI Studio selectați un `gemini_model_id` marcat explicit eligibil pentru **Free Tier** în acel moment. Nu presupuneți că modelul sau limitele rămân gratuite.
2. Notați valorile publicate aplicabile pentru `gemini_free_tier_rpm`, `gemini_free_tier_tpm`, `gemini_free_tier_rpd` și referința resetării zilnice; setați și `gemini_model_verified_at` la momentul verificării.
3. Verificați cotele contului pentru Gmail reads, Sheets writes și runtime Apps Script. Salvați valorile în `execution_quota_gmail_reads`, `execution_quota_sheet_writes`, `execution_quota_runtime_minutes` și `execution_quota_verified_at`.
4. În consola Google Cloud asociată proiectului, confirmați că pentru acest flux nu este atașat un cont de facturare și nu activați upgrade/plată pentru Gemini. Free Tier nu garantează lipsa oricărei modificări viitoare de produs; reverificați înaintea fiecărei schimbări de model sau cotă.
5. Apelați `saveGeminiConfiguration` ca administrator cu toate valorile obligatorii: `modelId`, `modelVerifiedAt`, `freeTierRpm`, `freeTierTpm`, `freeTierRpd`, `dailyResetReference` și `inputCharLimit`. Serviciul le persistă în `Configuration` și le auditează, fără a persista cheia API.

## 5. Notice, acknowledgement și retragere

1. Afișați mai întâi `getGeminiPrivacyNotice()`. Acesta comunică faptul că text limitat din email este trimis către Gemini, serviciu extern; termenii de privacy/data-use trebuie reverificați în documentația Google pentru tier-ul ales; Free Tier nu stabilește singur că textul trimis este privat.
2. Numai după citirea notice-ului și verificările de mai sus, apelați `recordAcknowledgement({ noticeVersion: 'gemini-external-processing-v1' })` din contul autorizat. Se salvează versiunea notice-ului, utilizatorul și timpul, iar procesarea Gemini poate deveni activă.
3. Pentru a opri imediat orice submit nou de conținut către Gemini, apelați `withdrawAcknowledgement()`. Aceasta dezactivează Gemini și înregistrează `privacy_withdrawn_at`; mesajele rămân pentru procesare ulterioară, fără trimitere externă.
4. După retragere sau după schimbarea notice-ului, cereți un nou acknowledgement înainte de reactivare.

## 6. Păstrează un singur trigger

- `initializeTracker()` creează schema și reconciliază triggerul instalabil pentru `runScheduledProcessing`; apelarea repetată păstrează exact un trigger gestionat.
- Intervalul implicit este 60 de minute. Pentru modificare, apelați `configureSchedule(intervalMinutes)` ca administrator; sunt acceptate numai `1`, `5`, `10`, `15`, `30`, `60`, `120`, `240`, `360`, `480` sau `720` minute. Funcția creează noul trigger înainte de a elimina triggerul vechi.
- În **Triggers** din Apps Script, verificați că există un singur trigger time-driven cu handler `runScheduledProcessing`. Eliminați doar duplicatele cu același handler create manual; nu ștergeți triggerul activ înainte de a reconfigura intervalul.
- După configurare, rulați o execuție manuală controlată și verificați `Processing_Failures`, `Quota_Deferrals`, `Configuration` și `Configuration_Audit` înainte de activarea curentă.
