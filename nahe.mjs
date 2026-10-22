// Stufe 598 — „In der Nähe": der tägliche Job (Vorlage für das öffentliche
// Repo `lompass-trends`; harte Regel 6, Vermerk 505; harte Regel 7, Vermerk
// 505).
//
// Was der Job tut, einmal am Tag (`.github/workflows/tag.yml`):
//
// 1. liest die Quellenliste `nahe-quellen.json` — je Quelle die Stadt (ihre
//    Kennung wie `stadtKennung` in der App), die Art (`ical`, `rss` oder
//    `jsonld`), genau eine https-Adresse und die Lizenz, wörtlich. Eine Quelle
//    ohne Lizenz, ohne https, mit fremder Art oder auf einer Plattform fällt
//    (Kopie von `pruefeNaheQuelle`, `src/domain/reisen/nahe.ts`);
// 2. holt je Quelle genau diese eine Adresse über einen höflichen Abruf:
//    eigener Name, `robots.txt` (RFC 9309), eine Anfrage je Sekunde und
//    Gegenstelle (ein längeres `Crawl-delay` gilt, über 30 Sekunden ist es ein
//    Nein), Zeit- und Größengrenze, ohne Login, ohne Kekse, eine Weiterleitung
//    nur auf derselben Gegenstelle. Er folgt keinem Link aus der Antwort;
//    gelesen wird nur, was die Quelle selbst in dieser einen Antwort nennt;
// 3. liest daraus je Termin Titel, Ort, Beginn (Ortszeit Europe/Berlin),
//    Kategorie und die Adresse, auf der der Termin steht. **Kein Bild:** Die
//    Lizenz einer Quelle gilt ihren Daten; für die Bilder darin sagt sie
//    nichts, also steht `bild: null`. Was nur online stattfindet, fällt
//    (JSON-LD `OnlineEventAttendanceMode`, sonst der Ort oder der Text).
//    Bei RSS gilt `pubDate` nur dann als Beginn, wenn die Quelle es mit
//    `"beginnAus": "pubDate"` sagt (sonst ist es der Tag der Meldung, und
//    nur `ev:startdate` zählt); Mitternacht heißt dann „ohne Uhrzeit".
//    `"ortAus": "kopf"` nimmt den Ort aus dem fetten Kopf der Meldung
//    („<Zeit> - <Ort> - ", Kalender der Stadt Karlsruhe). Von einer
//    iCal-Serie zählt nur `DTSTART` (`RRULE` liest der Job nicht);
// 4. schreibt je Stadt `nahe/<stadt>.json` im Format, das die App liest
//    (`src/data/naheDatei.ts`, `pruefeNaheDatei`): `{ stadt, stand, quellen,
//    termine }`, ab heute, die nächsten zuerst, höchstens 300. `quellen` nennt
//    Herausgeber, Lizenz und Nachweis — die App liest das Feld nicht, es steht
//    für jeden, der die Datei im Repo findet. Vor dem Schreiben prüft er die
//    Datei mit einer Kopie der Regeln der App (der Test
//    `nahe-vorlage.test.ts` im Hauptrepo hält beide gleich). Findet er für
//    eine Stadt keinen Termin, bleibt ihre alte Datei.
//
// Keine KI, kein Schlüssel, keine Abhängigkeit: Node bringt `fetch` mit. Der
// Job kennt keine Nutzer und bekommt keinen Ort von der App.
//
// Aufrufe:
//   node nahe.mjs                      alle Städte der Liste, schreibt nach nahe/
//   node nahe.mjs --stadt karlsruhe    nur diese Stadt
//   node nahe.mjs --ziel <ordner>      schreibt in einen anderen Ordner
//   node nahe.mjs --pruefe -           prüft eine Datei von stdin wie die App (ohne Netz)
//   node nahe.mjs --quellen -          prüft eine Quellenliste von stdin wie die App (ohne Netz)
//   node nahe.mjs --lies -             liest `{ art, text, quelle, heute }` von stdin (ohne Netz)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Kopie der Regeln der App (src/domain/reisen/nahe.ts) -------------------

export const KATEGORIEN = ['kultur', 'kurs', 'disko', 'festival', 'konzert', 'sport', 'markt', 'sonstiges'];
export const QUELLEN_ARTEN = ['ical', 'rss', 'jsonld'];
export const GESPERRTE_HOSTS = [
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'fb.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'threads.net',
  'threads.com',
];
export const TERMINE_MAX = 300;
const TITEL_MAX = 160;
const ORT_MAX = 160;
const ADRESSE_MAX = 2048;

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const BEGINN = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;
const KENNUNG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function istObjekt(wert) {
  return typeof wert === 'object' && wert !== null && !Array.isArray(wert);
}

function text(wert, max) {
  if (typeof wert !== 'string') return null;
  const getrimmt = wert.trim();
  return getrimmt.length === 0 || getrimmt.length > max ? null : getrimmt;
}

function httpsAdresse(wert) {
  const roh = text(wert, ADRESSE_MAX);
  if (roh === null) return null;
  try {
    const adresse = new URL(roh);
    return adresse.protocol === 'https:' && adresse.hostname.includes('.') ? roh : null;
  } catch {
    return null;
  }
}

