// Stufe 415 — die Trends des Monats, erzeugt einmal im Monat für alle.
//
// > „Da ist doof das man sich die über einen KI Knopf holen muss, es wäre
// > besser wenn das einfach monatlich von selbst für jeden Nutzer gleich
// > aktualisiert." (der Nutzer, 13.10.2026) — seine Wahl: „Vorschaubilder,
// > Tipp öffnet App (Recommended)"
//
// Dieses Skript läuft im öffentlichen Repo `lompass-trends` als GitHub-Job
// (`.github/workflows/monat.yml`), am 1. jedes Monats. Es fragt die
// Messages-API von Anthropic einmal, mit Websuche, nach den Trends des
// laufenden Monats auf TikTok und Instagram, prüft jede Video-Adresse über
// oEmbed und schreibt `aktuell.json` und `archiv/JJJJ-MM.json`. Der Schlüssel
// kommt als Secret `ANTHROPIC_API_KEY` herein — er liegt nie im Repo und nie in
// der App (harte Regel 6, Vermerk 415).
//
// Node 22, keine Abhängigkeit.
//
//   node erzeuge.mjs                 der Lauf (braucht ANTHROPIC_API_KEY)
//   node erzeuge.mjs --pruefe -      prüft eine Datei von stdin, ohne Netz,
//                                    und schreibt das Ergebnis als JSON
//                                    (`null` für eine Datei, die wie keine ist)
//
// **Die Regeln sind eine Kopie** von `src/domain/trends-datei.ts` in der App.
// Der Test `src/domain/__tests__/trends-datei-vorlage.test.ts` im Hauptrepo
// vergleicht die Grenzen unten mit denen der App und lässt beide Prüfungen
// über dieselben Eingaben laufen. Wer hier etwas ändert, ändert es dort mit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// GRENZEN-ANFANG
const GRENZEN = {
  "version": 1,
  "titelMax": 40,
  "beschreibungMax": 200,
  "trendsJePlattformMax": 12,
  "videosMax": 8,
  "kennungMax": 60,
  "plattformen": ["tiktok", "instagram"],
  "bereiche": ["format", "sound", "spruch", "bewegung", "verhalten", "humor"],
  "videoHosts": {
    "tiktok": ["www.tiktok.com", "tiktok.com", "m.tiktok.com"],
    "youtube": ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
    "instagram": ["www.instagram.com", "instagram.com"]
  }
};
// GRENZEN-ENDE

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;
const KENNUNG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YOUTUBE_KENNUNG = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_KENNUNG = /^\d{1,25}$/;
const INSTAGRAM_KENNUNG = /^[A-Za-z0-9_-]{1,40}$/;
const CREATOR_MAX = 60;
const VIDEO_PLATTFORMEN = Object.keys(GRENZEN.videoHosts);

// ---------------------------------------------------------------------------
// Die Prüfung — dieselben Regeln wie `src/domain/trends-datei.ts`.
// ---------------------------------------------------------------------------

function istObjekt(wert) {
  return typeof wert === 'object' && wert !== null && !Array.isArray(wert);
}

function text(wert, max) {
  if (typeof wert !== 'string') {
    return null;
  }
  const getrimmt = wert.trim();
  return getrimmt.length === 0 || getrimmt.length > max ? null : getrimmt;
}

function zweisprachig(wert, max) {
  if (!istObjekt(wert)) {
    return null;
  }
  const de = text(wert.de, max);
  const en = text(wert.en, max);
  return de === null || en === null ? null : { de, en };
}

function httpsTeile(adresse) {
  if (typeof adresse !== 'string') {
    return null;
  }
  const treffer = /^https:\/\/([a-z0-9.-]+)(?::\d+)?(\/[^\s]*)?$/i.exec(adresse.trim());
  if (treffer === null) {
    return null;
  }
  return { host: treffer[1].toLowerCase(), rest: treffer[2] ?? '/' };
}

