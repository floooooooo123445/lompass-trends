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

## In der Nähe (seit Stufe 598)

Täglich um 03:29 UTC liest `nahe.mjs` die Quellen aus `nahe-quellen.json`
und schreibt je Stadt `nahe/<stadt>.json` — die Termine ab heute, die
nächsten zuerst, höchstens 300. Keine KI, kein Schlüssel, kein Secret.

**Die Quellenliste** nennt je Quelle `stadt` (die Kennung wie in der App:
„Nürnberg" → `nuernberg`), `art` (`ical`, `rss` oder `jsonld`), `url` (genau
eine https-Adresse), `lizenz` (wörtlich, wie der Herausgeber sie nennt),
dazu `herausgeber`, `nachweis` (die Seite, auf der die Lizenz steht), `ort`
(der Ort eines Termins, wenn die Quelle keinen nennt) und `seite` (die Seite
für einen Termin ohne eigene Adresse). Bei `art: rss` gilt `pubDate` nur als
Beginn, wenn die Quelle `"beginnAus": "pubDate"` trägt (sonst ist es der Tag
der Meldung, und nur `ev:startdate` zählt); Mitternacht heißt dort „ohne
Uhrzeit". `"ortAus": "kopf"` nimmt den Ort aus dem fetten Kopf der Meldung
(„<Zeit> - <Ort> - ", Kalender der Stadt Karlsruhe). Online-Termine fallen.
Von einer iCal-Serie zählt nur der erste Termin (`RRULE` liest der Job
nicht). Eine Quelle ohne Lizenz, ohne https
oder auf einer Plattform (TikTok, Instagram, Facebook, X, YouTube, Threads)
liest der Job nicht. Eine Stadt ohne Quelle mit klarer Lizenz steht nicht in
der Liste.

**Der Abruf** ist höflich: Name `lompass-trends/1.0`, `robots.txt`, eine
Anfrage je Sekunde und Gegenstelle, ohne Login, ohne Kekse, eine Weiterleitung
nur auf derselben Gegenstelle. Er holt nur die Adresse der Liste und folgt
keinem Link daraus. Bilder übernimmt er nicht (`bild: null`): Die Lizenz
einer Quelle gilt ihren Daten, nicht den Bildern darin.

**Die Datei** liest die App ohne Schlüssel:
`https://raw.githubusercontent.com/floooooooo123445/lompass-trends/main/nahe/<stadt>.json`.
Sie trägt `stadt`, `stand`, `quellen` (Herausgeber, Lizenz, Nachweis) und
`termine` (Titel, Ort, Beginn in Ortszeit, Kategorie, Adresse der Quelle).
Findet der Job für eine Stadt nichts, bleibt ihre alte Datei.

**Am Rechner:** `node nahe.mjs --stadt karlsruhe` (eine Stadt), `--ziel
<ordner>` (anderswohin schreiben). Ohne Netz: `--pruefe -`, `--quellen -` und
`--lies -` lesen von stdin (für die Tests im Hauptrepo).

**Einrichten:** nichts außer „Read and write permissions" (wie für die
Trends). Actions → „In der Nähe" → „Run workflow" für den ersten Lauf.