function pruefeTermin(roh) {
  if (!istObjekt(roh)) return null;
  const titel = text(roh.titel, TITEL_MAX);
  const ort = text(roh.ort, ORT_MAX);
  const beginn = typeof roh.beginn === 'string' && BEGINN.test(roh.beginn) ? roh.beginn : null;
  const quelle = httpsAdresse(roh.quelle);
  if (titel === null || ort === null || beginn === null || quelle === null || !KATEGORIEN.includes(roh.kategorie)) {
    return null;
  }
  return { titel, ort, beginn, kategorie: roh.kategorie, quelle, bild: httpsAdresse(roh.bild) };
}

export function pruefeDatei(roh, erwarteteKennung) {
  if (!istObjekt(roh)) return null;
  const stadt = typeof roh.stadt === 'string' && KENNUNG.test(roh.stadt) ? roh.stadt : null;
  const stand = typeof roh.stand === 'string' && DATUM.test(roh.stand) ? roh.stand : null;
  if (stadt === null || stand === null || !Array.isArray(roh.termine)) return null;
  if (erwarteteKennung !== undefined && stadt !== erwarteteKennung) return null;
  const termine = [];
  for (const eintrag of roh.termine.slice(0, TERMINE_MAX)) {
    const termin = pruefeTermin(eintrag);
    if (termin !== null) termine.push(termin);
  }
  return { stadt, stand, termine };
}

function gesperrterHost(host) {
  const klein = host.toLowerCase();
  return GESPERRTE_HOSTS.some((gesperrt) => klein === gesperrt || klein.endsWith(`.${gesperrt}`));
}

export function pruefeQuelle(roh) {
  if (!istObjekt(roh)) return null;
  const stadt = typeof roh.stadt === 'string' && KENNUNG.test(roh.stadt) ? roh.stadt : null;
  const art = typeof roh.art === 'string' && QUELLEN_ARTEN.includes(roh.art) ? roh.art : null;
  const url = httpsAdresse(roh.url);
  const lizenz = text(roh.lizenz, TITEL_MAX);
  if (stadt === null || art === null || url === null || lizenz === null) return null;
  return gesperrterHost(new URL(url).hostname) ? null : { stadt, art, url, lizenz };
}

// --- Zeit: alles in Ortszeit Europe/Berlin ---------------------------------

const BERLIN = 'Europe/Berlin';

function zweistellig(zahl) {
  return String(zahl).padStart(2, '0');
}

function wandzeit(ms, zone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const teile = Object.fromEntries(format.formatToParts(new Date(ms)).map((teil) => [teil.type, teil.value]));
  return {
    jahr: Number(teile.year),
    monat: Number(teile.month),
    tag: Number(teile.day),
    stunde: Number(teile.hour),
    minute: Number(teile.minute),
    sekunde: Number(teile.second),
  };
}

/** Ein Augenblick als Ortszeit Berlin, `YYYY-MM-DDTHH:MM`. */
export function berlinAus(ms) {
  const z = wandzeit(ms, BERLIN);
  return `${z.jahr}-${zweistellig(z.monat)}-${zweistellig(z.tag)}T${zweistellig(z.stunde)}:${zweistellig(z.minute)}`;
}

/** Der Tag in Berlin, `YYYY-MM-DD`. */
export function heuteInBerlin(ms = Date.now()) {
  return berlinAus(ms).slice(0, 10);
}

/** Eine Wandzeit in einer Zone als Augenblick — `null` für eine unbekannte Zone. */
function augenblickAus(jahr, monat, tag, stunde, minute, sekunde, zone) {
  try {
    const wand = Date.UTC(jahr, monat - 1, tag, stunde, minute, sekunde);
    let schaetzung = wand;
    for (let runde = 0; runde < 3; runde += 1) {
      const z = wandzeit(schaetzung, zone);
      const versatz = Date.UTC(z.jahr, z.monat - 1, z.tag, z.stunde, z.minute, z.sekunde) - Math.floor(schaetzung / 1000) * 1000;
      const neu = wand - versatz;
      if (neu === schaetzung) break;
      schaetzung = neu;
    }
    return schaetzung;
  } catch {
    return null;
  }
}

function wandzeitText(jahr, monat, tag, stunde, minute) {
  const datum = `${jahr}-${zweistellig(monat)}-${zweistellig(tag)}`;
  return stunde === null ? datum : `${datum}T${zweistellig(stunde)}:${zweistellig(minute)}`;
}

function gueltigesDatum(jahr, monat, tag) {
  const probe = new Date(Date.UTC(jahr, monat - 1, tag));
  return probe.getUTCFullYear() === jahr && probe.getUTCMonth() === monat - 1 && probe.getUTCDate() === tag;
}

/**
 * ISO 8601 (`startDate` in JSON-LD, `ev:startdate` in RSS) als Beginn in
 * Berlin. Ohne Zone gilt die Uhrzeit, wie sie dasteht.
 */
export function beginnAusIso(wert) {
  const treffer = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
    typeof wert === 'string' ? wert.trim() : '',
  );
  if (treffer === null) return null;
  const [, j, mo, t, h, mi, s = '0', zone] = treffer;
  const jahr = Number(j);
  const monat = Number(mo);
  const tag = Number(t);
  if (!gueltigesDatum(jahr, monat, tag)) return null;
  if (h === undefined) return wandzeitText(jahr, monat, tag, null, null);
  if (Number(h) > 23 || Number(mi) > 59) return null;
  if (zone === undefined) return wandzeitText(jahr, monat, tag, Number(h), Number(mi));
  const versatzMin = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  return berlinAus(Date.UTC(jahr, monat - 1, tag, Number(h), Number(mi), Number(s)) - versatzMin * 60_000);
}

