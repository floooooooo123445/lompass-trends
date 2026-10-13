# lompass-trends

Die Trends des Monats für Haiko — eine Datei für alle (Stufe 415).

## Was der Job tut

Am 1. jedes Monats um 06:17 UTC fragt `erzeuge.mjs` die Schnittstelle von
Anthropic einmal mit Websuche nach den Trends des Monats auf TikTok und
Instagram: je Plattform 5–10 Trends mit Titel und Beschreibung (deutsch und
englisch), Quelle und 3–8 öffentlichen Videos. Jede Video-Adresse wird über
oEmbed von TikTok oder YouTube geprüft, tote fallen. Bleibt je Plattform
mindestens ein Trend, schreibt der Job `aktuell.json` und
`archiv/JJJJ-MM.json` und committet beide. Sonst bricht er ab, und die alte
Datei bleibt.

Die App lädt nur `aktuell.json`, ohne Schlüssel:
`https://raw.githubusercontent.com/floooooooo123445/lompass-trends/main/aktuell.json`

## Was er kostet

Etwa 1–2 $ im Monat über deinen Anthropic-Schlüssel (Websuche 10 $ je 1000
Suchen, höchstens 20 je Lauf, dazu die Tokens). GitHub Actions ist in einem
öffentlichen Repo kostenlos.

## Einrichten

1. Öffentliches Repo `lompass-trends` anlegen, den Inhalt dieses Ordners
   hineinlegen (samt `.github/`).
2. Settings → Secrets and variables → Actions → New repository secret:
   Name `ANTHROPIC_API_KEY`, Wert dein Schlüssel.
3. Settings → Actions → General → Workflow permissions: „Read and write
   permissions".

## Von Hand anstoßen

Actions → „Trends des Monats" → „Run workflow".

Ohne Commit im Repo schaltet GitHub einen Zeitplan nach 60 Tagen ab; der
monatliche Commit der Datei hält ihn wach.
