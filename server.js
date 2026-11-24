'use strict';
// PokeLister — photograph Pokémon cards, identify them, export eBay draft listings.
// Zero dependencies. Needs Node 18+ (uses the built-in fetch).
//
// Environment variables:
//   ANTHROPIC_API_KEY   required — used to read the cards in your photos
//   APP_PASSWORD        recommended — stops anyone else using your API credit
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
If no card is visible, reply {"cards":[]}.`;

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
  return cards.map(cleanDetected).filter((c) => c.name || c.number);
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

async function ptcgSearch(q, pageSize = 15) {
  const url = `${PTCG_URL}?q=${encodeURIComponent(q)}&pageSize=${pageSize}&orderBy=-set.releaseDate`;
  const headers = PTCG_KEY ? { 'X-Api-Key': PTCG_KEY } : {};
  const { ok, status, data } = await fetchJSON(url, { headers }, 30000);
  if (!ok) throw new Error(`Card database error (HTTP ${status})`);
  return Array.isArray(data.data) ? data.data : [];
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

// ---------- routes ----------

async function handleIdentify(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJSON(res, 400, { error: e.message === 'Upload too large' ? e.message : 'Bad request' });
  }
  let img = String(body.image || '');
  let mediaType = 'image/jpeg';
  const m = img.match(/^data:(image\/[a-z+.-]+);base64,/i);
  if (m) {
    mediaType = m[1].toLowerCase();
    img = img.slice(m[0].length);
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) {
    return sendJSON(res, 400, { error: 'Unsupported image type' });
  }
  if (img.length < 100) return sendJSON(res, 400, { error: 'No image received' });

  const t0 = Date.now();
  const detected = await identifyCards(img, mediaType);
  const cards = await mapLimit(detected, 3, async (d) => {
    try {
      const candidates = await lookupCard(d);
      return { detected: d, candidates, status: statusFor(d, candidates) };
    } catch (e) {
      return { detected: d, candidates: [], status: 'nomatch', error: e.message };
    }
  });
  console.log(`identify: ${cards.length} card(s) in ${Date.now() - t0}ms`);
  sendJSON(res, 200, { cards });
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
        });
      }
      if (!authorised(req)) return sendJSON(res, 401, { error: 'Wrong or missing app password' });
      if (url.pathname === '/api/auth') return sendJSON(res, 200, { ok: true });
      if (url.pathname === '/api/identify' && req.method === 'POST') return await handleIdentify(req, res);
      if (url.pathname === '/api/search' && req.method === 'GET') return await handleSearch(url, res);
      return sendJSON(res, 404, { error: 'Not found' });
    }
    return serveStatic(url.pathname, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`PokeLister running on port ${PORT} (model: ${MODEL})`);
    if (!ANTHROPIC_API_KEY) console.warn('Warning: ANTHROPIC_API_KEY is not set');
    if (!APP_PASSWORD) console.warn('Warning: APP_PASSWORD is not set — anyone with the URL can use your API credit');
  });
}

module.exports = { server, normNumber, scoreCandidate, lookupCard, toCandidate, statusFor, cleanDetected, parseLooseJSON };
