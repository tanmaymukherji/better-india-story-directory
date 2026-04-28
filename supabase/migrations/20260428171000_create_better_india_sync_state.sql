create table if not exists public.better_india_sync_state (
  state_key text primary key,
  last_seen_latest_story_url text,
  last_total integer not null default 0,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  updated_at timestamptz not null default now()
);

