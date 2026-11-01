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
//   node erzeuge.mjs --creator -     liest `{ plattform, antwort }` von stdin
//                                    und schreibt den Creator, den der Job aus
//                                    dieser oEmbed-Antwort nimmt (ohne Netz)
//
// **Die Regeln sind eine Kopie** von `src/domain/trends-datei.ts` in der App.
// Der Test `src/domain/__tests__/trends-datei-vorlage.test.ts` im Hauptrepo
// vergleicht die Grenzen unten mit denen der App und lässt beide Prüfungen
// über dieselben Eingaben laufen. Wer hier etwas ändert, ändert es dort mit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
  },
  "playlistsMax": 8,
  "playlistTitelMax": 60,
  "playlistAdresseMax": 500,
  "playlistHosts": {
    "applemusic": ["music.apple.com"],
    "spotify": ["open.spotify.com"]
  },
  "playlistPfade": {
    "applemusic": "^\\/[a-z]{2}\\/playlist\\/(?:[^/?#\\s]+\\/)?pl\\.[A-Za-z0-9._-]+(?:[/?#]|$)",
    "spotify": "^\\/(?:intl-[a-z]{2}\\/)?playlist\\/[A-Za-z0-9]{10,40}(?:[/?#]|$)"
  },
  "quelleNameMax": 40
};
// GRENZEN-ENDE

const MONAT = /^\d{4}-(0[1-9]|1[0-2])$/;
const KENNUNG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

