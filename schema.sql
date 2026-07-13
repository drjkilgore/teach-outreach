-- =====================================================================
-- #TEACH Compliance Outreach — Supabase schema
-- Project ref: your #TEACH Supabase project (AWS)
-- Run this in the Supabase SQL editor (Dashboard → SQL → New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE throughout.
-- =====================================================================

-- ---------- extensions ------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "citext";         -- case-insensitive email

-- ---------- enums -----------------------------------------------------
do $$ begin
  create type app_role as enum
    ('super_admin','program_admin','reviewer','read_only');
exception when duplicate_object then null; end $$;

do $$ begin
  create type campaign_status as enum
    ('draft','ready','sending','paused','completed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type candidate_status as enum
    ('pending','excluded','queued','sent','delivered','bounced',
     'failed','responded','completed');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- profiles — one row per authenticated user; carries the role
-- =====================================================================
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  email       citext,
  role        app_role not null default 'read_only',
  is_active   boolean  not null default true,
  created_at  timestamptz not null default now()
);

-- auto-create a profile row on signup (defaults to read_only until an
-- admin elevates the role — no self-service privilege escalation)
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- helper: current user's role (used inside RLS policies)
create or replace function current_role_name()
returns app_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('super_admin','program_admin') and is_active
       from profiles where id = auth.uid()), false)
$$;

create or replace function can_send()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role in ('super_admin','program_admin') and is_active
       from profiles where id = auth.uid()), false)
$$;

