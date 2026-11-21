/* Fahrtenbuch – Web-App für Geschäftsfahrten (offlinefähig, Abgleich mit Supabase) */
(() => {
"use strict";

const CFG = window.FB_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const TABLES = ["trips", "places", "templates"];
const UNSYNCED_WARN_DAYS = 3;

/* ---------- Hilfsfunktionen ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const fmtKm = (n) => (n == null || n === "" ? "–" : Number(n).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtEur = (n) => Number(n || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const fmtDate = (iso) => new Date(iso).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const fmtDateShort = (iso) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "–");
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const localDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const combine = (date, time) => (date && time ? new Date(`${date}T${time}`).toISOString() : null);
const round1 = (n) => Math.round(n * 10) / 10;
const parseNum = (s) => { if (s == null || String(s).trim() === "") return null; const n = Number(String(s).replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// vorläufige Schätzung, bis der Routendienst erreichbar ist (Straße ≈ 1,25 × Luftlinie)
const estimateKm = (a, b) => round1(haversineKm(a, b) * 1.25);

/* ---------- Lokaler Speicher (IndexedDB) ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("fahrtenbuch", 1);
    r.onupgradeneeded = () => {
      for (const t of TABLES) r.result.createObjectStore(t, { keyPath: "id" });
      r.result.createObjectStore("meta", { keyPath: "k" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const out = fn(tx.objectStore(store));
    tx.oncomplete = () => res(out && "result" in out ? out.result : out);
    tx.onerror = () => rej(tx.error);
  });
}
const idbAll = (s) => idb(s, "readonly", (o) => o.getAll());
const idbPut = (s, v) => idb(s, "readwrite", (o) => o.put(v));
const idbClear = (s) => idb(s, "readwrite", (o) => o.clear());
const metaGet = async (k) => (await idb("meta", "readonly", (o) => o.get(k)))?.v;
const metaSet = (k, v) => idbPut("meta", { k, v });

/* ---------- Zustand ---------- */
const S = {
  user: null, tab: "fahrt", trips: [], places: [], templates: [],
  sync: { state: "off", last: null, error: null, enrichError: null, running: false },
  onlyMissing: false, year: new Date().getFullYear(), exportRange: "year", profile: {},
  sheet: null, busy: false,
};

async function loadLocal() {
  for (const t of TABLES) S[t] = await idbAll(t);
  S.sync.last = await metaGet("lastSync");
  S.profile = (await metaGet("profile")) || {};
}
const alive = (arr) => arr.filter((x) => !x.deleted_at);
const activeTrip = () => alive(S.trips).find((t) => !t.ended_at);
const doneTrips = () => alive(S.trips).filter((t) => t.ended_at).sort((a, b) => b.started_at.localeCompare(a.started_at));
const missingPurpose = () => doneTrips().filter((t) => !t.purpose?.trim());
const dirtyCount = () => TABLES.reduce((n, t) => n + S[t].filter((x) => x._dirty).length, 0);

async function save(table, rec) {
  rec._dirty = true;
  rec._dirtySince = rec._dirtySince || Date.now();
  rec._rev = (rec._rev || 0) + 1;
  rec._localUpdated = new Date().toISOString();
  await idbPut(table, rec);
  const i = S[table].findIndex((x) => x.id === rec.id);
  if (i >= 0) S[table][i] = rec; else S[table].push(rec);
  scheduleSync();
}

/* ---------- Abgleich mit Supabase ---------- */
let syncTimer;
function scheduleSync(delay = 800) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, delay); }

const strip = (r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (!k.startsWith("_") && k !== "created_at" && k !== "updated_at") o[k] = v; return o; };

async function sync() {
  if (!S.user || S.sync.running) return;
  if (!navigator.onLine) { S.sync.state = "off"; renderStatus(); return; }
  S.sync.running = true; S.sync.state = "wait"; renderStatus();
  try {
    await enrich();
    // 1. lokale Änderungen hochladen
    for (const t of TABLES) {
      const dirty = S[t].filter((x) => x._dirty);
      if (!dirty.length) continue;
      const revs = new Map(dirty.map((x) => [x.id, x._rev]));
      const { error } = await sb.from(t).upsert(dirty.map((x) => ({ ...strip(x), user_id: S.user.id })));
      if (error) throw error;
      for (const x of S[t]) {
        if (revs.has(x.id) && revs.get(x.id) === x._rev) { x._dirty = false; x._dirtySince = null; await idbPut(t, x); }
      }
    }
    // 2. Änderungen vom Server holen
    for (const t of TABLES) {
      const since = await metaGet("pull_" + t);
      let q = sb.from(t).select("*").order("updated_at", { ascending: true }).limit(1000);
      if (since) q = q.gt("updated_at", since);
      const { data, error } = await q;
      if (error) throw error;
      let max = since;
      for (const row of data) {
        const i = S[t].findIndex((x) => x.id === row.id);
        if (i >= 0 && S[t][i]._dirty) continue;
        const rec = { ...row, _dirty: false };
        await idbPut(t, rec);
        if (i >= 0) S[t][i] = rec; else S[t].push(rec);
        if (!max || row.updated_at > max) max = row.updated_at;
      }
      if (max) await metaSet("pull_" + t, max);
    }
    S.sync.last = new Date().toISOString(); await metaSet("lastSync", S.sync.last);
    S.sync.error = null; S.sync.state = "ok";
  } catch (e) {
    S.sync.error = e.message || String(e); S.sync.state = "err";
    if (/JWT|token|auth/i.test(S.sync.error)) S.sync.error = "Anmeldung abgelaufen – bitte unter „Mehr“ ab- und wieder anmelden. (" + S.sync.error + ")";
  } finally {
    S.sync.running = false;
    refresh();
  }
}