const MONATE = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const BENANNTE_ZONEN = { gmt: 0, ut: 0, utc: 0, z: 0, cet: 60, mez: 60, cest: 120, mesz: 120 };

/**
 * RFC 822 (`pubDate`) als Beginn in Berlin. Eine Zone, die kein Vielfaches
 * einer Viertelstunde ist (Karlsruhe schreibt „+0018"), ist keine — dann gilt
 * die Uhrzeit, wie sie dasteht.
 */
export function beginnAusRfc822(wert) {
  const treffer = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,4})?/.exec(
    typeof wert === 'string' ? wert : '',
  );
  if (treffer === null) return null;
  const [, t, mon, j, h, mi, s = '0', zone] = treffer;
  const monat = MONATE[mon.toLowerCase()];
  const jahr = Number(j);
  const tag = Number(t);
  if (monat === undefined || !gueltigesDatum(jahr, monat, tag) || Number(h) > 23 || Number(mi) > 59) return null;
  let versatzMin = null;
  if (zone !== undefined && /^[+-]\d{4}$/.test(zone)) {
    const minuten = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3));
    if (minuten % 15 === 0 && minuten <= 14 * 60) versatzMin = (zone[0] === '-' ? -1 : 1) * minuten;
  } else if (zone !== undefined && BENANNTE_ZONEN[zone.toLowerCase()] !== undefined) {
    versatzMin = BENANNTE_ZONEN[zone.toLowerCase()];
  }
  if (versatzMin === null) return wandzeitText(jahr, monat, tag, Number(h), Number(mi));
  return berlinAus(Date.UTC(jahr, monat - 1, tag, Number(h), Number(mi), Number(s)) - versatzMin * 60_000);
}

/** `DTSTART` aus iCal (RFC 5545) als Beginn in Berlin. */
export function beginnAusIcal(wert, parameter) {
  const treffer = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(typeof wert === 'string' ? wert.trim() : '');
  if (treffer === null) return null;
  const [, j, mo, t, h, mi, s = '0', utc] = treffer;
  const jahr = Number(j);
  const monat = Number(mo);
  const tag = Number(t);
  if (!gueltigesDatum(jahr, monat, tag)) return null;
  if (h === undefined || (parameter.VALUE ?? '').toUpperCase() === 'DATE') return wandzeitText(jahr, monat, tag, null, null);
  if (Number(h) > 23 || Number(mi) > 59) return null;
  if (utc === 'Z') return berlinAus(Date.UTC(jahr, monat - 1, tag, Number(h), Number(mi), Number(s)));
  const zone = parameter.TZID;
  if (zone === undefined || zone === BERLIN) return wandzeitText(jahr, monat, tag, Number(h), Number(mi));
  const augenblick = augenblickAus(jahr, monat, tag, Number(h), Number(mi), Number(s), zone);
  return augenblick === null ? wandzeitText(jahr, monat, tag, Number(h), Number(mi)) : berlinAus(augenblick);
}

// --- Text ------------------------------------------------------------------

const BENANNTE_ZEICHEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function entschluesselt(roh) {
  return roh.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (ganz, name) => {
    if (name[0] === '#') {
      const zahl = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(zahl) && zahl > 0 && zahl < 0x110000 ? String.fromCodePoint(zahl) : ganz;
    }
    return BENANNTE_ZEICHEN[name.toLowerCase()] ?? ganz;
  });
}

