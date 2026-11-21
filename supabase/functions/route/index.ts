// Fahrtenbuch: Adresse zu Koordinaten (Nominatim/OpenStreetMap) und Straßenkilometer (OSRM).
// Aufruf nur mit gültiger Anmeldung (verify_jwt).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const UA = "Fahrtenbuch-privat/1.0 (Supabase Edge Function)";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function validPoint(p: any) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

async function reverse(p: { lat: number; lng: number }): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=de&lat=${p.lat}&lon=${p.lng}`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Adressdienst antwortet mit ${r.status}`);
  const d = await r.json();
  const a = d.address ?? {};
  const street = [a.road ?? a.pedestrian ?? a.footway, a.house_number].filter(Boolean).join(" ");
  const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.suburb;
  const plzOrt = [a.postcode, town].filter(Boolean).join(" ");
  const name = d.name && d.name !== a.road ? d.name : null;
  const s = [name, street, plzOrt].filter(Boolean).join(", ");
  return s || d.display_name || null;
}

async function route(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Routendienst antwortet mit ${r.status}`);
  const d = await r.json();
  if (d.code !== "Ok" || !d.routes?.length) throw new Error(`Keine Route gefunden (${d.code})`);
  return { km: Math.round(d.routes[0].distance / 100) / 10, minutes: Math.round(d.routes[0].duration / 60) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }
  try {
    if (body.action === "reverse") {
      if (!validPoint(body.point)) return json({ error: "Ungültige Koordinaten" }, 400);
      return json({ address: await reverse(body.point) });
    }
    if (body.action === "route") {
      if (!validPoint(body.start) || !validPoint(body.end)) return json({ error: "Ungültige Koordinaten" }, 400);
      return json(await route(body.start, body.end));
    }
    return json({ error: "Unbekannte Aktion" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