function kennungVon(plattform, feld, host, rest) {
  const gegeben = typeof feld === 'string' ? feld.trim() : null;
  if (plattform === 'youtube') {
    if (gegeben !== null && YOUTUBE_KENNUNG.test(gegeben)) {
      return gegeben;
    }
    const kandidat =
      host === 'youtu.be'
        ? /^\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(rest)?.[1]
        : (/[?&]v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(rest)?.[1] ??
          /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(rest)?.[1]);
    return kandidat ?? null;
  }
  if (plattform === 'tiktok') {
    if (gegeben !== null && TIKTOK_KENNUNG.test(gegeben)) {
      return gegeben;
    }
    return /\/video\/(\d{1,25})(?:[/?#]|$)/.exec(rest)?.[1] ?? null;
  }
  return gegeben !== null && INSTAGRAM_KENNUNG.test(gegeben) ? gegeben : null;
}

function videoAus(wert) {
  if (!istObjekt(wert) || !VIDEO_PLATTFORMEN.includes(wert.plattform)) {
    return null;
  }
  const plattform = wert.plattform;
  const teile = httpsTeile(wert.url);
  if (teile === null || !GRENZEN.videoHosts[plattform].includes(teile.host)) {
    return null;
  }
  return {
    plattform,
    url: wert.url.trim(),
    id: kennungVon(plattform, wert.id, teile.host, teile.rest),
    creator: text(wert.creator, CREATOR_MAX),
  };
}

function videosAus(wert) {
  if (!Array.isArray(wert)) {
    return [];
  }
  const gesehen = new Set();
  const videos = [];
  for (const eintrag of wert) {
    const video = videoAus(eintrag);
    if (video === null || gesehen.has(video.url)) {
      continue;
    }
    gesehen.add(video.url);
    videos.push(video);
    if (videos.length === GRENZEN.videosMax) {
      break;
    }
  }
  return videos;
}

function trendAus(wert) {
  if (!istObjekt(wert)) {
    return null;
  }
  const id = typeof wert.id === 'string' ? wert.id : '';
  if (id.length === 0 || id.length > GRENZEN.kennungMax || !KENNUNG.test(id)) {
    return null;
  }
  if (!GRENZEN.bereiche.includes(wert.bereich)) {
    return null;
  }
  const titel = zweisprachig(wert.titel, GRENZEN.titelMax);
  const beschreibung = zweisprachig(wert.beschreibung, GRENZEN.beschreibungMax);
  if (titel === null || beschreibung === null) {
    return null;
  }
  if (httpsTeile(wert.quelle) === null) {
    return null;
  }
  const videos = videosAus(wert.videos);
  if (videos.length === 0) {
    return null;
  }
  return { id, bereich: wert.bereich, titel, beschreibung, quelle: wert.quelle.trim(), videos };
}

function pruefeTrendListe(wert) {
  if (!Array.isArray(wert)) {
    return [];
  }
  const gesehen = new Set();
  const trends = [];
  for (const eintrag of wert) {
    const trend = trendAus(eintrag);
    if (trend === null || gesehen.has(trend.id)) {
      continue;
    }
    gesehen.add(trend.id);
    trends.push(trend);
    if (trends.length === GRENZEN.trendsJePlattformMax) {
      break;
    }
  }
  return trends;
}

function pruefeDatei(json) {
  if (!istObjekt(json) || json.version !== GRENZEN.version) {
    return null;
  }
  if (typeof json.monat !== 'string' || !MONAT.test(json.monat) || typeof json.erzeugtAm !== 'string') {
    return null;
  }
  const plattformen = json.plattformen;
  if (!istObjekt(plattformen) || !GRENZEN.plattformen.every((name) => Array.isArray(plattformen[name]))) {
    return null;
  }
  const tiktok = pruefeTrendListe(plattformen.tiktok);
  const instagram = pruefeTrendListe(plattformen.instagram);
  if (tiktok.length === 0 && instagram.length === 0) {
    return null;
  }
  return { version: 1, monat: json.monat, erzeugtAm: json.erzeugtAm, plattformen: { tiktok, instagram } };
}

// ---------------------------------------------------------------------------
// Der Lauf.
// ---------------------------------------------------------------------------

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const TIKTOK_OEMBED = 'https://www.tiktok.com/oembed?url=';
const YOUTUBE_OEMBED = 'https://www.youtube.com/oembed?format=json&url=';
const MODELL = process.env.TRENDS_MODELL || 'claude-sonnet-5-5';
const SUCHEN_MAX = Number(process.env.TRENDS_SUCHEN_MAX || 20);
const NAME = 'lompass-trends (monatlicher Job; github.com/floooooooo123445/lompass-trends)';

function auftrag(monat) {
  return `Du beobachtest TikTok und Instagram und beschreibst, was dort in diesem Monat (${monat}) läuft. Du beobachtest, du berätst nicht.
You observe TikTok and Instagram and describe what is trending there this month (${monat}). You observe, you do not advise.

Aufgabe / Task:
- Je Plattform (TikTok, Instagram) 5 bis 10 Trends dieses Monats. For each platform (TikTok, Instagram) 5 to 10 trends of this month.
- Je Trend / per trend: "id" (Kleinbuchstaben, Ziffern, Bindestriche / lowercase, digits, hyphens), "bereich" (genau einer von / exactly one of: ${GRENZEN.bereiche.join(', ')}), "titel" {"de","en"} (höchstens / at most ${GRENZEN.titelMax} Zeichen/characters), "beschreibung" {"de","en"} (ein Satz, höchstens / one sentence, at most ${GRENZEN.beschreibungMax} Zeichen/characters), "quelle" (Pflicht: die https-Adresse der Seite, auf der du ihn gelesen hast / required: the https address of the page you read it on), "videos": 3 bis 8 öffentliche Videos / 3 to 8 public videos, je / each {"plattform": "youtube"|"tiktok"|"instagram", "url", "id", "creator"}.
- Nimm bevorzugt YouTube-Videos (Shorts), dazu TikTok-Videos; Instagram-Links nur, wenn es nichts anderes gibt. Prefer YouTube videos (Shorts), add TikTok videos; Instagram links only if nothing else exists.
- Nur Adressen, die du wirklich gefunden hast. Erfinde niemals eine Adresse, eine Quelle oder ein Datum. Only addresses you actually found. Never invent an address, a source or a date.
- Kein Rat, kein Marketing, keine Aussage über Personen außer dem Namen des Creators. No advice, no marketing, nothing about people except the creator's name.

Antworte nur mit JSON, ohne Text davor oder danach / Answer with JSON only:
{"tiktok": [Trend, …], "instagram": [Trend, …]}`;
}

function schlafe(ms) {
  return new Promise((fertig) => setTimeout(fertig, ms));
}

async function frageAnthropic(schluessel, monat) {
  const nachrichten = [{ role: 'user', content: auftrag(monat) }];
  // `pause_turn`: Die Websuche hat eine lange Runde unterbrochen — dieselbe
  // Unterhaltung geht weiter, höchstens dreimal.
  for (let runde = 0; runde < 4; runde += 1) {
    const antwort = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': schluessel,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODELL,
        max_tokens: 16000,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: SUCHEN_MAX }],
        messages: nachrichten,
      }),
    });
    if (!antwort.ok) {
      throw new Error(`Anthropic antwortet ${antwort.status}: ${(await antwort.text()).slice(0, 300)}`);
    }
    const daten = await antwort.json();
    if (daten.stop_reason === 'pause_turn') {
      nachrichten.push({ role: 'assistant', content: daten.content });
      continue;
    }
    return daten.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  throw new Error('Die Websuche kam in vier Runden nicht zu Ende.');
}

