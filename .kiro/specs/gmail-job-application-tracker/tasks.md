# Implementation Plan: Gmail Job Application Tracker

## Overview

Plan incremental pentru un proiect Google Apps Script/JavaScript legat de un Google Spreadsheet. Implementarea menține Sheets drept sursă operațională, procesează Gmail idempotent, trimite date minimizate către Gemini numai după acknowledgement și expune exclusiv `Reporting_Dataset` pentru Looker Studio. Toate taskurile de test unitare, bazate pe proprietăți și de integrare sunt incluse în execuția curentă pentru verificarea proprietăților aprobate.

## Tasks

- [x] 1. Configurează fundația proiectului Apps Script și schema operațională Sheets
  - [x] 1.1 Creează manifestul Apps Script, structura JavaScript modulară și configurația locală de build/test pentru cod pur testabil; declară numai scope-urile Gmail read-only, Sheets, trigger, lock, properties și external request necesare.
    - _Requirements: 1.1, 2.1, 7.6, 10.1_
  - [x] 1.2 Implementează constantele de domeniu și inițializarea idempotentă a spreadsheet-ului: antete fixe, tipuri/enum-uri și tab-urile `Applications`, `Status_History`, `Processed_Messages`, `Processing_Checkpoint`, `Configuration`, `Configuration_Audit`, `Processing_Failures`, `Quota_Deferrals`, `Relationship_Exceptions` și `Reporting_Dataset`; setează valorile implicite de 60 minute și overlap 120 minute.
    - _Requirements: 1.2, 4.2, 4.6, 6.2, 6.3, 7.2, 7.4, 7.11, 8.1, 10.1, 10.2_
  - [x] 1.3 Implementează repository-ul Sheets cu citiri normalizate, indexuri după cheile logice și scrieri batch/upsert pentru toate tab-urile; păstrează identificatorii Gmail ca text, datele în ISO UTC și secretele în afara Sheet-ului.
    - _Requirements: 1.4, 2.2, 4.1, 5.5, 6.1, 6.2, 6.3, 7.2, 8.1, 8.2, 10.1_
  - [x] 1.4 Scrie teste unitare pentru inițializarea repetată, antetele tuturor tab-urilor, valorile implicite și serializarea sigură a ID-urilor/datei.
    - _Requirements: 1.2, 6.2, 7.2, 8.1, 10.1_

- [x] 2. Implementează administrarea configurației, notice-ului și triggerelor
  - [x] 2.1 Implementează serviciul de `Configuration`/`Configuration_Audit` pentru salvarea valorilor de cotă Google și Gemini, timestamp-urilor de verificare, modelului, limitelor, intervalului și opțiunilor de retry, cu validare administrativă.
    - _Requirements: 1.3, 7.1, 7.2, 10.1_
  - [x] 2.2 Implementează operațiile administrative `saveGeminiConfiguration`, `recordAcknowledgement` și `withdrawAcknowledgement`, inclusiv notice-ul versionat cu avertismentele/linkurile cerute, stocarea cheii doar în Script Properties și blocarea efectivă după retragere.
    - _Requirements: 7.1, 7.2, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_
  - [x] 2.3 Implementează `initializeTracker` și managerul de trigger: creează un singur trigger instalabil pentru `runScheduledProcessing`, înlocuiește triggerul gestionat când intervalul se schimbă și validează intervalul configurat.
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 2.4 Scrie teste unitare cu `PropertiesService`, `Session` și `ScriptApp` mock-uite pentru auditul configurației, notice/acknowledgement/retragere, secretul exclus din Sheets și înlocuirea triggerului.
    - _Requirements: 1.1, 1.2, 1.3, 7.2, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 10.1_

- [x] 3. Implementează achiziția incrementală, ledger-ul și checkpoint-ul
  - [x] 3.1 Implementează ledger-ul `Processed_Messages`: claim atomic înaintea oricărui submit, lease/expirare, număr de încercări, stările terminale/nonterminale, rezultat clasificat persistat și reluare fără reclasificare.
    - _Requirements: 2.2, 2.3, 2.4, 6.4, 6.5_
  - [x] 3.2 Implementează reader-ul Gmail read-only și planificatorul incremental: watermark cu overlap, paginare/decompozare thread, sortare `(received_at, message_id)`, excluderea terminalelor și avansarea numai peste secvența terminală contiguă.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.4_
  - [x] 3.3 Implementează append-urile independente pentru `Processing_Failures`, `Quota_Deferrals` și `Relationship_Exceptions`, cu redacția diagnosticelor, metadatele de retry și fără mascarea erorii originale.
    - _Requirements: 1.4, 2.4, 3.4, 5.5, 7.4, 10.2, 10.5_
  - [x] 3.4 Scrie testul bazat pe proprietăți pentru **Property 1: Failures remain independently auditable**, cu minimum 100 de rulări și comentariul de feature/proprietate cerut.
    - **Validates: Requirements 1.4, 2.4, 3.4**
  - [x] 3.5 Scrie testul bazat pe proprietăți pentru **Property 2: Incremental selection processes each eligible message once**, cu generatori pentru ordonare, overlap, duplicate, stări ledger și granițe de timp.
    - **Validates: Requirements 2.1, 2.3, 2.4, 6.4**
  - [x] 3.6 Scrie teste unitare/recovery cu Gmail/clock/Sheets mock-uite pentru claim înainte de submit, lease expirat, retry ne-terminal și checkpoint care nu sare peste un mesaj incomplet.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.4, 6.5_

