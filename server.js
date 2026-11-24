'use strict';
// PokeLister — photograph Pokémon cards, identify them, export eBay draft listings.
// Zero dependencies. Needs Node 18+ (uses the built-in fetch).
//
// Environment variables:
//   ANTHROPIC_API_KEY   required — used to read the cards in your photos
//   APP_PASSWORD        recommended — stops anyone else using your API credit
//   IMGBB_API_KEY       recommended — hosts your front/back photos so eBay can pull them in
//   PULSE_API_KEY       recommended — PulseTCG prices (same key as PokeSnipe)
//   PULSE_DAILY_LIMIT   optional — max Pulse lookups per day from PokeLister (default 400)
//   POKEMONTCG_API_KEY  optional — free key from dev.pokemontcg.io (higher rate limit)
//   MODEL               optional — defaults to claude-sonnet-5-5
//   PORT                set automatically by Render

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const PTCG_KEY = process.env.POKEMONTCG_API_KEY || '';
const IMGBB_KEY = process.env.IMGBB_API_KEY || '';
const PULSE_KEY = process.env.PULSE_API_KEY || '';
const PULSE_SEARCH_URL = 'https://q.pulseapi.dev/api/v1/cards/search';
// PokeSnipe shares the same 1,000-credit daily budget, so PokeLister stays under its own cap.
const PULSE_DAILY_LIMIT = Number(process.env.PULSE_DAILY_LIMIT) || 400;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const PTCG_URL = 'https://api.pokemontcg.io/v2/cards';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const PROMPT = `You are identifying Pokémon trading cards in a photo so they can be listed for sale on eBay.
The photo may show one card or several (for example a binder page). Return an entry for EVERY card you can see well enough to identify, ordered left-to-right, top-to-bottom.
Read the text printed on the card itself rather than guessing from the artwork. The collector number is near the bottom of the card, e.g. "025/198", "4/102", "TG05/TG30", "SWSH050" or "SVP 012".

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"cards":[{
  "name": "card name exactly as printed, including suffixes like ex, V, VMAX, VSTAR, GX, EX",
  "number": "collector number before the slash, exactly as printed (keep leading zeros)",
  "set_total": "number after the slash, or empty string if there is none",
  "set_name": "your best guess at the set name, or empty string",
  "set_code": "set code printed on the card if visible (e.g. PAL, OBF, SVI), or empty string",
  "rarity": "your best guess at the rarity",
  "finish": "one of: normal, holo, reverse holo, unknown",
  "first_edition": false,
  "language": "English, Japanese, etc.",
  "notes": "anything a seller should know: graded slab, visible damage, promo stamp, card hard to read; empty string if nothing",
  "confidence": 0.9
}]}
"first_edition" is true only if a 1st Edition stamp is visible. "confidence" is a number from 0 to 1 for how sure you are of the name AND number.
If the photo shows only the BACK of a card or cards (the standard blue Poké Ball back) and no card fronts, reply {"cards":[],"card_back":true}.
If no card is visible at all, reply {"cards":[]}.`;