function jsonAus(text) {
  const anfang = text.indexOf('{');
  const ende = text.lastIndexOf('}');
  if (anfang < 0 || ende <= anfang) {
    throw new Error('Die Antwort enthält kein JSON.');
  }
  return JSON.parse(text.slice(anfang, ende + 1));
}

/** Fragt oEmbed nach einem Video — `true`, wenn es öffentlich antwortet. Instagram bleibt ungeprüft. */
async function lebt(video) {
  if (video.plattform === 'instagram') {
    return true;
  }
  const basis = video.plattform === 'tiktok' ? TIKTOK_OEMBED : YOUTUBE_OEMBED;
  try {
    const antwort = await fetch(`${basis}${encodeURIComponent(video.url)}`, { headers: { 'user-agent': NAME } });
    if (!antwort.ok) {
      return false;
    }
    const daten = await antwort.json();
    return istObjekt(daten);
  } catch {
    return false;
  } finally {
    // Eine Anfrage je Sekunde — höflich wie der Abruf der App.
    await schlafe(1000);
  }
}

async function nurLebendeVideos(trends) {
  const geprueft = [];
  for (const trend of trends) {
    const videos = [];
    for (const video of trend.videos) {
      if (await lebt(video)) {
        videos.push(video);
      }
    }
    geprueft.push({ ...trend, videos });
  }
  return geprueft;
}

async function lauf() {
  const schluessel = process.env.ANTHROPIC_API_KEY;
  if (!schluessel) {
    throw new Error('ANTHROPIC_API_KEY fehlt (Secret im Repo setzen).');
  }
  const jetzt = new Date();
  const monat = jetzt.toISOString().slice(0, 7);
  const roh = jsonAus(await frageAnthropic(schluessel, monat));

  const vorab = pruefeDatei({
    version: 1,
    monat,
    erzeugtAm: jetzt.toISOString(),
    plattformen: { tiktok: roh.tiktok, instagram: roh.instagram },
  });
  if (vorab === null) {
    throw new Error('Die Antwort trägt keinen brauchbaren Trend.');
  }

  const datei = pruefeDatei({
    ...vorab,
    plattformen: {
      tiktok: await nurLebendeVideos(vorab.plattformen.tiktok),
      instagram: await nurLebendeVideos(vorab.plattformen.instagram),
    },
  });
  // Mindestens ein Trend je Plattform — sonst bleibt die alte Datei.
  if (datei === null || datei.plattformen.tiktok.length === 0 || datei.plattformen.instagram.length === 0) {
    throw new Error('Nach der Prüfung der Videos bleibt nicht je Plattform ein Trend. Die alte Datei bleibt.');
  }

  const wurzel = dirname(fileURLToPath(import.meta.url));
  const inhalt = `${JSON.stringify(datei, null, 2)}\n`;
  mkdirSync(join(wurzel, 'archiv'), { recursive: true });
  writeFileSync(join(wurzel, 'aktuell.json'), inhalt);
  writeFileSync(join(wurzel, 'archiv', `${monat}.json`), inhalt);
  console.log(
    `Trends ${monat}: ${datei.plattformen.tiktok.length} TikTok, ${datei.plattformen.instagram.length} Instagram.`,
  );
}

async function pruefeStdin() {
  const json = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(pruefeDatei(json)));
}

const ablauf = process.argv[2] === '--pruefe' ? pruefeStdin() : lauf();
ablauf.catch((fehler) => {
  console.error(fehler instanceof Error ? fehler.message : fehler);
  process.exit(1);
});