- [x] 4. Implementează guard-urile de cotă și contractul Gemini
  - [x] 4.1 Implementează quota guard pur și adaptorul de persistență: estimează Gmail/Sheets/runtime/Gemini, rezervă și înregistrează consumul pe ferestre configurate, creează deferrarea înainte de operația interzisă și stabilește retry-ul după fereastra eligibilă.
    - _Requirements: 7.3, 7.4, 7.5, 10.2, 10.3, 10.4, 10.5_
  - [x] 4.2 Implementează clientul Gemini cu payload minimizat, un singur request pentru mesajul neclasificat, model Free Tier configurat și schema JSON strictă; parsează/validează local enum-ul, câmpurile, data și proprietățile suplimentare și persistă JSON-ul valid înainte de efectele de domeniu.
    - _Requirements: 3.1, 3.4, 4.1, 7.1, 7.3, 7.5, 7.7, 7.10_
  - [x] 4.3 Scrie testul bazat pe proprietăți pentru **Property 3: Classification contract is strict and non-mutating on invalid data**, cu corpuri JSON arbitrare, malformate și valori-limită.
    - **Validates: Requirements 3.1, 3.4**
  - [x] 4.4 Scrie testul bazat pe proprietăți pentru **Property 9: Authorization and quota guards prevent prohibited submission and preserve retries**, cu acknowledgement, retragere, ferestre/costuri și erori de cotă generate.
    - **Validates: Requirements 7.3, 7.4, 7.5, 7.7, 7.10, 10.2, 10.3, 10.4, 10.5**
  - [x] 4.5 Scrie teste unitare pentru payload fără atașamente sau text integral, limitarea extrasului, răspunsuri 401/403/429/5xx, model neverificat și reutilizarea unui `classification_json` valid.
    - _Requirements: 3.1, 3.4, 4.1, 7.1, 7.3, 7.4, 7.5, 7.7, 7.10, 10.5_

- [x] 5. Implementează corelarea aplicațiilor și mașina de stări idempotentă
  - [x] 5.1 Implementează funcțiile pure de normalizare/extragere pentru datele Gemini: completează lipsurile cu `Unavailable`, păstrează platforma exactă și marchează `Irrelevant` ca efect fără mutații de domeniu.
    - _Requirements: 3.2, 4.1, 4.2, 4.3_
  - [x] 5.2 Implementează matcher-ul explicabil pentru confirmări și follow-up-uri: prioritate pe thread, dedup key și dovezi normalizate; aplică pragul/scorul, identifică egalitățile/slăbiciunile și produce excepții ne-distructive.
    - _Requirements: 3.3, 5.1, 5.5, 6.1_
  - [x] 5.3 Implementează state machine/repository de domeniu pentru crearea unui `application_id` persistent, upsert de confirmare, evenimente `event_key` și tranziții `Applied`/`Interview`/`Rejected`/`Offer`, fără regresie sau istoric orfan.
    - _Requirements: 3.3, 4.4, 4.5, 4.6, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.5_
  - [x] 5.4 Scrie testul bazat pe proprietăți pentru **Property 4: Irrelevant and incomplete data are safely normalized**, inclusiv Unicode, câmpuri absente și valori `LinkedIn`/`eJobs`.
    - **Validates: Requirements 3.2, 4.1, 4.2, 4.3**
  - [x] 5.5 Scrie testul bazat pe proprietăți pentru **Property 5: Confirmation creation is unique and auditable**, cu secvențe de confirmări duplicate și statusuri ulterioare.
    - **Validates: Requirements 3.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3**
  - [x] 5.6 Scrie testul bazat pe proprietăți pentru **Property 6: A uniquely linked follow-up produces one prescribed transition**, pentru fiecare status anterior și fiecare clasificare de follow-up permisă.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 6.3**
  - [x] 5.7 Scrie testul bazat pe proprietăți pentru **Property 7: Ambiguity is non-destructive**, cu zero candidați, egalități și scoruri sub prag.
    - **Validates: Requirements 5.5, 4.6**
  - [x] 5.8 Scrie testul bazat pe proprietăți pentru **Property 8: Replay has exactly-once domain effects**, injectând întreruperi după fiecare pas de commit și reluări repetate.
    - **Validates: Requirements 2.2, 6.4, 6.5**
  - [x] 5.9 Scrie teste unitare cu fixture-uri redacționate pentru thread comun, dedup determinist, match ambiguu, confirmare duplicată și toate tranzițiile de status.
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.5_

