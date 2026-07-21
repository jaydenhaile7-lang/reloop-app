-- Reloop tier-permissions migration.
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
-- Safe to run once. Uses IF NOT EXISTS so a partial re-run won't error.

-- 1. Record which plan each subscriber is on.
alter table public.subscribers
  add column if not exists plan text;

-- 2. IMPORTANT backfill: existing active subscribers have plan = NULL, which the
--    new backend check treats as "unrecognized plan" and blocks. Set them to the
--    tier they actually pay for. If you can't tell them apart, pick the most
--    generous you're comfortable granting (this errs toward NOT locking people out).
--    Adjust or delete this line to match reality before running.
update public.subscribers
  set plan = 'Studio'
  where status = 'active' and plan is null;

-- 3. Per-user usage log, for the "inputs per week" limits.
create table if not exists public.usage_events (
  id         bigint generated always as identity primary key,
  email      text not null,
  kind       text not null,               -- 'repurpose' | 'clip'
  created_at timestamptz not null default now()
);

-- Fast lookups for the rolling-window count (email + recent time).
create index if not exists usage_events_email_created_idx
  on public.usage_events (email, created_at desc);

-- 4. Lock both tables down to backend-only access. The serverless functions use
--    the service key, which bypasses RLS; enabling RLS with no policies means the
--    public anon key cannot read/write these tables directly from the browser.
alter table public.subscribers  enable row level security;
alter table public.usage_events enable row level security;
