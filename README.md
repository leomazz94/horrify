# HORRIFY

Preparazione per il trasferimento in `leomazz94/horrify` della versione 54 pubblicata su Sites.

## Contenuto

`dist/` contiene integralmente il frontend esistente: HTML, CSS, JavaScript, immagini e font. Tutti i file sono identici al commit sorgente `5fe066ec838c667df4d43787cdd068db959efeca`.

Il collegamento al backend Supabase, la logica del catalogo e l'autenticazione sono mantenuti nel codice originale. Non viene copiato né modificato il database.

## Pubblicazione preparata

Il workflow `.github/workflows/deploy-pages.yml` pubblica `dist/` su GitHub Pages dopo un push al branch `main`, oppure tramite avvio manuale. Nel repository GitHub occorre selezionare **Settings → Pages → Source → GitHub Actions**.

La destinazione prevista, da verificare dopo il deployment, è `https://leomazz94.github.io/horrify/`. Questo documento non conferma che il repository sia stato aggiornato o che il deployment sia già avvenuto.

Non è configurato alcun dominio personalizzato e non è presente un file `CNAME`: `horrify.it` rimane scollegato.

## Verifica dopo il deployment

- Home e pagina progetto, immagini e font su desktop e mobile.
- Ricerca e catalogo aggiornati da Supabase.
- Accesso, lista personale, stato visto/non visto e contatori.
- Scelta al buio, Horror Radar, On Demand e collegamenti JustWatch.
- Flussi di conferma email e recupero password: verificare le URL autorizzate in Supabase Auth per la nuova origine prima di considerare completata la migrazione.

Le sessioni del browser sul vecchio dominio non vengono trasferite alla nuova origine: occorre accedere nuovamente. I dati degli account rimangono nel backend esistente.

Il manifest `.openai/hosting.json` identifica la pubblicazione originale su Sites; il workflow GitHub usa esclusivamente `dist/`.