// ---------- small helpers ----------

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(new Error('Upload too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function authorised(req) {
  if (!APP_PASSWORD) return true;
  return crypto.timingSafeEqual(sha(req.headers['x-app-key'] || ''), sha(APP_PASSWORD));
}

async function fetchJSON(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const str = (v) => (v == null ? '' : String(v)).trim().slice(0, 300);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function parseLooseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Could not read the AI response');
  return JSON.parse(m[0]);
}

// ---------- step 1: read the cards in the photo ----------

function cleanDetected(c) {
  const finish = str(c.finish).toLowerCase();
  let confidence = Number(c.confidence);
  if (!isFinite(confidence)) confidence = 0.5;
  return {
    name: str(c.name),
    number: str(c.number).replace(/\s+/g, ''),
    set_total: str(c.set_total).replace(/\s+/g, ''),
    set_name: str(c.set_name),
    set_code: str(c.set_code),
    rarity: str(c.rarity),
    finish: ['normal', 'holo', 'reverse holo'].includes(finish) ? finish : 'unknown',
    first_edition: c.first_edition === true,
    language: str(c.language) || 'English',
    notes: str(c.notes),
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

async function identifyCards(base64, mediaType) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  const body = {
    model: MODEL,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  };
  const { ok, status, data } = await fetchJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, 120000);
  if (!ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${status}`;
    throw new Error('Claude API: ' + msg);
  }
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseLooseJSON(text);
  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  return {
    cards: cards.map(cleanDetected).filter((c) => c.name || c.number),
    cardBack: parsed.card_back === true,
  };
}

// ---------- photo hosting (ImgBB) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadToImgbb(base64, name) {
  if (!IMGBB_KEY) throw new Error('IMGBB_API_KEY is not set on the server');
  const form = new URLSearchParams();
  form.set('image', base64);
  if (name) form.set('name', name);
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    let result;
    try {
      result = await fetchJSON(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(IMGBB_KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }, 60000);
    } catch (e) {
      lastErr = new Error('ImgBB: ' + e.message);
      continue; // network error or timeout: try again
    }
    const { ok, status, data } = result;
    if (ok && data && data.success && data.data && data.data.url) {
      return { url: data.data.url, deleteUrl: data.data.delete_url || '' };
    }
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${status}`;
    lastErr = new Error('ImgBB: ' + msg);
    if (!(status === 429 || status >= 500)) break; // not worth retrying
  }
  throw lastErr;
}

function parseImageBody(body) {
  let img = String((body && body.image) || '');
  let mediaType = 'image/jpeg';
  const m = img.match(/^data:(image\/[a-z+.-]+);base64,/i);
  if (m) {
    mediaType = m[1].toLowerCase();
    img = img.slice(m[0].length);
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
    throw Object.assign(new Error('Unsupported image type'), { status: 400 });
  }
  if (img.length < 100) throw Object.assign(new Error('No image received'), { status: 400 });
  return { img, mediaType };
}

async function readJSONBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch (e) {
    throw Object.assign(new Error(e.message === 'Upload too large' ? e.message : 'Bad request'), { status: 400 });
  }
}

// ---------- step 2: match against the card database ----------

