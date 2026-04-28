# Better India Story Directory

Static GitHub Pages directory for indexing stories from [The Better India](https://thebetterindia.com/stories), summarising them with Gemini, storing them in Supabase, and visualising the resulting records on a MapmyIndia map.

Project folder:
`C:\github\better-india-story-directory`

Included app surfaces:
- Public search page: `index.html`
- Story detail page: `product-detail.html`
- Person detail page: `vendor-detail.html`
- Admin sync and editor page: `admin.html`
- Shared Supabase loader: `innovation-store.js`
- Supabase migration: `supabase/migrations/20260428170000_create_better_india_story_directory.sql`
- Supabase edge function: `supabase/functions/better-india-admin/index.ts`
- Optional scheduled sync workflow: `.github/workflows/sync-better-india-directory.yml`

What this app supports:
- Search by keyword, name, place, and thematic area
- Name and thematic dropdowns populated from the latest Supabase dataset
- MapmyIndia story dots with "View Details" and "View on Better India" actions
- Admin login using the shared Innovation Guild / GRAMEEE password mechanism
- Manual story edits for summary, contacts, tags, theme, place, and 6M classification
- Batch syncs that process 10 stories at a time
- Backlog-first crawling of old stories while also checking for newly published stories
- Story-processing state so already summarised links are not reprocessed unnecessarily

Backend setup notes:
- Run the SQL migrations in `supabase/migrations`
- Deploy the `better-india-admin` edge function
- Set function secrets for:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` or `SELCO_VENDOR_SERVICE_ROLE_KEY`
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY`
  - `BETTER_INDIA_SYNC_CRON_TOKEN` if you want scheduled syncs

Static frontend config:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `MAPMYINDIA_MAP_KEY`
- `BETTER_INDIA_STORIES_TABLE`