/** Ohne Auszeichnung, ohne doppelte Leerzeichen. */
export function glatt(roh) {
  if (typeof roh !== 'string') return '';
  const ohneCdata = roh.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Zweimal: Ein Feed schreibt Auszeichnung oft maskiert (`&lt;b&gt;`).
  const einmal = entschluesselt(ohneCdata.replace(/<[^>]*>/g, ' '));
  return entschluesselt(einmal.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Ein Titel ohne die Vermerke der Quelle: „-- GEÄNDERTES DATUM --" fällt, ein
 * hängendes „ ." am Ende auch, und nach „)" steht vor einem Wort ein
 * Leerzeichen. Bleibt nichts, gilt der Titel, wie er war.
 */
export function titelOhneVermerk(titel) {
  const sauber = titel
    .replace(/\s*--\s*[^-]+?\s*--\s*/g, ' ')
    .replace(/\)(?=\p{L})/gu, ') ')
    .replace(/\s+[.,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sauber === '' ? titel : sauber;
}

/**
 * Ob ein Termin nur online stattfindet — nach dem, was die Quelle als Ort oder
 * im Text sagt („Online-Veranstaltung", „findet online statt",
 * „Online-Vortrag", „Webinar"). Steht dabei „vor Ort", „Präsenz" oder
 * „hybrid", zählt er als Termin vor Ort.
 */
export function nurOnline(...texte) {
  const alle = texte.filter((wert) => typeof wert === 'string').join(' ');
  if (/vor ort|präsenz|praesenz|hybrid/i.test(alle)) return false;
  return /(^|[^\p{L}])(online[- ]?(veranstaltung|vortrag|vorträge|seminar|workshop|kurs|lesung|sprechstunde|treffen|event|format)|findet online statt|nur online|webinar|livestream)([^\p{L}]|$)/iu.test(
    alle,
  );
}

/** Höchstens `max` Zeichen — zu lang wird am Wort gekürzt, mit „…". */
export function gekuerzt(wert, max) {
  if (wert.length <= max) return wert;
  const schnitt = wert.slice(0, max - 1);
  const wort = schnitt.lastIndexOf(' ');
  return `${(wort > max / 2 ? schnitt.slice(0, wort) : schnitt).trimEnd()}…`;
}

// --- Kategorie: nur aus dem, was die Quelle als Art nennt -------------------

const KATEGORIE_MUSTER = [
  ['festival', /festival/],
  ['konzert', /konzert|musik|music|jazz|chor\b|band\b/],
  ['disko', /party|disko|disco|clubbing|tanznacht/],
  ['sport', /sport|marathon|turnier|sportsevent/],
  ['markt', /markt|flohmarkt|basar|trödel|saleevent/],
  ['kurs', /kurs|workshop|seminar|schulung|educationevent|courseinstance/],
  [
    'kultur',
    /theater|kabarett|comedy|literatur|lesung|ausstellung|museum|kunst|architektur|film|kino|kultur|oper|exhibition|screening|literary|visualarts|danceevent/,
  ],
];

/**
 * Die Kategorie aus den Wörtern, mit denen die Quelle einen Termin einordnet
 * (Kategorie im Feed, Typ in JSON-LD, der Pfad seiner Adresse) — nie aus dem
 * Titel. Ohne Treffer `sonstiges`.
 */
export function kategorieAus(woerter) {
  const alle = woerter
    .filter((wort) => typeof wort === 'string')
    .join(' ')
    .toLocaleLowerCase('de-DE');
  for (const [kategorie, muster] of KATEGORIE_MUSTER) {
    if (muster.test(alle)) return kategorie;
  }
  return 'sonstiges';
}

/** Die Wörter der Ordner einer Adresse — ohne den letzten Teil, der meist der Titel ist. */
function pfadWoerter(adresse) {
  try {
    return new URL(adresse).pathname
      .split('/')
      .filter(Boolean)
      .slice(0, -1)
      .flatMap((teil) => teil.split(/[_.-]+/))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --- Lesen: iCal, RSS, JSON-LD ---------------------------------------------

/** Ein Termin, wie er aus einer Quelle kommt — vor der Prüfung. */
function termin(titel, ort, beginn, kategorie, adresse) {
  return { titel: gekuerzt(titel, TITEL_MAX), ort: gekuerzt(ort, ORT_MAX), beginn, kategorie, quelle: adresse, bild: null };
}

function icalWert(roh) {
  return roh.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

/** Eine Zeile `NAME;PARAM=WERT:Inhalt` — Doppelpunkte in Anführungszeichen zählen nicht. */
function icalZeile(zeile) {
  let inAnfuehrung = false;
  for (let stelle = 0; stelle < zeile.length; stelle += 1) {
    const zeichen = zeile[stelle];
    if (zeichen === '"') inAnfuehrung = !inAnfuehrung;
    if (zeichen === ':' && !inAnfuehrung) {
      const [name, ...teile] = zeile.slice(0, stelle).split(';');
      const parameter = {};
      for (const teil of teile) {
        const gleich = teil.indexOf('=');
        if (gleich > 0) parameter[teil.slice(0, gleich).toUpperCase()] = teil.slice(gleich + 1).replace(/^"|"$/g, '');
      }
      return { name: name.toUpperCase(), parameter, wert: zeile.slice(stelle + 1) };
    }
  }
  return null;
}

export function liesIcal(text, quelle) {
  const zeilen = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const termine = [];
  let ereignis = null;
  for (const roh of zeilen) {
    if (/^BEGIN:VEVENT$/i.test(roh.trim())) {
      ereignis = {};
      continue;
    }
    if (/^END:VEVENT$/i.test(roh.trim())) {
      if (ereignis !== null) termine.push(ereignis);
      ereignis = null;
      continue;
    }
    if (ereignis === null) continue;
    const zeile = icalZeile(roh);
    if (zeile !== null && ereignis[zeile.name] === undefined) ereignis[zeile.name] = zeile;
  }
  return termine.flatMap((e) => {
    const status = (e.STATUS?.wert ?? '').trim().toUpperCase();
    const klasse = (e.CLASS?.wert ?? 'PUBLIC').trim().toUpperCase();
    if (status === 'CANCELLED' || klasse !== 'PUBLIC') return [];
    const titel = glatt(icalWert(e.SUMMARY?.wert ?? ''));
    // Nur DTSTART: Eine Serie (RRULE, RDATE) steht mit ihrem ersten Termin da.
    const beginn = e.DTSTART === undefined ? null : beginnAusIcal(e.DTSTART.wert, e.DTSTART.parameter);
    const genannterOrt = glatt(icalWert(e.LOCATION?.wert ?? ''));
    if (nurOnline(titel, genannterOrt, glatt(icalWert(e.DESCRIPTION?.wert ?? '')))) return [];
    const ort = mitStadt(genannterOrt, quelle.ort) || (quelle.ort ?? '');
    const adresse = httpsAdresse(e.URL?.wert?.trim()) ?? httpsAdresse(quelle.seite);
    if (titel === '' || beginn === null || ort === '' || adresse === null) return [];
    const woerter = [...icalWert(e.CATEGORIES?.wert ?? '').split(','), ...pfadWoerter(adresse === quelle.seite ? '' : adresse)];
    return [termin(titel, ort, beginn, kategorieAus(woerter), adresse)];
  });
}

function rssFeld(eintrag, name) {
  const treffer = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(eintrag);
  return treffer === null ? '' : treffer[1];
}

function rssFelder(eintrag, name) {
  return [...eintrag.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))].map((treffer) => glatt(treffer[1]));
}

/**
 * Der Ort aus dem fetten Kopf einer Meldung — der Kalender der Stadt Karlsruhe
 * schreibt `<b>18 bis 19.30 Uhr - OrgelFabrikSalon - </b>` vor den Text, ohne
 * Uhrzeit nur `<b>Messe Karlsruhe - </b>`. Die Uhrzeit fällt, „ - " im Ort
 * wird „, ". Ohne Kopf oder ohne Ort darin: leer.
 */
export function ortAusKopf(eintrag) {
  const roh = rssFeld(eintrag, 'content:encoded').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const html = /&lt;b&gt;/i.test(roh) ? entschluesselt(roh) : roh;
  const fett = /<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(html);
  if (fett === null) return '';
  return glatt(fett[1])
    .replace(/\s*-\s*$/, '')
    .replace(/^\d{1,2}(?:[.:]\d{2})?(?:\s+bis\s+\d{1,2}(?:[.:]\d{2})?)?\s+Uhr(?:\s+-\s+|$)/i, '')
    .replace(/\s+-\s+/g, ', ')
    .trim();
}

/** Mitternacht als „ohne Uhrzeit" — so schreibt ein Kalender einen Tag ohne Zeit in `pubDate`. */
function ohneMitternacht(beginn) {
  return beginn !== null && beginn.endsWith('T00:00') ? beginn.slice(0, 10) : beginn;
}

/** Der Ort mit der Stadt der Quelle dahinter, wenn er sie nicht schon nennt („OrgelFabrikSalon, Karlsruhe"). */
function mitStadt(ort, stadt) {
  if (ort === '' || typeof stadt !== 'string' || stadt === '') return ort;
  return ort.toLocaleLowerCase('de-DE').includes(stadt.toLocaleLowerCase('de-DE')) ? ort : `${ort}, ${stadt}`;
}

export function liesRss(text, quelle) {
  const eintraege = text.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return eintraege.flatMap((eintrag) => {
    const titel = glatt(rssFeld(eintrag, 'title'));
    const start = glatt(rssFeld(eintrag, 'ev:startdate'));
    const beginn =
      start !== ''
        ? beginnAusIso(start)
        : quelle.beginnAus === 'pubDate'
          ? ohneMitternacht(beginnAusRfc822(glatt(rssFeld(eintrag, 'pubDate'))))
          : null;
    const genannterOrt = glatt(rssFeld(eintrag, 'ev:location')) || (quelle.ortAus === 'kopf' ? ortAusKopf(eintrag) : '');
    if (nurOnline(titel, genannterOrt, glatt(rssFeld(eintrag, 'description')))) return [];
    const ort = mitStadt(genannterOrt, quelle.ort) || (quelle.ort ?? '');
    const adresse = httpsAdresse(glatt(rssFeld(eintrag, 'link'))) ?? httpsAdresse(quelle.seite);
    if (titel === '' || beginn === null || ort === '' || adresse === null) return [];
    const woerter = [...rssFelder(eintrag, 'category'), ...rssFelder(eintrag, 'ev:type'), ...pfadWoerter(adresse)];
    return [termin(titel, ort, beginn, kategorieAus(woerter), adresse)];
  });
}

function typen(knoten) {
  const roh = knoten['@type'];
  return (Array.isArray(roh) ? roh : [roh])
    .filter((typ) => typeof typ === 'string')
    .map((typ) => typ.replace(/^.*[/#:]/, ''));
}

function istEreignis(knoten) {
  return typen(knoten).some((typ) => typ === 'Event' || typ === 'Festival' || /Event$/.test(typ));
}

function erstes(wert) {
  return Array.isArray(wert) ? wert[0] : wert;
}

function ortAus(ort) {
  const eins = erstes(ort);
  if (typeof eins === 'string') return glatt(eins);
  if (!istObjekt(eins)) return '';
  const name = glatt(typeof eins.name === 'string' ? eins.name : '');
  const anschrift = erstes(eins.address);
  const stadt = istObjekt(anschrift) && typeof anschrift.addressLocality === 'string' ? glatt(anschrift.addressLocality) : '';
  const strasse =
    typeof anschrift === 'string'
      ? glatt(anschrift)
      : istObjekt(anschrift) && typeof anschrift.streetAddress === 'string'
        ? glatt(anschrift.streetAddress)
        : '';
  if (name !== '') return stadt !== '' && !name.includes(stadt) ? `${name}, ${stadt}` : name;
  return [strasse, stadt].filter(Boolean).join(', ');
}

function sammleEreignisse(knoten, ablage) {
  if (Array.isArray(knoten)) {
    for (const kind of knoten) sammleEreignisse(kind, ablage);
    return;
  }
  if (!istObjekt(knoten)) return;
  if (Array.isArray(knoten['@graph'])) sammleEreignisse(knoten['@graph'], ablage);
  if (istEreignis(knoten)) ablage.push(knoten);
}

/**
 * Nur, was eine Seite in `<script type="application/ld+json">` über sich
 * selbst ausweist (Vermerk 505 an Regel 7) — eine Antwort, die selbst JSON
 * ist (eine Sammel-Schnittstelle), liest der Job nicht.
 */
export function liesJsonLd(text, quelle) {
  const bloecke = [...text.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (treffer) => treffer[1],
  );
  const ereignisse = [];
  for (const block of bloecke) {
    try {
      sammleEreignisse(JSON.parse(block.replace(/^\s*<!--|-->\s*$/g, '')), ereignisse);
    } catch {
      // Ein kaputter Block ist kein Grund, die anderen zu verwerfen.
    }
  }
  return ereignisse.flatMap((e) => {
    const status = JSON.stringify(e.eventStatus ?? '');
    const modus = JSON.stringify(e.eventAttendanceMode ?? '');
    if (/EventCancelled/.test(status) || (/OnlineEventAttendanceMode/.test(modus) && !/Mixed/.test(modus))) return [];
    const titel = glatt(typeof e.name === 'string' ? e.name : '');
    const beginn = beginnAusIso(erstes(e.startDate));
    const ort = ortAus(e.location) || (quelle.ort ?? '');
    const adresse = httpsAdresse(erstes(e.url)) ?? httpsAdresse(quelle.seite) ?? httpsAdresse(quelle.url);
    if (titel === '' || beginn === null || ort === '' || adresse === null) return [];
    return [termin(titel, ort, beginn, kategorieAus([...typen(e), ...pfadWoerter(adresse)]), adresse)];
  });
}

const LESER = { ical: liesIcal, rss: liesRss, jsonld: liesJsonLd };

/**
 * Ein Titel, der selbst sagt, dass der Termin nicht stattfindet („-- ENTFÄLLT --",
 * „(Vorstellungsausfall)").
 */
const ABGESAGT =
  /(^|[^\p{L}])(entfällt|entfaellt|abgesagt|fällt aus|faellt aus|fällt leider aus|faellt leider aus|ausfall|vorstellungsausfall|storniert|cancelled|canceled)([^\p{L}]|$)/iu;

/**
 * Die Termine einer Antwort: gelesen, ab heute, ohne abgesagte, Titel ohne
 * Vermerke der Quelle, doppelte zusammengelegt, nach Beginn (ohne Uhrzeit
 * zuerst).
 */
export function termineAus(art, antwort, quelle, heute) {
  const gesehen = new Set();
  return LESER[art](antwort, quelle)
    .filter((eintrag) => eintrag.beginn.slice(0, 10) >= heute && !ABGESAGT.test(eintrag.titel))
    .map((eintrag) => ({ ...eintrag, titel: titelOhneVermerk(eintrag.titel) }))
    .filter((eintrag) => {
      const schluessel = `${eintrag.titel.toLocaleLowerCase('de-DE')}|${eintrag.beginn}|${eintrag.ort.toLocaleLowerCase('de-DE')}`;
      if (gesehen.has(schluessel)) return false;
      gesehen.add(schluessel);
      return true;
    })
    .sort((a, b) => (a.beginn < b.beginn ? -1 : a.beginn > b.beginn ? 1 : 0));
}

// --- Der höfliche Abruf ----------------------------------------------------

const NAME = 'lompass-trends';
const NAMEN_IN_ROBOTS = [NAME, 'lompass'];
const USER_AGENT = `${NAME}/1.0 (+https://github.com/floooooooo123445/lompass-trends)`;
const MINDESTABSTAND_MS = 1000;
const CRAWL_DELAY_MAX_S = 30;
const ZEITGRENZE_MS = 20_000;
const GROESSE_MAX = 10 * 1024 * 1024;
const WEITERLEITUNGEN_MAX = 3;

const zuletzt = new Map();
const robotsJeHost = new Map();

const schlafe = (ms) => new Promise((fertig) => setTimeout(fertig, ms));

async function bremse(host, abstandMs) {
  const vorher = zuletzt.get(host);
  if (vorher !== undefined) {
    const warten = vorher + abstandMs - Date.now();
    if (warten > 0) await schlafe(warten);
  }
  zuletzt.set(host, Date.now());
}

/** Eine Anfrage, gebremst, ohne Weiterleitung zu folgen, mit Zeit- und Größengrenze. */
async function anfrage(adresse, abstandMs, annahme) {
  const url = new URL(adresse);
  await bremse(url.host, abstandMs);
  const abbruch = new AbortController();
  const uhr = setTimeout(() => abbruch.abort(), ZEITGRENZE_MS);
  try {
    const antwort = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: annahme },
      redirect: 'manual',
      signal: abbruch.signal,
    });
    if (antwort.status >= 300 && antwort.status < 400) {
      await antwort.body?.cancel();
      return { status: antwort.status, ort: antwort.headers.get('location'), text: '', art: '' };
    }
    const teile = [];
    let groesse = 0;
    if (antwort.body !== null) {
      for await (const stueck of antwort.body) {
        groesse += stueck.length;
        if (groesse > GROESSE_MAX) {
          abbruch.abort();
          throw new Error(`zu groß (über ${GROESSE_MAX} Bytes)`);
        }
        teile.push(stueck);
      }
    }
    const art = antwort.headers.get('content-type') ?? '';
    const zeichensatz = /charset=([^;\s]+)/i.exec(art)?.[1]?.toLowerCase() ?? 'utf-8';
    let dekodierer;
    try {
      dekodierer = new TextDecoder(zeichensatz);
    } catch {
      dekodierer = new TextDecoder('utf-8');
    }
    return { status: antwort.status, ort: null, text: dekodierer.decode(Buffer.concat(teile)), art };
  } finally {
    clearTimeout(uhr);
  }
}

/** Die Gruppen einer `robots.txt` (RFC 9309), mit `Crawl-delay`. */
export function robotsRegeln(text) {
  const gruppen = [];
  let aktuell = null;
  let regelGesehen = false;
  for (const roh of text.split(/\r\n|\r|\n/)) {
    const zeile = roh.replace(/#.*$/, '').trim();
    const doppelpunkt = zeile.indexOf(':');
    if (doppelpunkt <= 0) continue;
    const schluessel = zeile.slice(0, doppelpunkt).trim().toLowerCase();
    const wert = zeile.slice(doppelpunkt + 1).trim();
    if (schluessel === 'user-agent') {
      if (aktuell === null || regelGesehen) {
        aktuell = { namen: [], regeln: [], verzoegerung: null };
        gruppen.push(aktuell);
        regelGesehen = false;
      }
      aktuell.namen.push(wert.toLowerCase());
    } else if (aktuell !== null && (schluessel === 'allow' || schluessel === 'disallow')) {
      regelGesehen = true;
      if (wert !== '') aktuell.regeln.push({ erlaubt: schluessel === 'allow', pfad: wert });
    } else if (aktuell !== null && schluessel === 'crawl-delay') {
      regelGesehen = true;
      const sekunden = Number(wert);
      aktuell.verzoegerung = Number.isFinite(sekunden) && sekunden >= 0 ? sekunden : null;
    }
  }
  const unsere = gruppen.filter((gruppe) => gruppe.namen.some((name) => NAMEN_IN_ROBOTS.includes(name)));
  const gewaehlt = unsere.length > 0 ? unsere : gruppen.filter((gruppe) => gruppe.namen.includes('*'));
  return {
    regeln: gewaehlt.flatMap((gruppe) => gruppe.regeln),
    verzoegerung: gewaehlt.reduce((max, gruppe) => Math.max(max, gruppe.verzoegerung ?? 0), 0),
  };
}

function regelTrifft(muster, pfad) {
  const ende = muster.endsWith('$');
  const kern = (ende ? muster.slice(0, -1) : muster)
    .split('*')
    .map((teil) => teil.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${kern}${ende ? '$' : ''}`).test(pfad);
}

/** Ob ein Pfad erlaubt ist — die längste passende Regel gilt, bei Gleichstand „Allow". */
export function robotsErlaubt(regeln, pfad) {
  let beste = null;
  for (const regel of regeln.regeln) {
    if (!regelTrifft(regel.pfad, pfad)) continue;
    if (beste === null || regel.pfad.length > beste.pfad.length || (regel.pfad.length === beste.pfad.length && regel.erlaubt)) {
      beste = regel;
    }
  }
  return beste === null || beste.erlaubt;
}

async function robotsFuer(url) {
  const bekannt = robotsJeHost.get(url.host);
  if (bekannt !== undefined) return bekannt;
  let regeln;
  try {
    let adresse = `${url.origin}/robots.txt`;
    let antwort = await anfrage(adresse, MINDESTABSTAND_MS, 'text/plain');
    for (let sprung = 0; sprung < 5 && antwort.ort !== null; sprung += 1) {
      adresse = new URL(antwort.ort, adresse).toString();
      if (!adresse.startsWith('https://')) break;
      antwort = await anfrage(adresse, MINDESTABSTAND_MS, 'text/plain');
    }
    if (antwort.status >= 200 && antwort.status < 300) {
      regeln = robotsRegeln(antwort.text);
    } else if (antwort.status >= 400 && antwort.status < 500) {
      // RFC 9309: Ist die Datei nicht da, ist nichts verboten.
      regeln = { regeln: [], verzoegerung: 0 };
    } else {
      regeln = { regeln: [{ erlaubt: false, pfad: '/' }], verzoegerung: 0 };
    }
  } catch {
    // Nicht erreichbar heißt nach RFC 9309: alles verboten.
    regeln = { regeln: [{ erlaubt: false, pfad: '/' }], verzoegerung: 0 };
  }
  robotsJeHost.set(url.host, regeln);
  return regeln;
}

const ANNAHME = {
  ical: 'text/calendar, */*;q=0.1',
  rss: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1',
  jsonld: 'text/html, */*;q=0.1',
};

/** Genau die Adresse einer Quelle — oder ein Fehler mit Grund. */
async function holeQuelle(quelle) {
  let url = new URL(quelle.url);
  for (let sprung = 0; sprung <= WEITERLEITUNGEN_MAX; sprung += 1) {
    const regeln = await robotsFuer(url);
    if (regeln.verzoegerung > CRAWL_DELAY_MAX_S) throw new Error(`Crawl-delay ${regeln.verzoegerung} s`);
    if (!robotsErlaubt(regeln, `${url.pathname}${url.search}`)) throw new Error('robots.txt verbietet den Abruf');
    const antwort = await anfrage(url.toString(), Math.max(MINDESTABSTAND_MS, regeln.verzoegerung * 1000), ANNAHME[quelle.art]);
    if (antwort.ort !== null) {
      const weiter = new URL(antwort.ort, url);
      if (weiter.protocol !== 'https:' || weiter.host !== url.host) throw new Error(`Weiterleitung nach ${weiter.host}`);
      url = weiter;
      continue;
    }
    if (antwort.status < 200 || antwort.status >= 300) throw new Error(`HTTP ${antwort.status}`);
    return antwort.text;
  }
  throw new Error('zu viele Weiterleitungen');
}

// --- Der Lauf --------------------------------------------------------------

const WURZEL = dirname(fileURLToPath(import.meta.url));

function leseQuellen() {
  const roh = JSON.parse(readFileSync(join(WURZEL, 'nahe-quellen.json'), 'utf8'));
  if (!Array.isArray(roh)) throw new Error('nahe-quellen.json ist keine Liste.');
  return roh.flatMap((eintrag, stelle) => {
    const geprueft = pruefeQuelle(eintrag);
    if (geprueft === null) {
      console.error(`Quelle ${stelle + 1} fällt: ohne Lizenz, ohne https, fremde Art oder Plattform.`);
      return [];
    }
    return [{ ...eintrag, ...geprueft }];
  });
}

function argument(name) {
  const stelle = process.argv.indexOf(name);
  return stelle >= 0 ? process.argv[stelle + 1] : undefined;
}

async function lauf() {
  const nurStadt = argument('--stadt');
  const ziel = resolve(argument('--ziel') ?? join(WURZEL, 'nahe'));
  const quellen = leseQuellen().filter((quelle) => nurStadt === undefined || quelle.stadt === nurStadt);
  if (quellen.length === 0) {
    throw new Error(nurStadt === undefined ? 'Die Quellenliste ist leer.' : `Keine Quelle für ${nurStadt}.`);
  }
  const heute = heuteInBerlin();
  const staedte = [...new Set(quellen.map((quelle) => quelle.stadt))];
  let geschrieben = 0;
  for (const stadt of staedte) {
    const genutzt = [];
    const gesammelt = [];
    for (const quelle of quellen.filter((eintrag) => eintrag.stadt === stadt)) {
      try {
        const antwort = await holeQuelle(quelle);
        const gelesen = termineAus(quelle.art, antwort, quelle, heute);
        console.log(`${stadt}: ${gelesen.length} Termine aus ${quelle.url}`);
        if (gelesen.length > 0) {
          gesammelt.push(...gelesen);
          genutzt.push({ herausgeber: quelle.herausgeber ?? null, lizenz: quelle.lizenz, nachweis: quelle.nachweis ?? quelle.url });
        }
      } catch (fehler) {
        console.error(`${stadt}: ${quelle.url} fällt aus — ${fehler instanceof Error ? fehler.message : fehler}`);
      }
    }
    const gesehen = new Set();
    const termine = gesammelt
      .sort((a, b) => (a.beginn < b.beginn ? -1 : a.beginn > b.beginn ? 1 : 0))
      .filter((eintrag) => {
        const schluessel = `${eintrag.titel.toLocaleLowerCase('de-DE')}|${eintrag.beginn}|${eintrag.ort.toLocaleLowerCase('de-DE')}`;
        if (gesehen.has(schluessel)) return false;
        gesehen.add(schluessel);
        return true;
      })
      .slice(0, TERMINE_MAX);
    const geprueft = pruefeDatei({ stadt, stand: heute, termine }, stadt);
    if (geprueft === null || geprueft.termine.length === 0) {
      console.error(`${stadt}: kein Termin. Die alte Datei bleibt.`);
      continue;
    }
    mkdirSync(ziel, { recursive: true });
    const datei = { stadt: geprueft.stadt, stand: geprueft.stand, quellen: genutzt, termine: geprueft.termine };
    writeFileSync(join(ziel, `${stadt}.json`), `${JSON.stringify(datei, null, 2)}\n`);
    console.log(`${stadt}: ${geprueft.termine.length} Termine geschrieben (${join(ziel, `${stadt}.json`)}).`);
    geschrieben += 1;
  }
  if (geschrieben === 0) throw new Error('Keine Stadt geschrieben. Die alten Dateien bleiben.');
}

function stdinJson() {
  return JSON.parse(readFileSync(0, 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let ablauf;
  if (process.argv[2] === '--pruefe') {
    ablauf = Promise.resolve().then(() => process.stdout.write(JSON.stringify(pruefeDatei(stdinJson()))));
  } else if (process.argv[2] === '--quellen') {
    ablauf = Promise.resolve().then(() => {
      const roh = stdinJson();
      process.stdout.write(JSON.stringify(Array.isArray(roh) ? roh.map(pruefeQuelle) : null));
    });
  } else if (process.argv[2] === '--lies') {
    ablauf = Promise.resolve().then(() => {
      const { art, text: antwort, quelle, heute } = stdinJson();
      process.stdout.write(JSON.stringify(termineAus(art, antwort, quelle, heute)));
    });
  } else {
    ablauf = lauf();
  }
  ablauf.catch((fehler) => {
    console.error(fehler instanceof Error ? fehler.message : fehler);
    process.exit(1);
  });
}