// Schluss-Prüfung Runde 25 (R2, R3): die Kennung immer aus der Adresse, nie
// aus dem Feld `id`; ohne Videopfad kein Video — wie `kennungVon` in der App.
function kennungVon(plattform, host, rest) {
  if (plattform === 'youtube') {
    const kandidat =
      host === 'youtu.be'
        ? /^\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(rest)?.[1]
        : (/^\/watch\?(?:[^#]*?&)?v=([A-Za-z0-9_-]{11})(?:[&#]|$)/.exec(rest)?.[1] ??
          /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/.exec(rest)?.[1]);
    return kandidat ?? null;
  }
  if (plattform === 'tiktok') {
    return /^\/(?:@[^/?#]+\/)?video\/(\d{1,25})(?:[/?#]|$)/.exec(rest)?.[1] ?? null;
  }
  return /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:reel|p)\/([A-Za-z0-9_-]{1,40})(?:[/?#]|$)/.exec(rest)?.[1] ?? null;
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
  const id = kennungVon(plattform, teile.host, teile.rest);
  if (id === null) {
    return null;
  }
  return {
    plattform,
    url: wert.url.trim(),
    id,
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

// Stufe 563 — Name und Datum der Quelle, beide optional; ein Feld, das eine
// Regel bricht, fällt allein (dieselben Regeln wie `quelleFelder` in
// `src/domain/trends-datei.ts`).
function quelleFelder(wert, bis) {
  const name = typeof wert.quelleName === 'string' ? wert.quelleName.trim() : '';
  const datum = typeof wert.quelleDatum === 'string' ? wert.quelleDatum.trim() : '';
  const tagGueltig =
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(datum) &&
    new Date(`${datum}T00:00:00Z`).toISOString().slice(0, 10) === datum &&
    (bis === null || datum <= bis);
  return {
    ...(name.length > 0 && name.length <= GRENZEN.quelleNameMax ? { quelleName: name } : {}),
    ...(tagGueltig ? { quelleDatum: datum } : {}),
  };
}

function trendAus(wert, bis = null) {
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
  return {
    id,
    bereich: wert.bereich,
    titel,
    beschreibung,
    quelle: wert.quelle.trim(),
    ...quelleFelder(wert, bis),
    videos,
  };
}

function pruefeTrendListe(wert, bis = null) {
  if (!Array.isArray(wert)) {
    return [];
  }
  const gesehen = new Set();
  const trends = [];
  for (const eintrag of wert) {
    const trend = trendAus(eintrag, bis);
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
  // Stufe 563 — ein Datum der Quelle nach dem Tag der Datei fällt als Feld.
  const bis = /^\d{4}-\d{2}-\d{2}/.test(json.erzeugtAm) ? json.erzeugtAm.slice(0, 10) : null;
  const tiktok = pruefeTrendListe(plattformen.tiktok, bis);
  const instagram = pruefeTrendListe(plattformen.instagram, bis);
  if (tiktok.length === 0 && instagram.length === 0) {
    return null;
  }
  // Stufe 528 — das optionale Feld `playlists`; leer steht es nicht da.
  const playlists = pruefePlaylists(json.playlists);
  return {
    version: 1,
    monat: json.monat,
    erzeugtAm: json.erzeugtAm,
    plattformen: { tiktok, instagram },
    ...(playlists.length === 0 ? {} : { playlists }),
  };
}

// Stufe 528 — die Playlists des Monats, dieselben Regeln wie `pruefePlaylists`
// in `src/domain/trends-datei.ts`: Titel, Anbieter, ein Link auf eine Playlist
// genau dieses Anbieters, optional ein Bild; schiefe und doppelte fallen.
const PLAYLIST_PFADE = Object.fromEntries(
  Object.entries(GRENZEN.playlistPfade).map(([anbieter, muster]) => [anbieter, new RegExp(muster)]),
);

function playlistAus(wert) {
  if (!istObjekt(wert) || !Object.keys(GRENZEN.playlistHosts).includes(wert.anbieter)) {
    return null;
  }
  const anbieter = wert.anbieter;
  const titel = text(wert.titel, GRENZEN.playlistTitelMax);
  const teile = httpsTeile(wert.url);
  if (
    titel === null ||
    teile === null ||
    wert.url.trim().length > GRENZEN.playlistAdresseMax ||
    !GRENZEN.playlistHosts[anbieter].includes(teile.host) ||
    !PLAYLIST_PFADE[anbieter].test(teile.rest)
  ) {
    return null;
  }
  const bild =
    httpsTeile(wert.bild) !== null && wert.bild.trim().length <= GRENZEN.playlistAdresseMax ? wert.bild.trim() : null;
  return { titel, anbieter, url: wert.url.trim(), bild };
}

function pruefePlaylists(wert) {
  if (!Array.isArray(wert)) {
    return [];
  }
  const gesehen = new Set();
  const playlists = [];
  for (const eintrag of wert) {
    const playlist = playlistAus(eintrag);
    if (playlist === null || gesehen.has(playlist.url)) {
      continue;
    }
    gesehen.add(playlist.url);
    playlists.push(playlist);
    if (playlists.length === GRENZEN.playlistsMax) {
      break;
    }
  }
  return playlists;
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
- Zuerst Deutschland, Österreich und die Schweiz (DACH); andere Länder nur, wenn der Trend dort nachweislich angekommen ist. Germany, Austria and Switzerland (DACH) first; other countries only if the trend has demonstrably arrived there.
- Nur Trends, über die ein Medium berichtet (Zeitung, Sender, Nachrichtenseite, Fachportal); kein Marketing-Blog, kein Trend-Tool, keine KI-Seite. Only trends a news outlet reports on (newspaper, broadcaster, news site, trade portal); no marketing blog, no trend tool, no AI site.
- Je Trend / per trend: "id" (Kleinbuchstaben, Ziffern, Bindestriche / lowercase, digits, hyphens), "bereich" (genau einer von / exactly one of: ${GRENZEN.bereiche.join(', ')}), "titel" {"de","en"} (höchstens / at most ${GRENZEN.titelMax} Zeichen/characters), "beschreibung" {"de","en"} (ein Satz, höchstens / one sentence, at most ${GRENZEN.beschreibungMax} Zeichen/characters), "quelle" (Pflicht: die https-Adresse des Artikels, in dem du ihn gelesen hast / required: the https address of the article you read it in), "quelleName" (Pflicht: der Name des Mediums, höchstens ${GRENZEN.quelleNameMax} Zeichen / required: the outlet's name, at most ${GRENZEN.quelleNameMax} characters), "quelleDatum" (Pflicht: das Erscheinungsdatum des Artikels, JJJJ-MM-TT / required: the article's publication date, YYYY-MM-DD), "videos": 3 bis 8 öffentliche Videos / 3 to 8 public videos, je / each {"plattform": "youtube"|"tiktok"|"instagram", "url", "id", "creator"}.
- Nimm bevorzugt YouTube-Videos (Shorts), dazu TikTok-Videos; Instagram-Links nur, wenn es nichts anderes gibt. Prefer YouTube videos (Shorts), add TikTok videos; Instagram links only if nothing else exists.
- Nur Adressen, die du wirklich gefunden hast. Erfinde niemals eine Adresse, eine Quelle oder ein Datum. Only addresses you actually found. Never invent an address, a source or a date.
- Kein Rat, kein Marketing, keine Aussage über Personen außer dem Namen des Creators. No advice, no marketing, nothing about people except the creator's name.
- Dazu 3 bis ${GRENZEN.playlistsMax} öffentliche Playlists, die in diesem Monat viel gehört werden (Apple Music oder Spotify), je {"titel" (ihr Name beim Anbieter, höchstens ${GRENZEN.playlistTitelMax} Zeichen), "anbieter": "applemusic"|"spotify", "url" (die Adresse der Playlist: https://music.apple.com/<land>/playlist/… oder https://open.spotify.com/playlist/…), "bild" (die https-Adresse ihres Titelbilds, wenn du sie gefunden hast, sonst null)}. Also 3 to ${GRENZEN.playlistsMax} public playlists that are widely played this month (Apple Music or Spotify), each as above. Nur Adressen, die du wirklich gefunden hast / only addresses you actually found.

Antworte nur mit JSON, ohne Text davor oder danach / Answer with JSON only:
{"tiktok": [Trend, …], "instagram": [Trend, …], "playlists": [Playlist, …]}`;
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

/**
 * Der Creator aus einer oEmbed-Antwort (Schluss-Prüfung Runde 25, R1, harte
 * Regel 1): TikTok `author_unique_id`, sonst `author_name`; YouTube
 * `author_name`; Instagram wird nicht gefragt und bekommt keinen. Den Namen
 * aus der Antwort des Modells übernimmt der Job nicht mehr — er stand ungeprüft
 * unter einem echten Video.
 */
function creatorAusOembed(plattform, daten) {
  if (plattform === 'instagram' || !istObjekt(daten)) {
    return null;
  }
  const roh =
    (plattform === 'tiktok' ? text(daten.author_unique_id, CREATOR_MAX) : null) ??
    text(daten.author_name, CREATOR_MAX);
  return roh === null ? null : text(roh.replace(/^@+/, ''), CREATOR_MAX);
}

/**
 * Fragt oEmbed nach einem Video — `lebt`, wenn es öffentlich antwortet, und
 * der Creator aus der Antwort. Instagram bleibt ungeprüft und ohne Creator.
 */
async function pruefeVideo(video) {
  if (video.plattform === 'instagram') {
    return { lebt: true, creator: null };
  }
  const basis = video.plattform === 'tiktok' ? TIKTOK_OEMBED : YOUTUBE_OEMBED;
  try {
    const antwort = await fetch(`${basis}${encodeURIComponent(video.url)}`, { headers: { 'user-agent': NAME } });
    if (!antwort.ok) {
      return { lebt: false, creator: null };
    }
    const daten = await antwort.json();
    return { lebt: istObjekt(daten), creator: creatorAusOembed(video.plattform, daten) };
  } catch {
    return { lebt: false, creator: null };
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
      const pruefung = await pruefeVideo(video);
      if (pruefung.lebt) {
        videos.push({ ...video, creator: pruefung.creator });
      }
    }
    geprueft.push({ ...trend, videos });
  }
  return geprueft;
}

// Stufe 563 — **die Probe am Rechner** (harte Regel 6, Nachtrag 563 am
// Vermerk 415): `node erzeuge.mjs --probe <pfad>` läuft wie der Monatsjob,
// schreibt die geprüfte Datei aber nur an `<pfad>` — **außerhalb des Repos**,
// ohne Archiv und ohne Commit (committen tut ohnehin nur der Workflow). Der
// Schlüssel kommt aus `ANTHROPIC_API_KEY` oder aus der Datei, die
// `ANTHROPIC_API_KEY_DATEI` nennt (auch sie außerhalb des Repos).

/** Die Wurzel des Repos, in dem dieses Skript liegt — das erste Verzeichnis darüber mit `.git`. */
function repoWurzel() {
  let ordner = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(ordner, '.git'))) return ordner;
    const darueber = dirname(ordner);
    if (darueber === ordner) return dirname(fileURLToPath(import.meta.url));
    ordner = darueber;
  }
}

/** Ob ein Pfad im Repo liegt (dann schreibt die Probe nicht). */
export function liegtImRepo(pfad, wurzel = repoWurzel()) {
  const ziel = resolve(pfad).toLowerCase();
  const repo = resolve(wurzel).toLowerCase();
  return ziel === repo || ziel.startsWith(`${repo}${sep}`);
}

function schluesselAusUmgebung() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const datei = process.env.ANTHROPIC_API_KEY_DATEI;
  if (datei) {
    if (liegtImRepo(datei)) {
      throw new Error('ANTHROPIC_API_KEY_DATEI liegt im Repo — der Schlüssel gehört außerhalb.');
    }
    return readFileSync(datei, 'utf8').trim();
  }
  return '';
}

/** Runde 39 — warum ein Trend der Antwort fiel (nur für das Protokoll der Probe). */
function grundGegen(wert) {
  if (!istObjekt(wert)) return 'kein Objekt';
  const id = typeof wert.id === 'string' ? wert.id : '';
  if (id.length === 0 || id.length > GRENZEN.kennungMax || !KENNUNG.test(id)) return `Kennung ${JSON.stringify(wert.id)}`;
  if (!GRENZEN.bereiche.includes(wert.bereich)) return `Bereich ${JSON.stringify(wert.bereich)}`;
  if (zweisprachig(wert.titel, GRENZEN.titelMax) === null) return 'Titel';
  if (zweisprachig(wert.beschreibung, GRENZEN.beschreibungMax) === null) return 'Beschreibung';
  if (httpsTeile(wert.quelle) === null) return `Quelle ${JSON.stringify(wert.quelle)}`;
  if (videosAus(wert.videos).length === 0) return `Videos ${JSON.stringify(wert.videos)?.slice(0, 300)}`;
  return 'ok';
}

function probeBefund(roh) {
  const zeilen = [`Schlüssel der Antwort: ${istObjekt(roh) ? Object.keys(roh).join(', ') : typeof roh}`];
  for (const plattform of ['tiktok', 'instagram']) {
    const liste = istObjekt(roh) && Array.isArray(roh[plattform]) ? roh[plattform] : null;
    zeilen.push(`${plattform}: ${liste === null ? 'keine Liste' : `${liste.length} Einträge`}`);
    for (const eintrag of liste ?? []) zeilen.push(`  - ${istObjekt(eintrag) ? eintrag.id : '?'}: ${grundGegen(eintrag)}`);
  }
  zeilen.push(`Roh (gekürzt): ${JSON.stringify(roh).slice(0, 6000)}`);
  return zeilen.join('\n');
}

async function lauf(probe = null) {
  if (probe !== null && liegtImRepo(probe)) {
    throw new Error('Die Probe schreibt nur außerhalb des Repos — bitte einen Pfad außerhalb nennen.');
  }
  const schluessel = schluesselAusUmgebung();
  if (!schluessel) {
    throw new Error(
      probe === null
        ? 'ANTHROPIC_API_KEY fehlt (Secret im Repo setzen).'
        : 'ANTHROPIC_API_KEY fehlt (Umgebungsvariable oder ANTHROPIC_API_KEY_DATEI außerhalb des Repos).',
    );
  }
  const jetzt = new Date();
  const monat = jetzt.toISOString().slice(0, 7);
  const roh = jsonAus(await frageAnthropic(schluessel, monat));

  const vorab = pruefeDatei({
    version: 1,
    monat,
    erzeugtAm: jetzt.toISOString(),
    plattformen: { tiktok: roh.tiktok, instagram: roh.instagram },
    // Stufe 528
    playlists: roh.playlists,
  });
  if (vorab === null) {
    // Runde 39: In der Probe zeigt das Protokoll, woran es lag — die rohe Antwort
    // (ohne Schlüssel) und je Trend der erste Grund, aus dem er fiel.
    if (probe !== null) console.log(probeBefund(roh));
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
  // Stufe 563 — die Probe: nur an den Pfad außerhalb des Repos, sonst nichts.
  if (probe !== null) {
    writeFileSync(resolve(probe), inhalt);
    const zeilen = [...datei.plattformen.tiktok, ...datei.plattformen.instagram].map(
      (trend) => `- ${trend.titel.de} — ${trend.quelleName ?? trend.quelle}${trend.quelleDatum ? `, ${trend.quelleDatum}` : ''} (${trend.quelle})`,
    );
    console.log(`Probe ${monat}: ${zeilen.length} Trends in ${resolve(probe)}\n${zeilen.join('\n')}`);
    return;
  }
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

// Runde 25 (R1): liest `{ plattform, antwort }` von stdin und schreibt den
// Creator, den der Job aus dieser oEmbed-Antwort nähme — ohne Netz, für den
// Test im Hauptrepo.
async function creatorStdin() {
  const { plattform, antwort } = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(creatorAusOembed(plattform, antwort)));
}

// Stufe 563 — der Auftrag eines Monats auf stdout, ohne Netz (für den Test im Hauptrepo).
async function auftragAusgeben() {
  process.stdout.write(auftrag(process.argv[3] ?? new Date().toISOString().slice(0, 7)));
}

const ablauf =
  process.argv[2] === '--pruefe'
    ? pruefeStdin()
    : process.argv[2] === '--creator'
      ? creatorStdin()
      : process.argv[2] === '--auftrag'
        ? auftragAusgeben()
        : process.argv[2] === '--probe'
          ? lauf(process.argv[3] ?? '')
          : lauf();
ablauf.catch((fehler) => {
  console.error(fehler instanceof Error ? fehler.message : fehler);
  process.exit(1);
});
