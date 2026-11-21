# Fahrtenbuch – Hinweise für KI-Assistenten

Web-App (reines HTML/CSS/JS ohne Build-Schritt) für Geschäftsfahrten mit dem
Privatauto, genutzt als Home-Bildschirm-App auf dem iPhone. Backend:
Supabase-Projekt „Fahrtenbuch“ (`mvzvzqejytwabvcmibgf`).

## Verbindliche Regeln

- Antworten und Texte auf Deutsch.
- Erst lesen, dann nur tatsächliche Fehler beheben; keine kosmetischen
  Refactorings ohne Auftrag.
- Nur Geschäftsfahrten – keine Privatfahrten-Erfassung einbauen.
- Offline zuerst: jede Eingabe wird sofort in IndexedDB gespeichert und
  später abgeglichen. Hintergrund-Abgleich darf nie Eingaben überschreiben
  (immer den aktuellen Datensatz neu holen, nur geänderte Felder setzen).
- Fahrten werden nie hart gelöscht (`deleted_at`); `trip_history` ist nur
  lesbar und wird per Trigger geschrieben.
- Keine Tracking-/Werbe-Skripte, keine externen CDNs (alles in `vendor/`).
- Bei jeder Auslieferung `VERSION` in `sw.js` erhöhen.
- Schemaänderungen als neue Datei in `supabase/migrations/` ablegen.
- Funktionen, die nur auf dem iPhone prüfbar sind (Standort, Teilen,
  Home-Bildschirm), als „ungetestet auf Gerät“ kennzeichnen.