- [x] 6. Construiește setul de date pentru raportare
  - [x] 6.1 Implementează proiecția și upsert-ul `Reporting_Dataset`, cu exact un rând per `application_id`, timestamp-uri, dimensiuni filtrabile, bucket-uri zi/săptămână/lună, flaguri răspuns/funnel, timp până la primul răspuns și rank companie.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 6.2 Scrie testul bazat pe proprietăți pentru **Property 10: Reporting is a faithful one-row projection**, comparând proiecția cu un calcul de referință pentru date, istorice și valori null.
    - **Validates: Requirements 8.1, 8.3, 8.4**
  - [x] 6.3 Scrie teste unitare pentru coloanele de raportare, update după modificare și măsurile/filtrele cerute de dashboard.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 7. Integrează orchestrarea, rezolvarea manuală și testele automate de integrare
  - [x] 7.1 Implementează `runScheduledProcessing`: lock global, identificator de run, verificare runtime, execuția fazelor reader→claim→guard→Gemini/reuse→domain→reporting→checkpoint, `try/catch/finally`, eliberare lock și failure boundary independent.
    - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 5.1, 5.2, 5.3, 5.4, 5.5, 6.4, 6.5, 7.3, 7.4, 7.5, 7.7, 7.10, 8.2, 10.2, 10.3, 10.4, 10.5_
  - [x] 7.2 Implementează operația administrativă `resolveRelationship`, care leagă manual exact o aplicație, aplică o singură tranziție idempotentă prin `source_message_id` și actualizează rezolvarea excepției/raportarea.
    - _Requirements: 5.5, 6.3, 6.5, 8.2_
  - [~] 7.3 Scrie teste de integrare automatizate într-un cont Google de test, cu Gmail/Sheets sintetice: autorizări, trigger implicit/reconfigurat, citire incrementală, restart după failure, deferrare/retry și commit al raportării înainte de finalizarea run-ului.
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 7.1, 7.3, 7.4, 7.5, 8.2, 10.2, 10.3, 10.4, 10.5_

- [ ] 8. Creează ghidurile manuale de configurare Google și Looker Studio
  - [x] 8.1 Creează `docs/google-setup.md` pentru proiectul Apps Script legat de Spreadsheet: autorizări/scopes, alegerea mailbox-ului, Script Properties pentru cheie, verificarea manuală Free Tier/cote/fără billing, notice/acknowledgement/retragere și administrarea triggerului unic.
    - _Requirements: 1.1, 1.2, 1.3, 7.1, 7.2, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 10.1_
  - [x] 8.2 Creează `docs/looker-dashboard.md` pentru conectarea read-only exclusiv la `Reporting_Dataset`, configurarea agregărilor/graficelor/funnel/ranking/tabelului/filtrelor cerute și refresh-ul disponibil în cont.
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5_

- [~] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Toate testele unitare, PBT și de integrare definite în design sunt obligatorii și se execută în cadrul execuției curente.
- Undele de test 10–18 sunt păstrate în graful de dependențe și se execută după undele de implementare 0–9; testele validează incremental implementarea, orchestrarea și ghidurile fără a modifica dependențele existente.
- Fiecare test PBT folosește `fast-check` (sau echivalentul JavaScript standard al proiectului), minimum 100 de iterații și comentariul `Feature: gmail-job-application-tracker, Property N: <property text>`.
- Ghidurile de la 8.x documentează configurări manuale necesare pentru servicii Google externe; nu automatizează AI Studio, autorizarea contului sau Looker Studio.


## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "3.1", "3.3", "4.1", "5.1"] },
    { "id": 4, "tasks": ["2.2", "2.3", "3.2", "4.2", "5.2"] },
    { "id": 5, "tasks": ["5.3"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["7.2"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["8.1", "8.2"] },
    { "id": 10, "tasks": ["1.4"] },
    { "id": 11, "tasks": ["2.4", "3.4", "3.5", "3.6", "4.3", "4.4", "4.5", "5.4"] },
    { "id": 12, "tasks": ["5.5"] },
    { "id": 13, "tasks": ["5.6"] },
    { "id": 14, "tasks": ["5.7"] },
    { "id": 15, "tasks": ["5.8"] },
    { "id": 16, "tasks": ["5.9"] },
    { "id": 17, "tasks": ["6.2", "6.3"] },
    { "id": 18, "tasks": ["7.3"] }
  ]
}
```