async function callRoute(body) {
  const { data, error } = await sb.functions.invoke("route", { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return data;
}

// Adresse aus Koordinaten – direkt vom Gerät (die Dienste sperren Server-Anfragen).
// Photon zuerst, Nominatim als Ausweich; beides OpenStreetMap-Daten.
async function reverseGeocode(p) {
  const fmt = (parts) => parts.filter(Boolean).join(", ");
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${p.lat}&lon=${p.lng}&lang=de&limit=1`);
    if (!r.ok) throw new Error("Photon " + r.status);
    const f = (await r.json()).features?.[0]?.properties;
    if (f) {
      const name = f.name && f.name !== f.street ? f.name : null;
      const s = fmt([name, [f.street, f.housenumber].filter(Boolean).join(" "), [f.postcode, f.city || f.town || f.village || f.district].filter(Boolean).join(" ")]);
      if (s) return s;
    }
  } catch (_) { /* weiter mit Nominatim */ }
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=de&lat=${p.lat}&lon=${p.lng}`);
  if (!r.ok) throw new Error("Adressdienst antwortet mit " + r.status);
  const d = await r.json(); const a = d.address || {};
  const name = d.name && d.name !== a.road ? d.name : null;
  return fmt([name, [a.road || a.pedestrian, a.house_number].filter(Boolean).join(" "), [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(" ")]) || d.display_name || null;
}

// Koordinaten aus einer eingetippten Adresse – ebenfalls direkt vom Gerät
async function forwardGeocode(q) {
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=de&limit=1`);
    if (!r.ok) throw new Error("Photon " + r.status);
    const c = (await r.json()).features?.[0]?.geometry?.coordinates;
    if (c) return { lat: c[1], lng: c[0] };
  } catch (_) { /* weiter mit Nominatim */ }
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=de&q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error("Adressdienst antwortet mit " + r.status);
  const d = (await r.json())[0];
  return d ? { lat: Number(d.lat), lng: Number(d.lon) } : null;
}

// Adressen und Straßenkilometer nachtragen, sobald Internet da ist
async function enrich() {
  S.sync.enrichError = null;
  // nach jedem Netzaufruf den AKTUELLEN Stand der Fahrt holen – sie kann inzwischen bearbeitet worden sein
  const cur = (id) => S.trips.find((x) => x.id === id);
  const apply = async (id, fn) => { const t = cur(id); if (t && !t.deleted_at && fn(t)) await save("trips", t); };
  for (const id of alive(S.trips).map((t) => t.id)) {
    try {
      let t = cur(id);
      if (t.start_lat != null && !t.start_address) {
        const address = await reverseGeocode({ lat: t.start_lat, lng: t.start_lng });
        await apply(id, (x) => (address && !x.start_address ? ((x.start_address = address), true) : false));
        await sleep(1100);
      }
      t = cur(id);
      if (t.end_lat != null && !t.end_address) {
        const address = await reverseGeocode({ lat: t.end_lat, lng: t.end_lng });
        await apply(id, (x) => (address && !x.end_address ? ((x.end_address = address), true) : false));
        await sleep(1100);
      }
      t = cur(id);
      if (t.ended_at && t.distance_source === "luftlinie" && t.start_lat != null && t.end_lat != null) {
        const r = await callRoute({ action: "route", start: { lat: t.start_lat, lng: t.start_lng }, end: { lat: t.end_lat, lng: t.end_lng } });
        await apply(id, (x) => (Number.isFinite(r.km) && x.distance_source === "luftlinie" ? ((x.distance_km = r.km), (x.distance_source = "route"), true) : false));
      }
    } catch (e) {
      S.sync.enrichError = "Adresse/Kilometer konnten noch nicht ermittelt werden: " + e.message;
      break;
    }
  }
}

/* ---------- Standort ---------- */
function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Dieses Gerät gibt keinen Standort heraus."));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => rej(new Error(e.code === 1
        ? "Standortzugriff ist nicht erlaubt. iPhone: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites → „Beim Verwenden“."
        : e.code === 3 ? "Der Standort wurde nicht rechtzeitig gefunden." : "Standort nicht verfügbar.")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
    );
  });
}
function nearestPlace(p) {
  let best = null, bestD = Infinity;
  for (const pl of alive(S.places)) {
    const d = haversineKm(p, pl) * 1000;
    if (d <= (pl.radius_m || 200) && d < bestD) { best = pl; bestD = d; }
  }
  return best;
}
const placeLabel = (pl) => (pl.address ? `${pl.name} – ${pl.address}` : pl.name);
const lastOdometer = () => { const t = doneTrips().find((x) => x.odometer_end != null); return t ? t.odometer_end : null; };

/* ---------- Aktionen ---------- */
async function startTrip() {
  if (activeTrip() || S.busy) return;
  S.busy = true; render();
  const now = new Date().toISOString();
  const trip = { id: uuid(), started_at: now, ended_at: null, distance_km: null, distance_source: null };
  try {
    const p = await getPosition();
    trip.start_lat = p.lat; trip.start_lng = p.lng;
    const pl = nearestPlace(p); if (pl) trip.start_address = placeLabel(pl);
  } catch (e) {
    toast(e.message + " Die Fahrt läuft trotzdem – Start bitte später eintragen.", 6000);
  }
  const odo = lastOdometer(); if (odo != null) trip.odometer_start = odo;
  await save("trips", trip);
  S.busy = false; render();
}

async function endTrip() {
  const t = activeTrip(); if (!t || S.busy) return;
  S.busy = true; render();
  t.ended_at = new Date().toISOString();
  try {
    const p = await getPosition();
    t.end_lat = p.lat; t.end_lng = p.lng;
    const pl = nearestPlace(p); if (pl) t.end_address = placeLabel(pl);
    if (t.start_lat != null) { t.distance_km = estimateKm({ lat: t.start_lat, lng: t.start_lng }, p); t.distance_source = "luftlinie"; }
  } catch (e) {
    toast(e.message + " Bitte Ziel und Kilometer von Hand eintragen.", 6000);
  }
  await save("trips", t);
  S.busy = false;
  openTrip(t.id, true);
}

async function cancelTrip() {
  const t = activeTrip(); if (!t) return;
  if (!confirm("Laufende Fahrt verwerfen?")) return;
  t.deleted_at = new Date().toISOString(); await save("trips", t); render();
}

function openTrip(id, afterEnd = false) { S.sheet = { type: "trip", id, afterEnd }; render(); setTimeout(() => afterEnd && $("#f_purpose")?.focus(), 250); }
function newTrip() { S.sheet = { type: "trip", id: null }; render(); }

function readTripForm() {
  const g = (id) => $("#" + id)?.value ?? "";
  return {
    date: g("f_date"), t1: g("f_t1"), t2: g("f_t2"), start: g("f_start").trim(), end: g("f_end").trim(),
    km: parseNum(g("f_km")), o1: parseNum(g("f_o1")), o2: parseNum(g("f_o2")),
    purpose: g("f_purpose").trim(), partner: g("f_partner").trim(), notes: g("f_notes").trim(),
  };
}

async function saveTrip() {
  const f = readTripForm();
  const err = (m) => { $("#f_err").textContent = m; $("#f_err").hidden = false; };
  const old = S.sheet.id ? S.trips.find((x) => x.id === S.sheet.id) : null;
  // Fahrt ohne Uhrzeit (Hin-/Rückfahrt zum Kunden): bleibt ohne Uhrzeit, solange beide Zeitfelder leer sind
  const noTime = !!old?.without_time && !f.t1 && !f.t2;
  if (!f.date || (!f.t1 && !noTime)) return err("Bitte Datum und Startzeit angeben.");
  if (old?.without_time && !noTime && (!f.t1 || !f.t2)) return err("Bitte Beginn und Ende angeben – oder beide Zeitfelder leer lassen.");
  for (const [v, n] of [[f.km, "Kilometer"], [f.o1, "Kilometerstand Beginn"], [f.o2, "Kilometerstand Ende"]])
    if (Number.isNaN(v) || (v != null && v < 0)) return err(`${n}: bitte eine gültige Zahl eingeben.`);
  if (f.o1 != null && f.o2 != null && f.o2 < f.o1) return err("Kilometerstand Ende ist kleiner als Beginn.");
  const started = combine(f.date, noTime ? localTime(old.started_at) : f.t1);
  let ended = noTime ? started : f.t2 ? combine(f.date, f.t2) : null;
  if (ended && ended < started) ended = new Date(new Date(ended).getTime() + 86400000).toISOString(); // über Mitternacht
  const t = old ? { ...old } : { id: uuid(), distance_source: null };
  if (!old && !ended) return err("Bitte die Endzeit angeben.");
  t.started_at = started; t.ended_at = old && !old.ended_at && !f.t2 ? null : ended;
  if (old?.without_time) t.without_time = noTime;
  // nur übernehmen, was im Formular tatsächlich geändert wurde (Hintergrund-Abgleich kann inzwischen Adressen/km ergänzt haben)
  const init = S.sheet.init || {};
  if (f.start !== init.start) t.start_address = f.start || null;
  if (f.end !== init.end) t.end_address = f.end || null;
  if (f.km !== init.km) { t.distance_km = f.km; t.distance_source = f.km == null ? null : "manuell"; }
  t.odometer_start = f.o1; t.odometer_end = f.o2;
  t.purpose = f.purpose || null; t.partner = f.partner || null; t.notes = f.notes || null;
  if (t.ended_at && t.distance_km == null) return err("Bitte die Kilometer angeben (oder Kilometerstand Beginn und Ende).");
  await save("trips", t);
  S.sheet = null; toast("Gespeichert"); render();
}

async function deleteTrip() {
  const t = S.trips.find((x) => x.id === S.sheet.id); if (!t) return;
  if (!confirm("Diese Fahrt löschen? Sie bleibt im Änderungsverlauf nachvollziehbar.")) return;
  t.deleted_at = new Date().toISOString(); await save("trips", t);
  S.sheet = null; toast("Fahrt gelöscht"); render();
}

async function recalcTrip() {
  const t = S.trips.find((x) => x.id === S.sheet.id);
  if (!t || t.start_lat == null || t.end_lat == null) return toast("Für diese Fahrt fehlen die Standortdaten.");
  t.distance_km = estimateKm({ lat: t.start_lat, lng: t.start_lng }, { lat: t.end_lat, lng: t.end_lng });
  t.distance_source = "luftlinie"; await save("trips", t);
  toast(navigator.onLine ? "Kilometer werden neu berechnet …" : "Wird berechnet, sobald Internet da ist.");
  S.sheet = null; render();
}

function applyTemplate(id) {
  const tp = S.templates.find((x) => x.id === id); if (!tp) return;
  if (tp.purpose) $("#f_purpose").value = tp.purpose;
  if (tp.partner) $("#f_partner").value = tp.partner;
}
function applyPlace(which, id) {
  const pl = S.places.find((x) => x.id === id); if (!pl) return;
  $(which === "start" ? "#f_start" : "#f_end").value = placeLabel(pl);
}
function odoToKm() {
  const o1 = parseNum($("#f_o1").value), o2 = parseNum($("#f_o2").value);
  if (o1 == null || o2 == null || Number.isNaN(o1) || Number.isNaN(o2) || o2 < o1) return toast("Bitte Kilometerstand Beginn und Ende eintragen.");
  $("#f_km").value = String(o2 - o1).replace(".", ",");
}

async function tripAsTemplate() {
  const f = readTripForm();
  if (!f.purpose && !f.partner) return toast("Erst Zweck oder Geschäftspartner eintragen.");
  const name = prompt("Name der Vorlage:", f.partner || f.purpose); if (!name) return;
  await save("templates", { id: uuid(), name: name.trim(), purpose: f.purpose || null, partner: f.partner || null });
  toast("Vorlage gespeichert"); render();
}
async function tripEndAsPlace() {
  const t = S.trips.find((x) => x.id === S.sheet.id);
  if (!t || t.end_lat == null) return toast("Für das Ziel gibt es keinen Standort.");
  const name = prompt("Name des Orts (z. B. „Kunde Müller“):"); if (!name) return;
  await save("places", { id: uuid(), name: name.trim(), address: t.end_address || null, lat: t.end_lat, lng: t.end_lng, radius_m: 200 });
  toast("Ort gespeichert – wird künftig automatisch erkannt"); render();
}

async function showHistory() {
  const box = $("#f_hist"); box.innerHTML = '<p class="muted small">Lädt …</p>';
  if (!navigator.onLine) { box.innerHTML = '<p class="muted small">Der Verlauf ist nur mit Internet abrufbar.</p>'; return; }
  const { data, error } = await sb.from("trip_history").select("*").eq("trip_id", S.sheet.id).order("changed_at");
  if (error) { box.innerHTML = `<p class="small" style="color:var(--red)">${esc(error.message)}</p>`; return; }
  if (!data.length) { box.innerHTML = '<p class="muted small">Noch kein Eintrag auf dem Server (wird beim nächsten Abgleich angelegt).</p>'; return; }
  const F = { started_at: "Beginn", ended_at: "Ende", start_address: "Start", end_address: "Ziel", distance_km: "km", purpose: "Zweck", partner: "Geschäftspartner", odometer_start: "km-Stand Beginn", odometer_end: "km-Stand Ende", notes: "Notiz", deleted_at: "gelöscht" };
  const show = (k, v) => (v == null ? "–" : /_at$/.test(k) ? `${fmtDateShort(v)} ${fmtTime(v)}` : v);
  box.innerHTML = data.map((h) => {
    let diff = "";
    if (h.action !== "angelegt" && h.old_row && h.new_row) {
      diff = Object.keys(F).filter((k) => JSON.stringify(h.old_row[k]) !== JSON.stringify(h.new_row[k]))
        .map((k) => `${F[k]}: ${esc(show(k, h.old_row[k]))} → ${esc(show(k, h.new_row[k]))}`).join("<br>");
    }
    return `<div class="hist"><b>${esc(h.action)}</b> · ${fmtDateShort(h.changed_at)} ${fmtTime(h.changed_at)}${diff ? "<br>" + diff : ""}</div>`;
  }).join("");
}

async function addPlaceHere() {
  const name = prompt("Name des Orts (z. B. „Büro“, „Kunde Müller“):"); if (!name) return;
  try {
    S.busy = true; render();
    const p = await getPosition();
    await save("places", { id: uuid(), name: name.trim(), address: null, lat: p.lat, lng: p.lng, radius_m: 200 });
    toast("Ort gespeichert");
  } catch (e) { toast(e.message, 6000); }
  S.busy = false; render();
}
async function renamePlace(id) {
  const pl = S.places.find((x) => x.id === id); const name = prompt("Neuer Name:", pl.name); if (!name) return;
  pl.name = name.trim(); await save("places", pl); render();
}
async function deletePlace(id) {
  const pl = S.places.find((x) => x.id === id); if (!confirm(`Ort „${pl.name}“ löschen?`)) return;
  pl.deleted_at = new Date().toISOString(); await save("places", pl); render();
}
/* ---------- Kunden (Vorlagen mit Adresse und km ab Zuhause) ---------- */
const customers = () => alive(S.templates).filter((tp) => tp.address && tp.distance_km != null).sort((a, b) => a.name.localeCompare(b.name));
function openTemplate(id = null) { S.sheet = { type: "tpl", id }; render(); }
async function saveTemplate() {
  const g = (id) => $("#" + id).value.trim();
  const err = (m) => { $("#c_err").textContent = m; $("#c_err").hidden = false; };
  const km = parseNum(g("c_km"));
  if (!g("c_name")) return err("Bitte einen Namen angeben.");
  if (Number.isNaN(km) || (km != null && km < 0)) return err("Kilometer: bitte eine gültige Zahl eingeben.");
  const old = S.sheet.id ? S.templates.find((x) => x.id === S.sheet.id) : null;
  const tp = old ? { ...old } : { id: uuid() };
  Object.assign(tp, { name: g("c_name"), purpose: g("c_purpose") || null, partner: g("c_partner") || null, address: g("c_address") || null, distance_km: km });
  await save("templates", tp);
  S.sheet = null; toast("Gespeichert"); render();
}
async function calcTemplateKm() {
  const home = S.profile.home, addr = $("#c_address").value.trim();
  if (!home) return toast("Bitte zuerst unter „Angaben für den Ausdruck“ die Heimatadresse eintragen.", 5000);
  if (!addr) return toast("Bitte zuerst die Adresse des Kunden eintragen.");
  if (!navigator.onLine) return toast("Zum Berechnen wird Internet benötigt.");
  const btn = $("#c_calc"); btn.disabled = true; btn.textContent = "Wird berechnet …";
  try {
    const [a, b] = [await forwardGeocode(home), await forwardGeocode(addr)];
    if (!a) throw new Error("Heimatadresse nicht gefunden.");
    if (!b) throw new Error("Adresse des Kunden nicht gefunden.");
    const r = await callRoute({ action: "route", start: a, end: b });
    if (!Number.isFinite(r.km)) throw new Error("Keine Route gefunden.");
    const el = $("#c_km"); if (el) el.value = String(r.km).replace(".", ",");
    toast(`${fmtKm(r.km)} km – bitte kurz prüfen`);
  } catch (e) { toast("Berechnung fehlgeschlagen: " + e.message, 6000); }
  if ($("#c_calc")) { $("#c_calc").disabled = false; $("#c_calc").textContent = "km berechnen (Route ab Zuhause)"; }
}

/* ---------- Hin- und Rückfahrt zu einem Kunden nachtragen (nur Datum und km) ---------- */
function openRoundTrip(id) { S.sheet = { type: "rt", id }; render(); }
async function saveRoundTrip() {
  const g = (id) => $("#" + id).value.trim();
  const err = (m) => { $("#r_err").textContent = m; $("#r_err").hidden = false; };
  const date = g("r_date"), home = g("r_home"), cust = g("r_cust"), k1 = parseNum(g("r_km1")), k2 = parseNum(g("r_km2"));
  if (!date) return err("Bitte das Datum angeben.");
  if (!home || !cust) return err("Bitte Heimatadresse und Adresse des Kunden angeben.");
  for (const [v, n] of [[k1, "Kilometer Hinfahrt"], [k2, "Kilometer Rückfahrt"]])
    if (v == null || Number.isNaN(v) || v < 0) return err(`${n}: bitte eine gültige Zahl eingeben.`);
  const base = { purpose: g("r_purpose") || null, partner: g("r_partner") || null, distance_source: "manuell", without_time: true };
  // ohne Uhrzeit: Hinfahrt 0:00, Rückfahrt 0:01, damit die Reihenfolge erhalten bleibt
  const t1 = combine(date, "00:00"), t2 = combine(date, "00:01");
  await save("trips", { id: uuid(), ...base, started_at: t1, ended_at: t1, start_address: home, end_address: cust, distance_km: round1(k1) });
  await save("trips", { id: uuid(), ...base, started_at: t2, ended_at: t2, start_address: cust, end_address: home, distance_km: round1(k2) });
  if (!S.profile.home) { S.profile = { ...S.profile, home }; await metaSet("profile", S.profile); }
  S.sheet = null; toast("Hin- und Rückfahrt gespeichert"); render();
}

function sheetTemplate() {
  const tp = S.sheet.id ? S.templates.find((x) => x.id === S.sheet.id) : null;
  return `<div class="sheet-bg" data-act="closeBg"><div class="sheet" role="dialog" aria-modal="true">
    <div class="sh"><h2>${tp ? "Kunde / Vorlage bearbeiten" : "Kunde / Vorlage anlegen"}</h2><button class="x" data-act="close" aria-label="Schließen">×</button></div>
    <div id="c_err" class="banner err small" hidden></div>
    <label for="c_name">Name</label><input id="c_name" value="${esc(tp?.name || "")}" placeholder="z. B. Kunde Müller">
    <label for="c_purpose">Zweck der Fahrt</label><input id="c_purpose" value="${esc(tp ? tp.purpose || "" : "Kundentermin")}">
    <label for="c_partner">Geschäftspartner / Firma</label><input id="c_partner" value="${esc(tp?.partner || "")}">
    <label for="c_address">Adresse des Kunden</label><input id="c_address" value="${esc(tp?.address || "")}" placeholder="Straße Nr., PLZ Ort">
    <label for="c_km">Kilometer einfache Strecke ab Zuhause</label><input id="c_km" inputmode="decimal" value="${tp?.distance_km != null ? String(tp.distance_km).replace(".", ",") : ""}">
    <button class="btn link" id="c_calc" data-act="calcTpl">km berechnen (Route ab Zuhause)</button>
    <p class="muted small">Mit Adresse und Kilometern erscheint der Kunde unter „Fahrt nachtragen“ – ein Tipp trägt Hin- und Rückfahrt ein. Ohne Adresse füllt die Vorlage nur Zweck und Geschäftspartner aus.</p>
    <div class="spacer"></div>
    <button class="btn" data-act="saveTpl">Speichern</button>
  </div></div>`;
}

function sheetRoundTrip() {
  const tp = S.templates.find((x) => x.id === S.sheet.id);
  const km = tp?.distance_km != null ? String(tp.distance_km).replace(".", ",") : "";
  return `<div class="sheet-bg" data-act="closeBg"><div class="sheet" role="dialog" aria-modal="true">
    <div class="sh"><h2>Hin- und Rückfahrt</h2><button class="x" data-act="close" aria-label="Schließen">×</button></div>
    <p class="muted small" style="margin:0">Legt zwei Fahrten an: Zuhause → ${esc(tp?.name || "Kunde")} und zurück. Nur für Termine, die direkt von zu Hause und zurück gefahren wurden.</p>
    <div id="r_err" class="banner err small" hidden></div>
    <label for="r_date">Datum</label><input id="r_date" type="date" value="${localDate(new Date().toISOString())}">
    <label for="r_purpose">Zweck der Fahrt</label><input id="r_purpose" value="${esc(tp?.purpose || "")}">
    <label for="r_partner">Geschäftspartner / Firma</label><input id="r_partner" value="${esc(tp?.partner || "")}">
    <label for="r_home">Zuhause</label><input id="r_home" value="${esc(S.profile.home || "")}" placeholder="Heimatadresse">
    <label for="r_cust">Kunde</label><input id="r_cust" value="${esc(tp?.address || "")}">
    <div class="row"><div><label for="r_km1">km Hinfahrt</label><input id="r_km1" inputmode="decimal" value="${km}"></div>
      <div><label for="r_km2">km Rückfahrt</label><input id="r_km2" inputmode="decimal" value="${km}"></div></div>
    <p class="muted small">Umweg gefahren? Dann die km hier anpassen.</p>
    <div class="spacer"></div>
    <button class="btn" data-act="saveRt">Beide Fahrten speichern</button>
  </div></div>`;
}
async function deleteTemplate(id) {
  const tp = S.templates.find((x) => x.id === id); if (!confirm(`Vorlage „${tp.name}“ löschen?`)) return;
  tp.deleted_at = new Date().toISOString(); await save("templates", tp); render();
}
async function saveProfile() {
  S.profile = { name: $("#p_name").value.trim(), plate: $("#p_plate").value.trim(), home: $("#p_home").value.trim() };
  await metaSet("profile", S.profile);
  if (navigator.onLine) sb.auth.updateUser({ data: { fb_profile: S.profile } }).catch(() => {});
  toast("Gespeichert");
}

async function signOut() {
  const n = dirtyCount();
  if (n && !confirm(`${n} Änderung(en) sind noch nicht hochgeladen und gehen beim Abmelden verloren. Trotzdem abmelden?`)) return;
  if (!n && !confirm("Abmelden?")) return;
  await sb.auth.signOut().catch(() => {});
  for (const t of [...TABLES, "meta"]) await idbClear(t);
  Object.assign(S, { user: null, trips: [], places: [], templates: [], profile: {} });
  render();
}

/* ---------- Auswertung & Export ---------- */
function tripsIn(year, month = null) {
  return doneTrips().filter((t) => { const d = new Date(t.started_at); return d.getFullYear() === year && (month == null || d.getMonth() === month); })
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
}
const sumKm = (arr) => round1(arr.reduce((s, t) => s + Number(t.distance_km || 0), 0));
const years = () => { const ys = new Set(doneTrips().map((t) => new Date(t.started_at).getFullYear())); ys.add(new Date().getFullYear()); return [...ys].sort((a, b) => b - a); };
function exportSel() { return S.exportRange === "year" ? { trips: tripsIn(S.year), label: String(S.year), file: `${S.year}` } :
  { trips: tripsIn(S.year, Number(S.exportRange)), label: `${MONTHS[Number(S.exportRange)]} ${S.year}`, file: `${S.year}-${pad(Number(S.exportRange) + 1)}` }; }

async function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportCsv() {
  const { trips, file } = exportSel();
  if (!trips.length) return toast("Keine Fahrten im gewählten Zeitraum.");
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Datum", "Beginn", "Ende", "Start", "Ziel", "Zweck", "Geschäftspartner", "km-Stand Beginn", "km-Stand Ende", "Kilometer", "Betrag (€)", "Notiz"];
  const rows = trips.map((t) => [fmtDateShort(t.started_at), t.without_time ? "" : fmtTime(t.started_at), t.without_time ? "" : fmtTime(t.ended_at), t.start_address, t.end_address, t.purpose, t.partner,
    t.odometer_start ?? "", t.odometer_end ?? "", fmtKm(t.distance_km), (Number(t.distance_km || 0) * CFG.kmRate).toFixed(2).replace(".", ","), t.notes]);
  rows.push(["Summe", "", "", "", "", "", "", "", "", fmtKm(sumKm(trips)), (sumKm(trips) * CFG.kmRate).toFixed(2).replace(".", ","), ""]);
  const csv = "﻿" + [head, ...rows].map((r) => r.map(q).join(";")).join("\r\n");
  shareFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), `Fahrtenbuch-${file}.csv`);
}

function loadScript(src) {
  return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Datei " + src + " fehlt")); document.head.appendChild(s); });
}
async function exportPdf() {
  const { trips, label, file } = exportSel();
  if (!trips.length) return toast("Keine Fahrten im gewählten Zeitraum.");
  try {
    await loadScript("vendor/jspdf.umd.min.js"); await loadScript("vendor/jspdf.plugin.autotable.min.js");
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    doc.setFontSize(16); doc.text(`Fahrtenbuch – Geschäftsfahrten ${label}`, 14, 16);
    doc.setFontSize(10);
    const info = [S.profile.name && `Name: ${S.profile.name}`, S.profile.plate && `Kennzeichen: ${S.profile.plate}`, `Erstellt am ${fmtDateShort(new Date().toISOString())}`].filter(Boolean).join("   ·   ");
    doc.text(info, 14, 22);
    doc.autoTable({
      startY: 27, styles: { fontSize: 8, cellPadding: 1.6, overflow: "linebreak" }, headStyles: { fillColor: [23, 92, 211] },
      head: [["Datum", "Zeit", "Start", "Ziel", "Zweck", "Geschäftspartner", "km-Stand", "km"]],
      body: trips.map((t) => [fmtDateShort(t.started_at), t.without_time ? "–" : `${fmtTime(t.started_at)}–${fmtTime(t.ended_at)}`, t.start_address || "", t.end_address || "",
        t.purpose || "", t.partner || "", t.odometer_start != null || t.odometer_end != null ? `${t.odometer_start ?? "?"} – ${t.odometer_end ?? "?"}` : "", fmtKm(t.distance_km)]),
      columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 20 }, 2: { cellWidth: 52 }, 3: { cellWidth: 52 }, 4: { cellWidth: 42 }, 5: { cellWidth: 36 }, 6: { cellWidth: 26 }, 7: { cellWidth: 16, halign: "right" } },
      foot: [["", "", "", "", "", "", "Summe", fmtKm(sumKm(trips))]], footStyles: { fillColor: [244, 246, 250], textColor: 20, fontStyle: "bold" },
    });
    let y = doc.lastAutoTable.finalY + 8;
    if (S.exportRange === "year") {
      const months = MONTHS.map((m, i) => { const ts = tripsIn(S.year, i); return [m, ts.length, fmtKm(sumKm(ts)), fmtEur(sumKm(ts) * CFG.kmRate)]; }).filter((r) => r[1] > 0);
      doc.autoTable({ startY: y, tableWidth: 120, styles: { fontSize: 9 }, headStyles: { fillColor: [23, 92, 211] },
        head: [["Monat", "Fahrten", "km", `× ${CFG.kmRate.toFixed(2).replace(".", ",")} €`]], body: months,
        foot: [["Jahr " + S.year, trips.length, fmtKm(sumKm(trips)), fmtEur(sumKm(trips) * CFG.kmRate)]], footStyles: { fillColor: [244, 246, 250], textColor: 20, fontStyle: "bold" } });
      y = doc.lastAutoTable.finalY + 8;
    }
    doc.setFontSize(11);
    doc.text(`Geschäftlich gefahren: ${fmtKm(sumKm(trips))} km × ${String(CFG.kmRate.toFixed(2)).replace(".", ",")} € = ${fmtEur(sumKm(trips) * CFG.kmRate)}`, 14, y);
    shareFile(doc.output("blob"), `Fahrtenbuch-${file}.pdf`);
  } catch (e) { toast("PDF konnte nicht erstellt werden: " + e.message, 6000); }
}

/* ---------- Darstellung ---------- */
let toastTimer;
function toast(msg, ms = 2600) {
  document.querySelector(".toast")?.remove();
  const d = document.createElement("div"); d.className = "toast"; d.textContent = msg; document.body.appendChild(d);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => d.remove(), ms);
}

function statusHtml() {
  const n = dirtyCount(); const s = S.sync;
  const cls = !navigator.onLine ? "off" : s.state === "err" ? "err" : n || s.running ? "wait" : "";
  const txt = !navigator.onLine ? (n ? `offline · ${n} offen` : "offline") : s.state === "err" ? "Fehler" : s.running ? "gleicht ab …" : n ? `${n} offen` : "aktuell";
  return `<span class="dot ${cls}"></span>${txt}`;
}
function renderStatus() { const el = $("#syncbtn"); if (el) el.innerHTML = statusHtml(); }

function tripCard(t) {
  const tags = [];
  if (!t.purpose?.trim()) tags.push('<span class="tag miss">Zweck fehlt</span>');
  if (t.distance_source === "luftlinie") tags.push('<span class="tag est">km geschätzt</span>');
  if (t._dirty) tags.push('<span class="tag pend">nicht hochgeladen</span>');
  const from = t.start_address || (t.start_lat != null ? "Adresse wird ermittelt …" : "Start fehlt");
  const to = t.end_address || (t.end_lat != null ? "Adresse wird ermittelt …" : "Ziel fehlt");
  return `<button class="trip" data-act="open" data-id="${t.id}">
    <div class="t1"><span>${fmtDate(t.started_at)}</span><span>${fmtKm(t.distance_km)} km</span></div>
    <div class="t2">${t.without_time ? "ohne Uhrzeit" : `${fmtTime(t.started_at)}–${fmtTime(t.ended_at)}`} · ${esc(from)} → ${esc(to)}</div>
    <div class="t2">${t.purpose ? esc(t.purpose) : ""}${t.partner ? " · " + esc(t.partner) : ""}${tags.join("")}</div>
  </button>`;
}

function banners() {
  const out = [];
  const n = dirtyCount();
  const oldest = Math.min(...TABLES.flatMap((t) => S[t].filter((x) => x._dirty).map((x) => x._dirtySince || Date.now())));
  if (n && Date.now() - oldest > UNSYNCED_WARN_DAYS * 86400000)
    out.push(`<div class="banner err"><b>${n} Änderung(en) seit über ${UNSYNCED_WARN_DAYS} Tagen nicht hochgeladen.</b><br>Bitte die App mit Internet öffnen, damit nichts verloren geht.${S.sync.error ? `<br><span class="small">Letzter Fehler: ${esc(S.sync.error)}</span>` : ""}</div>`);
  else if (S.sync.error) out.push(`<div class="banner err small">Abgleich fehlgeschlagen: ${esc(S.sync.error)}</div>`);
  if (S.sync.enrichError && navigator.onLine) out.push(`<div class="banner warn small">${esc(S.sync.enrichError)}</div>`);
  const miss = missingPurpose().length;
  if (miss) out.push(`<div class="banner warn"><b>${miss} Fahrt${miss > 1 ? "en" : ""} ohne Zweck.</b> Bitte zeitnah ergänzen.<button class="btn ghost" data-act="showMissing">Anzeigen</button></div>`);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent))
    out.push('<div class="banner info small"><b>Tipp:</b> Unten auf „Teilen“ <span aria-hidden="true">⎋</span> tippen → „Zum Home-Bildschirm“. Dann funktioniert das Fahrtenbuch wie eine App, auch offline, und gespeicherte Fahrten bleiben sicher erhalten.</div>');
  return out.join("");
}

function viewFahrt() {
  const a = activeTrip();
  const now = new Date();
  const month = tripsIn(now.getFullYear(), now.getMonth());
  const recent = doneTrips().slice(0, 3);
  const main = a ? `<div class="card live">
      <div class="muted">Geschäftsfahrt läuft seit ${fmtTime(a.started_at)} Uhr</div>
      <div class="clock" id="clock">0:00:00</div>
      <div class="muted small">${esc(a.start_address || (a.start_lat != null ? "Start: Standort gespeichert" : "Start ohne Standort"))}</div>
      <div class="spacer"></div>
      <button class="btn big red" data-act="end" ${S.busy ? "disabled" : ""}>${S.busy ? "Standort wird ermittelt …" : "Fahrt beenden"}</button>
      <button class="btn link" data-act="cancel">Fahrt verwerfen</button>
    </div>` : `<div class="card">
      <button class="btn big green" data-act="start" ${S.busy ? "disabled" : ""}>${S.busy ? "Standort wird ermittelt …" : "Geschäftsfahrt starten"}</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="new">Fahrt nachtragen</button>
    </div>`;
  return `${banners()}${main}
    <div class="card"><h2>${MONTHS[now.getMonth()]} ${now.getFullYear()}</h2>
      <div class="row"><div><div class="muted small">Fahrten</div><b>${month.length}</b></div>
      <div><div class="muted small">Kilometer</div><b>${fmtKm(sumKm(month))}</b></div>
      <div><div class="muted small">× ${String(CFG.kmRate.toFixed(2)).replace(".", ",")} €</div><b>${fmtEur(sumKm(month) * CFG.kmRate)}</b></div></div>
    </div>
    ${recent.length ? `<div class="month-h">Letzte Fahrten</div>${recent.map(tripCard).join("")}` : ""}`;
}

function viewFahrten() {
  let list = doneTrips(); if (S.onlyMissing) list = list.filter((t) => !t.purpose?.trim());
  let html = `<div class="chips"><button class="chip" data-act="toggleMissing">${S.onlyMissing ? "✓ " : ""}Nur ohne Zweck</button>
    <button class="chip" data-act="new">+ Fahrt nachtragen</button></div>`;
  if (!list.length) return html + `<p class="muted" style="margin-top:24px">${S.onlyMissing ? "Alle Fahrten haben einen Zweck. 👍" : "Noch keine Fahrten."}</p>`;
  let cur = "";
  for (const t of list) {
    const d = new Date(t.started_at); const key = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    if (key !== cur) { cur = key; const m = tripsIn(d.getFullYear(), d.getMonth()); html += `<div class="month-h">${key} · ${fmtKm(sumKm(m))} km</div>`; }
    html += tripCard(t);
  }
  return html;
}

function viewAuswertung() {
  const ys = years(); if (!ys.includes(S.year)) S.year = ys[0];
  const rows = MONTHS.map((m, i) => { const ts = tripsIn(S.year, i); return { m, i, n: ts.length, km: sumKm(ts) }; });
  const all = tripsIn(S.year);
  return `<div class="card"><div class="row"><h2 style="margin:0">Auswertung</h2>
      <select id="yearSel">${ys.map((y) => `<option ${y === S.year ? "selected" : ""}>${y}</option>`).join("")}</select></div>
    <table class="sum"><tr><th>Monat</th><th>Fahrten</th><th>km</th><th>€</th></tr>
      ${rows.map((r) => `<tr><td>${r.m}</td><td>${r.n || "–"}</td><td>${r.n ? fmtKm(r.km) : "–"}</td><td>${r.n ? fmtEur(r.km * CFG.kmRate) : "–"}</td></tr>`).join("")}
      <tr class="total"><td>Summe ${S.year}</td><td>${all.length}</td><td>${fmtKm(sumKm(all))}</td><td>${fmtEur(sumKm(all) * CFG.kmRate)}</td></tr>
    </table>
    <p class="muted small">Betrag = Geschäftskilometer × ${String(CFG.kmRate.toFixed(2)).replace(".", ",")} € (Kilometerpauschale Privatauto). Keine Steuerberatung.</p></div>
    <div class="card"><h2>Exportieren</h2>
      <label for="rangeSel">Zeitraum</label>
      <select id="rangeSel"><option value="year">Ganzes Jahr ${S.year}</option>
        ${rows.filter((r) => r.n).map((r) => `<option value="${r.i}" ${String(r.i) === S.exportRange ? "selected" : ""}>${r.m} ${S.year}</option>`).join("")}</select>
      <div class="spacer"></div>
      <div class="row"><button class="btn" data-act="pdf">PDF</button><button class="btn ghost" data-act="csv">Excel / CSV</button></div>
      ${missingPurpose().length ? '<p class="small" style="color:var(--amber)">Hinweis: Es gibt noch Fahrten ohne Zweck.</p>' : ""}
    </div>`;
}

function viewMehr() {
  const places = alive(S.places).sort((a, b) => a.name.localeCompare(b.name));
  const tpls = alive(S.templates).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="card"><h2>Gespeicherte Orte</h2>
      <p class="muted small">Orte werden beim Start/Ende einer Fahrt automatisch erkannt (Umkreis 200 m).</p>
      ${places.map((p) => `<div class="row" style="margin:8px 0"><div><b>${esc(p.name)}</b><div class="muted small">${esc(p.address || `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`)}</div></div>
        <div style="flex:0 0 auto"><button class="chip" data-act="renamePlace" data-id="${p.id}">Umbenennen</button> <button class="chip" data-act="delPlace" data-id="${p.id}">Löschen</button></div></div>`).join("") || '<p class="muted small">Noch keine Orte.</p>'}
      <button class="btn ghost" data-act="addPlace" ${S.busy ? "disabled" : ""}>Aktuellen Standort als Ort speichern</button>
    </div>
    <div class="card"><h2>Kunden &amp; Vorlagen</h2>
      <p class="muted small">Füllen Zweck und Geschäftspartner mit einem Tipp aus. Kunden mit Adresse und km tragen unter „Fahrt nachtragen“ Hin- und Rückfahrt ein.</p>
      ${tpls.map((t) => `<div class="row" style="margin:8px 0"><div><b>${esc(t.name)}</b><div class="muted small">${esc([t.purpose, t.partner, t.address, t.distance_km != null ? fmtKm(t.distance_km) + " km einfach" : ""].filter(Boolean).join(" · "))}</div></div>
        <div style="flex:0 0 auto"><button class="chip" data-act="editTpl" data-id="${t.id}">Bearbeiten</button> <button class="chip" data-act="delTpl" data-id="${t.id}">Löschen</button></div></div>`).join("") || '<p class="muted small">Noch keine Kunden oder Vorlagen.</p>'}
      <button class="btn ghost" data-act="addTpl">Kunde / Vorlage anlegen</button>
    </div>
    <div class="card"><h2>Angaben für den Ausdruck</h2>
      <label for="p_name">Name / Firma</label><input id="p_name" value="${esc(S.profile.name || "")}" autocomplete="name">
      <label for="p_plate">Kennzeichen</label><input id="p_plate" value="${esc(S.profile.plate || "")}" placeholder="z. B. NU-AB 123">
      <label for="p_home">Heimatadresse (Start für Hin- und Rückfahrt zu Kunden)</label><input id="p_home" value="${esc(S.profile.home || "")}" placeholder="Straße Nr., PLZ Ort" autocomplete="street-address">
      <div class="spacer"></div><button class="btn ghost" data-act="saveProfile">Speichern</button>
    </div>
    <div class="card"><h2>Abgleich</h2>
      <p class="small">Letzter Abgleich: ${S.sync.last ? `${fmtDateShort(S.sync.last)} ${fmtTime(S.sync.last)}` : "noch nie"}<br>
      Nicht hochgeladen: ${dirtyCount()}<br>Verbindung: ${navigator.onLine ? "online" : "offline"}</p>
      ${S.sync.error ? `<p class="small" style="color:var(--red)">${esc(S.sync.error)}</p>` : ""}
      <button class="btn ghost" data-act="sync">Jetzt abgleichen</button>
    </div>
    <div class="card"><h2>Konto</h2><p class="small">Angemeldet als ${esc(S.user?.email || "")}</p>
      <button class="btn link" data-act="signout" style="color:var(--red)">Abmelden</button></div>`;
}

function sheetTrip() {
  const t = S.sheet.id ? S.trips.find((x) => x.id === S.sheet.id) : null;
  const isNew = !t;
  const st = t?.started_at || new Date().toISOString();
  const placeOpts = alive(S.places).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  const custChips = customers().map((tp) => `<button class="chip" data-act="rt" data-id="${tp.id}">${esc(tp.name)}</button>`).join("");
  const tplChips = alive(S.templates).map((tp) => `<button class="chip" data-act="tpl" data-id="${tp.id}">${esc(tp.name)}</button>`).join("");
  const src = { route: "berechnet (Route)", luftlinie: "geschätzt – wird mit Internet genau berechnet", manuell: "von Hand eingetragen" }[t?.distance_source] || "";
  const odoStart = t ? t.odometer_start : lastOdometer();
  if (!S.sheet.init) S.sheet.init = { start: t?.start_address || "", end: t?.end_address || "", km: t?.distance_km != null ? Number(t.distance_km) : null };
  return `<div class="sheet-bg" data-act="closeBg"><div class="sheet" role="dialog" aria-modal="true">
    <div class="sh"><h2>${isNew ? "Fahrt nachtragen" : S.sheet.afterEnd ? "Fahrt beendet" : "Fahrt bearbeiten"}</h2><button class="x" data-act="close" aria-label="Schließen">×</button></div>
    ${S.sheet.afterEnd ? `<p class="muted small" style="margin:0">${fmtKm(t.distance_km)} km${t.distance_source === "luftlinie" ? " (vorläufig)" : ""} – jetzt Zweck und Geschäftspartner eintragen.</p>` : ""}
    <div id="f_err" class="banner err small" hidden></div>
    ${isNew && custChips ? `<label>Hin- und Rückfahrt zu Kunde</label><div class="chips">${custChips}</div>` : ""}
    <label for="f_purpose">Zweck der Fahrt</label><input id="f_purpose" value="${esc(t?.purpose || "")}" placeholder="z. B. Kundentermin, Lieferung, Einkauf Material">
    ${tplChips ? `<div class="chips">${tplChips}</div>` : ""}
    <label for="f_partner">Geschäftspartner / Firma</label><input id="f_partner" value="${esc(t?.partner || "")}">
    <div class="row"><div><label for="f_date">Datum</label><input id="f_date" type="date" value="${localDate(st)}"></div></div>
    <div class="row"><div><label for="f_t1">Beginn</label><input id="f_t1" type="time" value="${t && !t.without_time ? localTime(t.started_at) : ""}"></div>
      <div><label for="f_t2">Ende</label><input id="f_t2" type="time" value="${t?.ended_at && !t.without_time ? localTime(t.ended_at) : ""}"></div></div>
    ${t?.without_time ? '<p class="muted small" style="margin:4px 0 0">Ohne Uhrzeit nachgetragen – Zeitfelder dürfen leer bleiben.</p>' : ""}
    <label for="f_start">Start</label><input id="f_start" value="${esc(t?.start_address || "")}" placeholder="${t?.start_lat != null ? "Adresse wird ermittelt …" : "Adresse"}">
    ${placeOpts ? `<select data-place="start"><option value="">Gespeicherten Ort wählen …</option>${placeOpts}</select>` : ""}
    <label for="f_end">Ziel</label><input id="f_end" value="${esc(t?.end_address || "")}" placeholder="${t?.end_lat != null ? "Adresse wird ermittelt …" : "Adresse"}">
    ${placeOpts ? `<select data-place="end"><option value="">Gespeicherten Ort wählen …</option>${placeOpts}</select>` : ""}
    <label for="f_km">Kilometer ${src ? `<span class="small">(${src})</span>` : ""}</label>
    <input id="f_km" inputmode="decimal" value="${t?.distance_km != null ? String(t.distance_km).replace(".", ",") : ""}">
    <div class="row"><div><label for="f_o1">km-Stand Beginn (freiwillig)</label><input id="f_o1" inputmode="numeric" value="${odoStart ?? ""}"></div>
      <div><label for="f_o2">km-Stand Ende</label><input id="f_o2" inputmode="numeric" value="${t?.odometer_end ?? ""}"></div></div>
    <button class="btn link" data-act="odo">Kilometer aus km-Stand übernehmen</button>
    <label for="f_notes">Notiz (z. B. Umweg wegen Stau)</label><textarea id="f_notes">${esc(t?.notes || "")}</textarea>
    <div class="spacer"></div>
    <button class="btn" data-act="saveTrip">Speichern</button>
    <div class="chips" style="margin-top:12px">
      <button class="chip" data-act="asTpl">Als Vorlage speichern</button>
      ${t?.end_lat != null ? '<button class="chip" data-act="endPlace">Ziel als Ort speichern</button>' : ""}
      ${t?.start_lat != null && t?.end_lat != null ? '<button class="chip" data-act="recalc">km neu berechnen</button>' : ""}
      ${t ? '<button class="chip" data-act="hist">Änderungsverlauf</button>' : ""}
      ${t ? '<button class="chip" data-act="delTrip" style="color:var(--red)">Löschen</button>' : ""}
    </div>
    <div id="f_hist"></div>
  </div></div>`;
}

function viewLogin() {
  const reg = S.loginMode === "register";
  return `<div class="login">
    <h1>Fahrtenbuch</h1><p class="muted">${reg ? "Neues Konto anlegen" : "Bitte anmelden"}</p>
    <div id="l_msg"></div>
    <form id="loginForm">
      <label for="l_email">E-Mail</label><input id="l_email" type="email" autocomplete="username" required>
      <label for="l_pw">Passwort</label><input id="l_pw" type="password" autocomplete="${reg ? "new-password" : "current-password"}" minlength="8" required>
      ${reg ? '<p class="muted small">Mindestens 8 Zeichen. Das iPhone kann das Passwort im Schlüsselbund speichern, dann geht die Anmeldung mit Face ID.</p>' : ""}
      <div class="spacer"></div><button class="btn" type="submit">${reg ? "Konto anlegen" : "Anmelden"}</button>
    </form>
    <button class="btn link" data-act="loginMode">${reg ? "Ich habe schon ein Konto" : "Neues Konto anlegen"}</button>
  </div>`;
}

// während ein Formular offen ist, nur die Statusanzeige aktualisieren (Eingaben nicht verlieren)
function refresh() { if (S.sheet) renderStatus(); else render(); }

let clockTimer;
function render() {
  const app = $("#app");
  clearInterval(clockTimer);
  if (!S.user) { app.innerHTML = viewLogin(); bindLogin(); return; }
  const scroll = window.scrollY;
  const views = { fahrt: viewFahrt, fahrten: viewFahrten, auswertung: viewAuswertung, mehr: viewMehr };
  const titles = { fahrt: "Fahrtenbuch", fahrten: "Fahrten", auswertung: "Auswertung", mehr: "Mehr" };
  app.innerHTML = `<header class="top"><h1>${titles[S.tab]}</h1><button class="sync" id="syncbtn" data-act="sync">${statusHtml()}</button></header>
    <main>${views[S.tab]()}</main>
    <nav class="tabs">${[["fahrt", "🚗", "Fahrt"], ["fahrten", "📋", "Fahrten"], ["auswertung", "📊", "Auswertung"], ["mehr", "⚙️", "Mehr"]]
      .map(([k, ic, l]) => `<button class="${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}"><span class="ic">${ic}</span>${l}</button>`).join("")}</nav>
    ${S.sheet?.type === "trip" ? sheetTrip() : S.sheet?.type === "tpl" ? sheetTemplate() : S.sheet?.type === "rt" ? sheetRoundTrip() : ""}`;
  if (!S.sheet) window.scrollTo(0, scroll);
  const a = activeTrip();
  if (a && S.tab === "fahrt") {
    const tick = () => { const s = Math.max(0, Math.floor((Date.now() - new Date(a.started_at)) / 1000)); const el = $("#clock"); if (el) el.textContent = `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
    tick(); clockTimer = setInterval(tick, 1000);
  }
  $("#yearSel")?.addEventListener("change", (e) => { S.year = Number(e.target.value); S.exportRange = "year"; render(); });
  $("#rangeSel")?.addEventListener("change", (e) => { S.exportRange = e.target.value; });
  document.querySelectorAll("select[data-place]").forEach((sel) => sel.addEventListener("change", () => applyPlace(sel.dataset.place, sel.value)));
}

function bindLogin() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#l_email").value.trim(), password = $("#l_pw").value, msg = $("#l_msg");
    const show = (cls, t) => { msg.innerHTML = `<div class="banner ${cls}">${esc(t)}</div>`; };
    if (!navigator.onLine) return show("err", "Zum Anmelden wird einmalig Internet benötigt.");
    show("info", "Bitte warten …");
    if (S.loginMode === "register") {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) return show("err", authError(error));
      if (!data.session) return show("info", "Fast fertig: Bitte den Link in der Bestätigungs-Mail antippen und danach hier anmelden.");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return show("err", authError(error));
    }
  });
}
function authError(e) {
  const m = e.message || "";
  if (/Invalid login/i.test(m)) return "E-Mail oder Passwort stimmt nicht.";
  if (/not confirmed/i.test(m)) return "Die E-Mail-Adresse ist noch nicht bestätigt. Bitte den Link in der Bestätigungs-Mail antippen.";
  if (/already registered/i.test(m)) return "Für diese E-Mail gibt es schon ein Konto. Bitte anmelden.";
  if (/Signups not allowed/i.test(m)) return "Neue Konten sind gesperrt.";
  return "Fehler: " + m;
}

/* ---------- Klicks ---------- */
const ACT = {
  tab: (el) => { S.tab = el.dataset.tab; S.sheet = null; render(); window.scrollTo(0, 0); },
  start: startTrip, end: endTrip, cancel: cancelTrip, new: newTrip,
  open: (el) => openTrip(el.dataset.id),
  close: () => { S.sheet = null; render(); },
  closeBg: (el, ev) => { if (ev.target === el) { S.sheet = null; render(); } },
  saveTrip, delTrip: deleteTrip, recalc: recalcTrip, hist: showHistory, odo: odoToKm,
  tpl: (el) => applyTemplate(el.dataset.id), asTpl: tripAsTemplate, endPlace: tripEndAsPlace,
  showMissing: () => { S.tab = "fahrten"; S.onlyMissing = true; render(); },
  toggleMissing: () => { S.onlyMissing = !S.onlyMissing; render(); },
  pdf: exportPdf, csv: exportCsv,
  addPlace: addPlaceHere, renamePlace: (el) => renamePlace(el.dataset.id), delPlace: (el) => deletePlace(el.dataset.id),
  addTpl: () => openTemplate(), editTpl: (el) => openTemplate(el.dataset.id), saveTpl: saveTemplate, calcTpl: calcTemplateKm,
  rt: (el) => openRoundTrip(el.dataset.id), saveRt: saveRoundTrip, delTpl: (el) => deleteTemplate(el.dataset.id), saveProfile,
  sync: () => { if (!navigator.onLine) return toast("Gerade kein Internet – wird automatisch nachgeholt."); sync(); },
  signout: signOut,
  loginMode: () => { S.loginMode = S.loginMode === "register" ? "login" : "register"; render(); },
};
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  if (el.dataset.act !== "closeBg") ev.preventDefault();
  Promise.resolve(fn(el, ev)).catch((e) => toast("Fehler: " + e.message, 6000));
});

/* ---------- Start ---------- */
async function setUser(u) {
  const changed = u && S.user && S.user.id !== u.id;
  if (u && (await metaGet("userId")) && (await metaGet("userId")) !== u.id) { for (const t of [...TABLES, "meta"]) await idbClear(t); }
  S.user = u ? { id: u.id, email: u.email } : null;
  if (u) {
    await metaSet("userId", u.id); await metaSet("user", S.user);
    const prof = u.user_metadata?.fb_profile; if (prof && !(await metaGet("profile"))) await metaSet("profile", prof);
    await loadLocal();
    if (changed) S.tab = "fahrt";
  }
  render();
  if (u) scheduleSync(100);
}

async function boot() {
  if ("serviceWorker" in navigator) {
    // neue Version: einmal neu laden, sobald der neue Offline-Speicher aktiv ist
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded && !S.sheet && !S.busy) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  }
  try { if (navigator.storage?.persist) navigator.storage.persist(); } catch (_) {}
  // offline starten: zuletzt angemeldetes Konto aus dem lokalen Speicher
  const cached = await metaGet("user").catch(() => null);
  if (cached) { S.user = cached; await loadLocal(); }
  render();
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === "SIGNED_OUT") { if (S.user) { S.user = null; render(); } return; }
    if (session?.user && (ev === "SIGNED_IN" || ev === "INITIAL_SESSION" || ev === "USER_UPDATED")) {
      if (!S.user || S.user.id !== session.user.id || ev === "SIGNED_IN") setTimeout(() => setUser(session.user), 0);
      else scheduleSync(100);
    }
  });
  window.addEventListener("online", () => { refresh(); scheduleSync(500); });
  window.addEventListener("offline", () => refresh());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refresh(); scheduleSync(300); } });
  setInterval(() => scheduleSync(0), 120000);
}
boot().catch((e) => { $("#app").innerHTML = `<div class="login"><h1>Fahrtenbuch</h1><div class="banner err">Start fehlgeschlagen: ${esc(e.message)}</div></div>`; });
})();
