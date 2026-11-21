-- Kunden (Vorlagen) mit Adresse und einfacher Strecke ab Zuhause,
-- Fahrten ohne Uhrzeit (Hin- und Rückfahrt zum Kunden nachgetragen, nur Datum und km)
alter table public.templates
  add column address text,
  add column distance_km numeric(8,1) check (distance_km is null or distance_km >= 0);

alter table public.trips
  add column without_time boolean not null default false;
