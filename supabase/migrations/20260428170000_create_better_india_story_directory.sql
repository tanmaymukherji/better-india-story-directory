create extension if not exists pgcrypto;

create table if not exists public.better_india_sync_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  requested_by text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  story_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.better_india_stories (
  id uuid primary key default gen_random_uuid(),
  story_uid text not null unique,
  story_url text not null unique,
  title text not null,
  person_name text,
  person_slug text,
  author_name text,
  thematic_area text,
  place_label text,
  location_text text,
  state text,
  country text not null default 'India',
  contact_email text,
  contact_phone text,
  contact_address text,
  summary_of_work text,
  story_excerpt text,
  six_m_categories text[] not null default '{}',
  tags text[] not null default '{}',
  cover_image_url text,
  story_image_urls jsonb not null default '[]'::jsonb,
  latitude double precision,
  longitude double precision,
  source_published_at timestamptz,
  source_listing_page integer,
  source_listing_position integer,
  source_status text,
  admin_notes text,
  ai_model text,
  ai_summary jsonb not null default '{}'::jsonb,
  raw_story jsonb not null default '{}'::jsonb,
  search_text text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists better_india_stories_published_idx on public.better_india_stories (source_published_at desc nulls last);
create index if not exists better_india_stories_name_idx on public.better_india_stories (lower(person_name));
create index if not exists better_india_stories_theme_idx on public.better_india_stories (lower(thematic_area));
create index if not exists better_india_stories_place_idx on public.better_india_stories (lower(place_label));
create index if not exists better_india_stories_tags_idx on public.better_india_stories using gin (tags);
create index if not exists better_india_stories_sixm_idx on public.better_india_stories using gin (six_m_categories);

alter table public.better_india_sync_runs enable row level security;
alter table public.better_india_stories enable row level security;

drop policy if exists "better india stories are public" on public.better_india_stories;

create policy "better india stories are public"
on public.better_india_stories
for select
to anon, authenticated
using (true);

