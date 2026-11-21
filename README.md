# Fahrtenbuch

Web-App für **Geschäftsfahrten mit dem Privatauto**. Gemacht fürs iPhone,
ohne App-Store: Seite in Safari öffnen, dann „Teilen“ → „Zum Home-Bildschirm“.

## Funktionen

- Großer Knopf **„Geschäftsfahrt starten“**/**„Fahrt beenden“**: Uhrzeit und
  Standort werden gespeichert, Adresse und Straßenkilometer automatisch ermittelt
- **Gespeicherte Orte** (z. B. „Büro“, „Kunde Müller“) werden im Umkreis von
  200 m automatisch erkannt
- **Zweck und Geschäftspartner** direkt nach der Fahrt oder später eintragen;
  **Vorlagen** füllen beides mit einem Tipp aus; Hinweis auf Fahrten ohne Zweck
- **Fahrten nachtragen**, bearbeiten, löschen; Kilometerstand freiwillig
- **Kunden** mit Adresse und km ab Zuhause: unter „Fahrt nachtragen“ Kunde
  antippen → Hin- und Rückfahrt werden mit Datum und km (ohne Uhrzeit)
  als zwei Fahrten eingetragen
- **Monats- und Jahresübersicht** mit Kilometerpauschale (km × 0,30 €)
- **Export** als PDF (zum Abheften/Ausdrucken) und CSV (Excel, Steuerberater)
- **Änderungsverlauf**: jede Änderung und Löschung wird auf dem Server
  protokolliert und ist in der App einsehbar (lässt sich nicht verändern)
- **Offline**: App startet ohne Internet, Fahrten werden auf dem iPhone
  gespeichert und später hochgeladen; Adresse und km werden dann nachgetragen

## Aufbau

| Teil | Wo |
|---|---|
| Web-App (HTML/CSS/JS, ohne Build-Schritt) | Repo-Wurzel, ausgeliefert über GitHub Pages |
| Datenbank + Anmeldung | Supabase-Projekt „Fahrtenbuch“ (`mvzvzqejytwabvcmibgf`, Frankfurt) |
| Straßenkilometer | Supabase Edge Function `route` → OSRM (OpenStreetMap) |
| Adressen | direkt vom iPhone → Photon, ersatzweise Nominatim (OpenStreetMap); die Dienste sperren Anfragen von Supabase-Servern |
| Datenbank-Schema | `supabase/migrations/` |

Bibliotheken liegen in `vendor/` (supabase-js, jsPDF, jsPDF-AutoTable; alle MIT).

## Datenschutz

- Jede Nutzerin sieht nur ihre eigenen Daten (Row Level Security).
- Der Schlüssel in `config.js` ist der öffentliche „Publishable Key“ von
  Supabase – er ist absichtlich im Code und gibt ohne Anmeldung keinen
  Zugriff auf Daten.
- Standorte werden nur beim Tippen auf Start/Ende abgefragt, nicht dauerhaft.
- Für die Adresse schickt das iPhone die Koordinaten direkt an Photon
  (komoot) bzw. Nominatim; für die Kilometer gehen Start und Ziel über die
  Supabase-Funktion an OSRM. Alles OpenStreetMap-Dienste, ohne Konto.

## Einrichtung (einmalig)

1. **GitHub Pages:** Repo → Settings → Pages → „Deploy from a branch“ →
   `main` / `(root)`.
2. **Supabase → Authentication → URL Configuration:** „Site URL“ auf die
   Pages-Adresse setzen (z. B. `https://nicojay777.github.io/Fahrtenbuch/` (großes F!)),
   damit der Link in der Bestätigungs-Mail zur App führt.
3. Konto in der App anlegen und E-Mail bestätigen.
4. Danach **Supabase → Authentication → Sign In / Providers →
   „Allow new users to sign up“ ausschalten**, damit niemand sonst ein Konto anlegt.

## Neue Version ausliefern

In `sw.js` die `VERSION` erhöhen (z. B. `fb-v2`), sonst behält das iPhone
die alte Version im Offline-Speicher.