function normNumber(n) {
  const s = String(n || '').replace(/\s+/g, '').toUpperCase();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function luceneQuote(s) {
  return '"' + String(s).replace(/["\\]/g, '\\$&') + '"';
}

async function ptcgSearchOnce(q, pageSize) {
  const url = `${PTCG_URL}?q=${encodeURIComponent(q)}&pageSize=${pageSize}&orderBy=-set.releaseDate`;
  const headers = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {};
  const { ok, status, data } = await fetchJSON(url, { headers }, 20000);
  if (!ok) throw new Error(`card database error (HTTP ${status})`);
  return Array.isArray(data.data) ? data.data : [];
}

// The free card database is sometimes slow or briefly down, so try twice before giving up.
async function ptcgSearch(q, pageSize = 15) {
  try {
    return await ptcgSearchOnce(q, pageSize);
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await ptcgSearchOnce(q, pageSize);
    } catch (e2) {
      throw new Error(e2.message === 'Request timed out' ? 'card database didn\'t respond' : e2.message);
    }
  }
}

function toCandidate(card) {
  const set = card.set || {};
  const cm = (card.cardmarket && card.cardmarket.prices) || {};
  let tcgMarket = null;
  const tp = card.tcgplayer && card.tcgplayer.prices;
  if (tp) {
    for (const k of Object.keys(tp)) {
      if (tp[k] && num(tp[k].market) != null) { tcgMarket = tp[k].market; break; }
    }
  }
  return {
    id: card.id || '',
    name: card.name || '',
    number: card.number || '',
    setName: set.name || '',
    setId: set.id || '',
    series: set.series || '',
    printedTotal: set.printedTotal || set.total || '',
    ptcgoCode: set.ptcgoCode || '',
    releaseDate: set.releaseDate || '',
    rarity: card.rarity || '',
    supertype: card.supertype || '',
    subtypes: Array.isArray(card.subtypes) ? card.subtypes : [],
    types: Array.isArray(card.types) ? card.types : [],
    image: (card.images && card.images.small) || '',
    imageLarge: (card.images && card.images.large) || '',
    cmTrend: num(cm.trendPrice),
    cmReverseHoloTrend: num(cm.reverseHoloTrend),
    tcgMarket: num(tcgMarket),
  };
}

function scoreCandidate(c, d) {
  let s = 0;
  const dn = normNumber(d.number);
  if (dn && dn === normNumber(c.number)) s += 4;
  if (/^\d+$/.test(d.set_total) && String(c.printedTotal) === String(parseInt(d.set_total, 10))) s += 3;
  const a = d.name.toLowerCase();
  const b = c.name.toLowerCase();
  if (a && a === b) s += 3;
  else if (a && (b.includes(a) || a.includes(b))) s += 2;
  else if (a && b.split(/[\s-]/)[0] === a.split(/[\s-]/)[0]) s += 1;
  const ds = d.set_name.toLowerCase();
  const cs = c.setName.toLowerCase();
  if (ds && cs && ds === cs) s += 2;
  else if (ds && cs && (cs.includes(ds) || ds.includes(cs))) s += 1;
  if (d.set_code && c.ptcgoCode && d.set_code.toUpperCase() === c.ptcgoCode.toUpperCase()) s += 2;
  return s;
}

async function lookupCard(d) {
  const n = normNumber(d.number);
  const total = /^\d+$/.test(d.set_total) ? String(parseInt(d.set_total, 10)) : '';
  const firstWord = (d.name.split(/[\s-]/)[0] || '').replace(/[^\p{L}\p{N}']/gu, '');

  const tries = [];
  if (d.name && n) tries.push(`name:${luceneQuote(d.name)} number:${luceneQuote(n)}`);
  if (n && total) tries.push(`number:${luceneQuote(n)} set.printedTotal:${total}`);
  if (firstWord && n) tries.push(`name:${firstWord}* number:${luceneQuote(n)}`);
  if (d.name) tries.push(`name:${luceneQuote(d.name)}`);

  const seen = new Map();
  let lastErr = null;
  for (const q of tries) {
    let found = [];
    try { found = await ptcgSearch(q); } catch (e) { lastErr = e; continue; }
    for (const c of found) if (c.id && !seen.has(c.id)) seen.set(c.id, toCandidate(c));
    const exact = [...seen.values()].some((c) =>
      normNumber(c.number) === n && (!total || String(c.printedTotal) === total));
    if (exact) break;
  }
  const list = [...seen.values()]
    .map((c) => ({ ...c, score: scoreCandidate(c, d) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!list.length && lastErr) throw lastErr;
  return list;
}

function statusFor(d, candidates) {
  if (!candidates.length) return 'nomatch';
  const top = candidates[0];
  const runnerUp = candidates[1];
  const clearWinner = !runnerUp || top.score > runnerUp.score;
  return top.score >= 7 && clearWinner && d.confidence >= 0.6 ? 'ok' : 'check';
}

// ---------- step 3: PulseTCG price (same API as PokeSnipe) ----------

const pulseCache = new Map(); // key -> { at, result }
const PULSE_PRICE_VERSION = 3; // bump to ignore prices cached under an older rule
const PULSE_CACHE_MS = 24 * 60 * 60 * 1000;
const PULSE_NOMATCH_CACHE_MS = 60 * 60 * 1000; // retry misses after an hour
const pulseUsage = { day: '', count: 0 };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pulseCreditsLeft() {
  if (pulseUsage.day !== todayKey()) { pulseUsage.day = todayKey(); pulseUsage.count = 0; }
  return Math.max(0, PULSE_DAILY_LIMIT - pulseUsage.count);
}

// When the card database fails we only have what the AI read, so map the set code printed
// on the card (or the set name) to the set id Pulse uses in its product ids.
const SET_CODES = {
  SVI: 'sv1', PAL: 'sv2', OBF: 'sv3', MEW: 'sv3pt5', PAR: 'sv4', PAF: 'sv4pt5', TEF: 'sv5',
  TWM: 'sv6', SFA: 'sv6pt5', SCR: 'sv7', SSP: 'sv8', PRE: 'sv8pt5', JTG: 'sv9', DRI: 'sv10',
  SSH: 'swsh1', RCL: 'swsh2', DAA: 'swsh3', CPA: 'swsh35', VIV: 'swsh4', SHF: 'swsh45',
  BST: 'swsh5', CRE: 'swsh6', EVS: 'swsh7', CEL: 'cel25', FST: 'swsh8', BRS: 'swsh9',
  ASR: 'swsh10', PGO: 'pgo', LOR: 'swsh11', SIT: 'swsh12', CRZ: 'swsh12pt5',
  MEG: 'me1', ME1: 'me1', PFL: 'me2', ME2: 'me2',
};
const SET_NAMES = [
  ['phantasmal flames', 'me2'], ['mega evolution', 'me1'],
  ['paldea evolved', 'sv2'], ['obsidian flames', 'sv3'], ['151', 'sv3pt5'], ['paradox rift', 'sv4'],
  ['paldean fates', 'sv4pt5'], ['temporal forces', 'sv5'], ['twilight masquerade', 'sv6'],
  ['shrouded fable', 'sv6pt5'], ['stellar crown', 'sv7'], ['surging sparks', 'sv8'],
  ['prismatic evolutions', 'sv8pt5'], ['journey together', 'sv9'], ['destined rivals', 'sv10'],
  ['scarlet & violet', 'sv1'], ['scarlet and violet', 'sv1'],
  ['rebel clash', 'swsh2'], ['darkness ablaze', 'swsh3'], ["champion's path", 'swsh35'],
  ['vivid voltage', 'swsh4'], ['shining fates', 'swsh45'], ['battle styles', 'swsh5'],
  ['chilling reign', 'swsh6'], ['evolving skies', 'swsh7'], ['celebrations', 'cel25'],
  ['fusion strike', 'swsh8'], ['brilliant stars', 'swsh9'], ['astral radiance', 'swsh10'],
  ['pokémon go', 'pgo'], ['pokemon go', 'pgo'], ['lost origin', 'swsh11'],
  ['silver tempest', 'swsh12'], ['crown zenith', 'swsh12pt5'], ['sword & shield', 'swsh1'],
];
function guessSetId(code, name) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (SET_CODES[c]) return SET_CODES[c];
  const n = String(name || '').toLowerCase();
  const hit = n && SET_NAMES.find(([k]) => n.includes(k));
  return hit ? hit[1] : '';
}

// Same suffix stripping PokeSnipe uses, so names match Pulse's format.
function pulseName(name) {
  return String(name || '').replace(/\b(ex|EX|GX|VMAX|VSTAR|V)\b/g, '').replace(/\s+/g, ' ').trim();
}

function numPart(s) {
  const t = String(s || '').toUpperCase().replace(/\s+/g, '');
  return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t;
}

// "025/198" and "25/198" count as the same card number
function sameCardNumber(a, b) {
  const [a1, a2 = ''] = String(a || '').split('/');
  const [b1, b2 = ''] = String(b || '').split('/');
  return numPart(a1) === numPart(b1) && (!a2 || !b2 || numPart(a2) === numPart(b2));
}

async function pulseSearch(params) {
  if (pulseCreditsLeft() <= 0) {
    throw Object.assign(new Error(`Daily Pulse limit (${PULSE_DAILY_LIMIT}) reached — type the price in by hand`), { code: 'limit' });
  }
  pulseUsage.count++;
  const qs = new URLSearchParams({ exclude_graded: 'true', exclude_conditioned: 'true', limit: '10', ...params });
  const { ok, status, data } = await fetchJSON(`${PULSE_SEARCH_URL}?${qs}`, { headers: { 'x-api-key': PULSE_KEY } }, 20000);
  if (!ok) throw new Error(`Pulse search returned ${status}`);
  return Array.isArray(data && data.data) ? data.data : [];
}

// Use Pulse's headline "Market price" (what the PulseTCG app shows), falling back to the
// Cardmarket Near Mint price only when there's no market price. Both are returned so the
// app can show them side by side.
function pulsePriceOf(r) {
  const p = (r && r.prices) || {};
  const market = typeof p.market_price === 'number' && p.market_price > 0 ? p.market_price : null;
  const cmNm = p.cm && p.cm.gbp && typeof p.cm.gbp.nm === 'number' && p.cm.gbp.nm > 0 ? p.cm.gbp.nm : null;
  if (market != null) return { gbp: market, basis: 'market price', market, cmNm };
  if (cmNm != null) return { gbp: cmNm, basis: 'Cardmarket NM (no market price)', market, cmNm };
  return null;
}

// Pick the result that matches our set (Pulse product ids look like "card:sv3pt5|199/165|...",
// using the same set ids as the card database) and card number.
// Pulse product ids look like "card:<set>|<number>|<variant>|...". Foreign printings have
// set parts ending in _jp, _kr, _cn etc.
function pulseSetPart(r) {
  return String((r && r.product_id) || '').toLowerCase().split('|')[0].replace(/^card:/, '');
}
function isForeignPrinting(r) {
  return /_(jp|kr|cn|tw|th|id|ja|ko|zh)$/.test(pulseSetPart(r)) || /[_-](jp|kr|cn|tw)[_-]/.test(pulseSetPart(r));
}

// The card database and Pulse spell some set ids differently, e.g. Mega Evolution is
// "me1" in the database but "m1" in Pulse. Compare them in one shared form.
function normSetId(id) {
  return String(id || '').toLowerCase().replace(/^card:/, '').replace(/^me(\d)/, 'm$1');
}

// Returns { result, how } or null. how = 'set+number' (safe) or 'number' (no set confirmation).
function pickPulseResult(results, setId, cardNumber, english = true) {
  const usable = results.filter((r) => pulsePriceOf(r) && !(english && isForeignPrinting(r)));
  const numberMatches = cardNumber ? usable.filter((r) => sameCardNumber(r.card_number, cardNumber)) : [];
  if (setId) {
    const exact = numberMatches.find((r) => normSetId(pulseSetPart(r)) === normSetId(setId));
    if (exact) return { result: exact, how: 'set+number' };
  }
  // No set confirmation: accept only if every number match comes from one single set,
  // so we never pick between two different printings.
  const sets = new Set(numberMatches.map(pulseSetPart));
  if (numberMatches.length && sets.size === 1) return { result: numberMatches[0], how: 'number' };
  return null;
}

// "034" + "086" -> ["034/086", "34/86"]; letters (TG05/TG30, SWSH050) are kept as printed
function cardNumberVariants(number, total) {
  const n = String(number || '').trim();
  const t = String(total || '').trim();
  if (!n) return [];
  if (!t) return [n];
  if (/[A-Z]/i.test(n + t)) return [`${n}/${t}`];
  const pad = (x) => String(parseInt(x, 10)).padStart(3, '0');
  return [...new Set([`${n}/${t}`, `${pad(n)}/${pad(t)}`, `${parseInt(n, 10)}/${parseInt(t, 10)}`])];
}

async function pulseLookup({ name, number, total, setId, setLabel, language }) {
  if (!PULSE_KEY) return { status: 'off' };
  const variants = cardNumberVariants(number, total);
  const printed = variants[0] || '';
  const english = !language || /^english$/i.test(language);
  const key = `v${PULSE_PRICE_VERSION}|${String(setId || '').toLowerCase()}|${numPart(number)}|${pulseName(name).toLowerCase()}`;
  const hit = pulseCache.get(key);
  if (hit && Date.now() - hit.at < (hit.result.status === 'ok' ? PULSE_CACHE_MS : PULSE_NOMATCH_CACHE_MS)) return hit.result;

  const q = pulseName(name);
  const tries = variants.map((cn) => ({ q, card_number: cn }));
  if (q) tries.push({ q, limit: '40' }); // name only, wider net

  let result = null;
  const tried = [];
  for (const params of tries) {
    const found = await pulseSearch(params);
    tried.push({
      search: [params.q, params.card_number].filter(Boolean).join(' '),
      results: found.length,
      sample: found.filter((r) => !(english && isForeignPrinting(r))).slice(0, 3).map((r) => String(r.product_id || r.card_number || '?').split('|').slice(0, 3).join('|')),
      foreignSkipped: english ? found.filter(isForeignPrinting).length : 0,
    });
    const pick = pickPulseResult(found, setId, printed, english);
    if (pick) {
      const best = pick.result;
      const price = pulsePriceOf(best);
      result = {
        v: PULSE_PRICE_VERSION, status: 'ok', gbp: price.gbp, basis: price.basis, market: price.market, cmNm: price.cmNm,
        productId: best.product_id || '', cardNumber: best.card_number || '',
        matchedBy: pick.how,
      };
      break;
    }
  }
  // explain a miss so a screenshot shows what happened
  if (!result) result = { status: 'nomatch', tried, wanted: { number: printed, set: setLabel || setId || '' } };
  pulseCache.set(key, { at: Date.now(), result });
  return result;
}

// Works out what to ask Pulse for, from the database match (preferred) or what the AI read.
function pulseQueryFor(candidate, detected) {
  if (candidate) {
    const d = detected || {};
    const printedNum = d.number && numPart(d.number) === numPart(candidate.number) ? d.number : candidate.number;
    // keep the total as printed on the card ("086", not "86") when it's the same number
    const printedTotal = d.set_total && numPart(d.set_total) === numPart(candidate.printedTotal) ? d.set_total : String(candidate.printedTotal || '');
    return { name: candidate.name, number: printedNum, total: printedTotal,
      setId: candidate.setId, setLabel: candidate.setName, language: detected && detected.language };
  }
  const d = detected || {};
  return { name: d.name, number: d.number, total: d.set_total,
    setId: guessSetId(d.set_code, d.set_name), setLabel: d.set_name || d.set_code, language: d.language };
}

async function safePulse(query) {
  try {
    return await pulseLookup(query);
  } catch (e) {
    return { status: e.code === 'limit' ? 'limit' : 'error', error: e.message };
  }
}

// ---------- routes ----------

// Card database match + Pulse price for one card the AI read.
async function matchOne(d) {
  let candidates = [];
  let error;
  try {
    candidates = await lookupCard(d);
  } catch (e) {
    error = e.message;
  }
  const pulse = await safePulse(pulseQueryFor(candidates[0], d));
  return { detected: d, candidates, status: error || !candidates.length ? 'nomatch' : statusFor(d, candidates), pulse, ...(error ? { error } : {}) };
}

async function handleMatch(req, res) {
  const body = await readJSONBody(req);
  if (!body || typeof body.detected !== 'object') return sendJSON(res, 400, { error: 'Missing card details' });
  sendJSON(res, 200, await matchOne(cleanDetected(body.detected)));
}

async function handleIdentify(req, res) {
  const { img, mediaType } = parseImageBody(await readJSONBody(req));
  const t0 = Date.now();
  const { cards: detected, cardBack } = await identifyCards(img, mediaType);
  const cards = await mapLimit(detected, 3, matchOne);
  console.log(`identify: ${cards.length} card(s)${cardBack ? ' (card back)' : ''} in ${Date.now() - t0}ms`);
  sendJSON(res, 200, { cards, cardBack: cardBack && !cards.length });
}

async function handlePulse(url, res) {
  const g = (k) => str(url.searchParams.get(k));
  if (!g('name') && !g('number')) return sendJSON(res, 400, { error: 'Need a card name or number' });
  const setId = g('setId') || guessSetId(g('setCode'), g('setName'));
  const result = await safePulse({ name: g('name'), number: g('number'), total: g('total'), setId,
    setLabel: g('setName') || g('setCode') || setId, language: g('language') });
  sendJSON(res, 200, { pulse: result, creditsLeft: pulseCreditsLeft() });
}

async function handlePhoto(req, res) {
  const body = await readJSONBody(req);
  const { img } = parseImageBody(body);
  const name = str(body.name).replace(/[^\w.-]/g, '').slice(0, 80);
  const t0 = Date.now();
  const out = await uploadToImgbb(img, name);
  console.log(`photo: uploaded in ${Date.now() - t0}ms`);
  sendJSON(res, 200, out);
}

async function handleSearch(url, res) {
  const name = str(url.searchParams.get('name'));
  const number = normNumber(url.searchParams.get('number'));
  const set = str(url.searchParams.get('set'));
  const parts = [];
  const loose = (field, v) => (/^[\p{L}\p{N}']+$/u.test(v) ? `${field}:${v}*` : `${field}:${luceneQuote(v)}`);
  if (name) parts.push(loose('name', name));
  if (number) parts.push(`number:${luceneQuote(number)}`);
  if (set) parts.push(loose('set.name', set));
  if (!parts.length) return sendJSON(res, 400, { error: 'Enter a name, number or set' });
  const found = await ptcgSearch(parts.join(' '), 24);
  sendJSON(res, 200, { candidates: found.map(toCandidate) });
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') {
        return sendJSON(res, 200, {
          ok: true,
          claudeKeySet: !!ANTHROPIC_API_KEY,
          model: MODEL,
          passwordRequired: !!APP_PASSWORD,
          photoHostSet: !!IMGBB_KEY,
          pulseSet: !!PULSE_KEY,
          pulseCreditsLeft: PULSE_KEY ? pulseCreditsLeft() : 0,
          pulseDailyLimit: PULSE_DAILY_LIMIT,
        });
      }
      if (!authorised(req)) return sendJSON(res, 401, { error: 'Wrong or missing app password' });
      if (url.pathname === '/api/auth') return sendJSON(res, 200, { ok: true });
      if (url.pathname === '/api/identify' && req.method === 'POST') return await handleIdentify(req, res);
      if (url.pathname === '/api/search' && req.method === 'GET') return await handleSearch(url, res);
      if (url.pathname === '/api/photo' && req.method === 'POST') return await handlePhoto(req, res);
      if (url.pathname === '/api/pulse' && req.method === 'GET') return await handlePulse(url, res);
      if (url.pathname === '/api/match' && req.method === 'POST') return await handleMatch(req, res);
      return sendJSON(res, 404, { error: 'Not found' });
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) sendJSON(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`PokeLister running on port ${PORT} (model: ${MODEL})`);
    if (!ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY is not set');
    if (!APP_PASSWORD) console.warn('Warning: APP_PASSWORD is not set — anyone with the URL can use your API credit');
    if (!IMGBB_KEY) console.warn('Note: IMGBB_API_KEY is not set — your photos will not be added to listings');
    if (!PULSE_KEY) console.warn('Note: PULSE_API_KEY is not set — Pulse prices are off');
  });
}

module.exports = { server, normSetId, cardNumberVariants, isForeignPrinting, guessSetId, pickPulseResult, sameCardNumber, pulseName, normNumber, scoreCandidate, lookupCard, toCandidate, statusFor, cleanDetected, parseLooseJSON };
