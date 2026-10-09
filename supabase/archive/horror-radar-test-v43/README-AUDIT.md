# HORRIFY — Horror Radar v43, audit tecnico

Questa cartella contiene una copia del sorgente `index.ts` scaricato dalla Supabase Edge Function `horror-radar-test` il 9 ottobre 2026.

## Obiettivo
Analizzare il codice reale dell'agente, confrontarlo con l'audit precedente e valutare riuso, difetti, test e architettura ibrida per copertura nazionale.

## Istruzioni per Claude Code
- Analizza `index.ts` senza modificarlo.
- Identifica con riferimenti a funzioni e righe i parser, la scoperta sale, le fonti, i fallback, i controlli sulle date e la classificazione horror.
- Distingui problemi dimostrabili dal codice, ipotesi e comportamenti che richiedono test.
- Valuta il rischio di falsi positivi, le dipendenze da Tavily/OSM/Supabase e i casi HTTP 403.
- Confronta l'agente reale con la proposta di job schedulati e adattatori per piattaforma.
- Proponi un piano incrementale che conservi il lavoro utile.
- Non modificare file, non usare segreti, non eseguire deploy o operazioni sul database, non effettuare push.

Nota: questo archivio contiene il solo sorgente della funzione, non le definizioni delle tabelle Supabase, i segreti o i log delle esecuzioni.