-- =====================================================================
-- campaigns
-- =====================================================================
create table if not exists campaigns (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  program_state     text,
  purpose           text,
  reporting_agency  text,
  response_deadline date,
  secure_form_url   text,
  sender_name       text,
  sender_email      text,
  reply_to_email    text,
  email_subject     text,
  email_template    text,           -- HTML with {{merge_fields}}
  followup_schedule jsonb not null default '[]'::jsonb,
  rate_per_minute   int  not null default 30,
  status            campaign_status not null default 'draft',
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- =====================================================================
-- candidates — PII lives here. Never an SSN column, by design.
-- =====================================================================
create table if not exists candidates (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  first_name        text not null,
  last_name         text not null,
  email             citext,
  personal_email    citext,
  teach_email       citext,
  phone             text,
  date_of_birth     date,
  student_id        text,
  program           text,
  state             text,
  enrollment_status text,
  cohort            text,
  advisor_name      text,
  notes             text,
  status            candidate_status not null default 'pending',
  excluded          boolean not null default false,
  last_action       text,
  next_followup_at  timestamptz,
  followup_stage    int not null default 0,   -- 0=none,1=initial,2=r1,3=r2,4=final
  responded_at      timestamptz,
  completed_at      timestamptz,
  completed_by      text,                      -- user id / 'cognito-webhook'
  created_at        timestamptz not null default now(),
  unique (campaign_id, student_id)
);

create index if not exists idx_candidates_campaign on candidates(campaign_id);
create index if not exists idx_candidates_status   on candidates(status);
create index if not exists idx_candidates_followup on candidates(next_followup_at)
  where status not in ('completed','excluded');

-- Hard guard: reject any attempt to store an SSN-shaped value in notes.
create or replace function block_ssn_in_notes()
returns trigger language plpgsql as $$
begin
  if new.notes ~ '\y\d{3}[- ]?\d{2}[- ]?\d{4}\y' then
    raise exception 'Blocked: notes appear to contain a Social Security number.';
  end if;
  return new;
end $$;

drop trigger if exists trg_block_ssn on candidates;
create trigger trg_block_ssn
  before insert or update on candidates
  for each row execute function block_ssn_in_notes();

-- =====================================================================
-- email_events — every send/delivery/bounce/open/click
-- =====================================================================
create table if not exists email_events (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references candidates(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  event_type    text not null,   -- queued|sent|delivered|bounce|open|click|dropped|test
  stage         int,             -- which follow-up stage this send was
  provider_id   text,            -- SendGrid message id
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_events_candidate on email_events(candidate_id);
create index if not exists idx_events_campaign  on email_events(campaign_id);

-- =====================================================================
-- audit_log — immutable. No update/delete grants to anyone.
-- =====================================================================
create table if not exists audit_log (
  id          bigserial primary key,
  actor_id    uuid,
  actor_email text,
  action      text not null,   -- upload|edit|approve|send|export|delete|status|login
  target      text,            -- campaign/candidate id or filename
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_log(created_at desc);

create or replace function write_audit(_action text, _target text, _meta jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log(actor_id, actor_email, action, target, meta)
  values (auth.uid(),
          (select email from profiles where id = auth.uid()),
          _action, _target, coalesce(_meta,'{}'::jsonb));
end $$;

-- keep-audit-immutable: block update/delete via rule
create or replace rule audit_no_update as on update to audit_log do instead nothing;
create or replace rule audit_no_delete as on delete to audit_log do instead nothing;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table profiles     enable row level security;
alter table campaigns    enable row level security;
alter table candidates   enable row level security;
alter table email_events enable row level security;
alter table audit_log    enable row level security;

-- profiles: you can read your own row; admins read all; only super_admin writes roles
drop policy if exists p_profiles_self on profiles;
create policy p_profiles_self on profiles for select
  using (id = auth.uid() or is_admin());

drop policy if exists p_profiles_super_write on profiles;
create policy p_profiles_super_write on profiles for all
  using (current_role_name() = 'super_admin')
  with check (current_role_name() = 'super_admin');

-- campaigns: any active authenticated user may read; admins write
drop policy if exists p_campaigns_read on campaigns;
create policy p_campaigns_read on campaigns for select
  using (auth.uid() is not null);

drop policy if exists p_campaigns_write on campaigns;
create policy p_campaigns_write on campaigns for all
  using (is_admin()) with check (is_admin());

-- candidates: read for any authenticated user (masking is enforced in the UI
--   for non-admins); insert/update/delete restricted to admins.
drop policy if exists p_candidates_read on candidates;
create policy p_candidates_read on candidates for select
  using (auth.uid() is not null);

drop policy if exists p_candidates_write on candidates;
create policy p_candidates_write on candidates for all
  using (is_admin()) with check (is_admin());

-- reviewers may update notes only — handled through a dedicated RPC below
-- (kept out of table policies to avoid granting broad update).

-- email_events: read for authenticated; insert by admins or the service role
drop policy if exists p_events_read on email_events;
create policy p_events_read on email_events for select
  using (auth.uid() is not null);
drop policy if exists p_events_write on email_events;
create policy p_events_write on email_events for insert
  with check (is_admin());

-- audit: read for admins; inserts happen via security-definer write_audit()
drop policy if exists p_audit_read on audit_log;
create policy p_audit_read on audit_log for select
  using (is_admin());

-- =====================================================================
-- Reviewer note RPC (reviewers can annotate without full write access)
-- =====================================================================
create or replace function reviewer_add_note(_candidate uuid, _note text)
returns void language plpgsql security definer set search_path = public as $$
declare r app_role;
begin
  select role into r from profiles where id = auth.uid();
  if r not in ('super_admin','program_admin','reviewer') then
    raise exception 'Not permitted';
  end if;
  if _note ~ '\y\d{3}[- ]?\d{2}[- ]?\d{4}\y' then
    raise exception 'Blocked: note appears to contain an SSN.';
  end if;
  update candidates
     set notes = coalesce(notes,'') || E'\n[' || now()::date || '] ' || _note
   where id = _candidate;
  perform write_audit('note', _candidate::text, jsonb_build_object('len', length(_note)));
end $$;

-- =====================================================================
-- Dashboard rollup view
-- =====================================================================
create or replace view campaign_stats
with (security_invoker = on) as
select
  c.id as campaign_id,
  count(*) filter (where not cd.excluded)                        as total,
  count(*) filter (where cd.status='queued')                     as queued,
  count(*) filter (where cd.status in ('sent','delivered','responded','completed')) as sent,
  count(*) filter (where cd.status='delivered')                  as delivered,
  count(*) filter (where cd.status='bounced')                    as bounced,
  count(*) filter (where cd.status='failed')                     as failed,
  count(*) filter (where cd.status='completed')                  as completed,
  count(*) filter (where cd.excluded)                            as excluded,
  count(*) filter (where cd.status not in ('completed','excluded')) as outstanding
from campaigns c
left join candidates cd on cd.campaign_id = c.id
group by c.id;

-- done.
