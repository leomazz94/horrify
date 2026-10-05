# Horrify TMDB streaming sync

Deployed to project tvhdxnxnlllmnnbszaqd. The function authenticates scheduler calls with a generated server-only x-sync-key from streaming_sync_control. No browser access to the key or write endpoints.

Activation: add TMDB_READ_TOKEN (TMDB API Read Access Token) to Supabase Edge Functions Secrets. No frontend changes are required. Scheduled checks run every 15 minutes, at most 10 movies per batch. A successfully checked movie is eligible again after 23 hours; failures retry after 3 hours. Offers expire after 48 hours. First complete scan takes approximately 2.5 hours for 100 movies.

Match requires unique search result with matching Italian/original title, release year and director. Unmatched/ambiguous movies remain excluded until reviewed; set movies.tmdb_id only after confirming the exact film.

Only Italy's flatrate providers are stored. Explicit provider aliases exclude rental/purchase, extra channels and add-ons. Empty Italian availability clears old offers atomically and records the verification. Source links and TMDB/JustWatch credits are displayed on the website.

Missing token returns 503 tmdb_token_missing before any TMDB network calls. Sync status is in streaming_sync_control; movie-specific status is in movies.streaming_match_status. Do not log tokens or scheduler keys.
