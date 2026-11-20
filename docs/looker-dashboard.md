# Dashboard Looker Studio — Gmail Job Application Tracker

Acest ghid configurează un raport Looker Studio care **citește exclusiv** tab-ul `Reporting_Dataset` din spreadsheet-ul trackerului. Nu conectați `Applications`, `Status_History`, `Processed_Messages` sau orice alt tab; acestea sunt date operaționale și nu reprezintă sursa de raportare.

## 1. Conectarea sursei read-only

1. Deschideți [Looker Studio](https://lookerstudio.google.com/), creați un raport nou și alegeți conectorul **Google Sheets**.
2. Autentificați-vă cu un cont care are numai acces de vizualizare la spreadsheet, atunci când politica organizației permite; proprietarul sursei trebuie să poată citi foaia. Nu utilizați contul Apps Script pentru editarea raportului dacă nu este necesar.
3. Selectați spreadsheet-ul trackerului, apoi selectați **numai** worksheet-ul `Reporting_Dataset`; activați prima linie ca antet și adăugați sursa la raport. Nu selectați un interval care include alte tab-uri.
4. În editorul sursei, confirmați că nu adăugați câmpuri sau blend-uri din alte surse și că nimeni nu are credențiale de editare asupra spreadsheet-ului prin acest raport. Trackerul nu acordă și nu solicită acces Looker cu scriere.
5. Denumiți sursa, de exemplu `Job applications — Reporting_Dataset (read-only)`, și păstrați o singură sursă de date în raport.

> Accesul de editare al raportului și accesul la spreadsheet sunt permisiuni distincte. Acordați rolul Looker **Viewer** consumatorilor dashboardului și păstrați controlul accesului la Google Sheet separat.

## 2. Câmpuri și tipuri de date

Verificați în sursa de date următoarea schemă. Datele sunt produse de tracker; nu editați valorile în Looker sau în `Reporting_Dataset`.

| Categorie | Câmpuri | Tip recomandat / utilizare |
|---|---|---|
| Identitate și filtre | `application_id`, `current_status`, `role`, `company`, `platform`, `location` | Text; `application_id` este cheia pentru număr distinct. |
| Date | `application_date`, `application_day`, `application_week_start`, `application_month` | Date; setați `application_date` ca **Date range dimension** a raportului. |
| Momente | `applied_at`, `first_response_at`, `interview_at`, `rejected_at`, `offer_at`, `last_status_changed_at`, `dataset_updated_at` | Date & Time; păstrați fusul orar al raportului consecvent cu cel ales pentru analiză. |
| Indicatori | `has_response`, `reached_interview`, `reached_offer` | Number (0/1), cu agregare `SUM`. |
| Durată/rang | `elapsed_to_first_response_hours`, `company_application_rank` | Number; durata folosește `AVG`; rangul poate fi afișat, dar clasamentul trebuie calculat prin sortarea metricii active. |

Creați, dacă nu sunt deja disponibile, aceste câmpuri calculate la nivel de sursă: **Application count** = `COUNT_DISTINCT(application_id)`; **Response rate** = `CASE WHEN COUNT_DISTINCT(application_id) = 0 THEN 0 ELSE SUM(has_response) / COUNT_DISTINCT(application_id) END`; **Interview count** = `SUM(reached_interview)`; **Offer count** = `SUM(reached_offer)`; **Average first-response hours** = `AVG(elapsed_to_first_response_hours)`. Formatați *Response rate* ca procent și durata ca număr cu 1–2 zecimale. Valorile `Unavailable` rămân valori de dimensiune filtrabile, nu sunt transformate în date lipsă.

## 3. Pagina Overview: KPI-uri, evoluție și funnel

Configurați toate graficele să folosească această sursă și să răspundă la intervalul de date al raportului.

| Componentă | Configurare |
|---|---|
| Scorecard-uri | `Application count`, `Response rate`, `Interview count`, `Offer count` și `Average first-response hours`. |
| Serie zilnică | Time series: dimensiune `application_day`, metrică `Application count`, granularitate Day. |
| Serie săptămânală | Time series: dimensiune `application_week_start`, metrică `Application count`, granularitate Week. |
| Serie lunară | Time series: dimensiune `application_month`, metrică `Application count`, granularitate Month. |
| Funnel | Funnel chart (sau bar chart dacă Funnel nu este disponibil): etape `Applied` = `Application count`, `Interview` = `Interview count`, `Offer` = `Offer count`; ordinea este Applied → Interview → Offer. Dacă este necesar un singur chart, creați un mic tabel auxiliar de etape numai în Looker, fără o nouă sursă de date, sau folosiți trei scorecard-uri etichetate în ordine. |
| Top companii | Bar chart: dimensiune `company`, metrică `Application count`, sortare descrescătoare după metrică, limită 10. Nu sortați după `company_application_rank`, deoarece sortarea după numărul distinct respectă filtrele curente. |
| Distribuție platforme | Pie/donut sau bar chart: dimensiune `platform`, metrică `Application count`, sortare descrescătoare. |

Fiecare aplicație pornește în `Applied`; de aceea baza funnelului este `Application count`, iar etapele ulterioare folosesc flagurile istorice `reached_interview` și `reached_offer`, nu exclusiv `current_status`.

## 4. Pagina Applications: tabel și filtre

Adăugați un tabel cu: `application_id`, `current_status`, `role`, `company`, `application_date`, `platform`, `location`, `applied_at`, `first_response_at`, `interview_at`, `rejected_at`, `offer_at`, `elapsed_to_first_response_hours` și `last_status_changed_at`. Setați sortarea inițială la `application_date` descrescător și permiteți utilizatorului să sorteze. Adăugați controale de filtru pentru `current_status`, `role`, `company`, `platform` și `location`, plus un **Date range control** pe `application_date`. Lăsați filtrele la nivel de raport/pagină pentru ca KPI-urile, graficele, rankingul și tabelul să prezinte același subset. Verificați pentru fiecare control că țintește numai `Job applications — Reporting_Dataset (read-only)`.

## 5. Refresh, publicare și verificare

În **Resource → Manage added data sources → Edit**, deschideți setarea **Data freshness** a conectorului Google Sheets și alegeți cea mai mică perioadă disponibilă pentru contul dvs.; opțiunile depind de cont și de interfața Looker curentă. Nu utilizați o extracție statică dacă dashboardul trebuie să reflecte actualizările automate ale trackerului. Publicați raportul numai după ce accesul la spreadsheet și la raport este revizuit.

După un run programat care actualizează `Reporting_Dataset`, așteptați următorul refresh automat configurat sau reîncărcați raportul manual pentru verificare. Confirmați că `dataset_updated_at` și un rând modificat apar actualizate; apoi verificați că fiecare filtru modifică scorecard-urile, seriile, funnelul, clasamentul, distribuția și tabelul. Dacă nu apare o opțiune de refresh/freshness în cont, documentați limita contului și utilizați intervalul automat disponibil—nu creați o sursă de scriere sau un job separat care să modifice datele de raportare.
