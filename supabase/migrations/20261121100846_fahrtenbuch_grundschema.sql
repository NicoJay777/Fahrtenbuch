-- Fahrtenbuch: Grundschema (so im Supabase-Projekt „Fahrtenbuch“ angewendet)

create table public.places (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  address text,
  lat double precision not null,
  lng double precision not null,
  radius_m integer not null default 200,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.templates (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  purpose text,
  partner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.trips (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  start_lat double precision,
  start_lng double precision,
  start_address text,
  end_lat double precision,
  end_lng double precision,
  end_address text,
  distance_km numeric(8,1),
  distance_source text check (distance_source in ('route','luftlinie','manuell')),
  odometer_start integer,
  odometer_end integer,
  purpose text,
  partner text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index trips_user_started on public.trips (user_id, started_at desc);
create index places_user on public.places (user_id);
create index templates_user on public.templates (user_id);

-- Änderungsverlauf: jede Änderung/Löschung einer Fahrt wird mit altem Stand protokolliert
create table public.trip_history (
  id bigint generated always as identity primary key,
  trip_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  changed_at timestamptz not null default now(),
  action text not null,
  old_row jsonb,
  new_row jsonb
);
create index trip_history_trip on public.trip_history (trip_id, changed_at);

create or replace function public.log_trip_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.trip_history (trip_id, user_id, action, new_row)
    values (new.id, new.user_id, 'angelegt', to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    if (to_jsonb(old) - 'updated_at') is distinct from (to_jsonb(new) - 'updated_at') then
      insert into public.trip_history (trip_id, user_id, action, old_row, new_row)
      values (new.id, new.user_id,
              case when new.deleted_at is not null and old.deleted_at is null then 'gelöscht' else 'geändert' end,
              to_jsonb(old), to_jsonb(new));
    end if;
    return new;
  end if;
  return null;
end;
$$;

create trigger trips_insert_log after insert on public.trips
  for each row execute function public.log_trip_change();
create trigger trips_update_log before update on public.trips
  for each row execute function public.log_trip_change();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.user_id := old.user_id; return new; end; $$;
create trigger places_touch before update on public.places for each row execute function public.touch_updated_at();
create trigger templates_touch before update on public.templates for each row execute function public.touch_updated_at();

alter table public.places enable row level security;
alter table public.templates enable row level security;
alter table public.trips enable row level security;
alter table public.trip_history enable row level security;

create policy "eigene Orte" on public.places for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "eigene Vorlagen" on public.templates for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Fahrten: lesen, anlegen, ändern – aber nicht hart löschen (nur deleted_at setzen)
create policy "eigene Fahrten lesen" on public.trips for select to authenticated
  using (user_id = (select auth.uid()));
create policy "eigene Fahrten anlegen" on public.trips for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "eigene Fahrten ändern" on public.trips for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Verlauf nur lesbar, nie änderbar
create policy "eigenen Verlauf lesen" on public.trip_history for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.trip_history from anon, authenticated;
grant select on public.trip_history to authenticated;
revoke delete on public.trips from anon, authenticated;
revoke all on public.places, public.templates, public.trips from anon;
revoke execute on function public.log_trip_change() from public, anon, authenticated;
