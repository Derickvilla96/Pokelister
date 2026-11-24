'use strict';
// PokeLister frontend — vanilla JS, no build step.

(() => {
  const LS_ROWS = 'pokelister.rows.v1';
  const LS_SETTINGS = 'pokelister.settings.v1';
  const MAX_PARALLEL = 2;     // photos processed at once
  const MAX_EDGE = 1568;      // px sent to the AI and uploaded for the listing
  const JPEG_Q = 0.85;
  const THUMB_EDGE = 240;     // px kept on the phone for the list

  const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
  const FINISHES = [['normal', 'Normal'], ['holo', 'Holo'], ['reverse holo', 'Reverse Holo']];

  const DEFAULT_DESC = [
    '{name} {number} – {set}',
    '',
    'Rarity: {rarity}',
    'Finish: {finish}',
    'Language: {language}',
    'Condition: {condition}',
    '',
    'Please see photos for exact condition. Sent in a penny sleeve and toploader.',
  ].join('\n');

  const DEFAULT_SETTINGS = {
    password: '',
    categoryId: '183454',
    conditionId: '',
    skuPrefix: 'PKM',
    defaultQty: 1,
    defaultCondition: 'Near Mint',
    includeStockPhoto: false,
    autoPrice: true,
    priceSource: 'pulse',
    pulseDiscount: 10,
    eurToGbp: 0.85,
    priceMultiplier: 1,
    minPrice: 0.99,
    descTemplate: DEFAULT_DESC,
    pairsMode: true,
    exportMode: 'live',
    shippingPolicy: '',
    returnPolicy: '',
    paymentPolicy: '',
    postcode: '',
    location: '',
    bestOffer: false,
    specGame: 'Pokémon TCG',
    specManufacturer: 'The Pokémon Company',
  };

  // eBay card-condition codes for ungraded cards in CCG Individual Cards (183454)
  const CD_CONDITION = {
    'Near Mint': '400010',          // Near Mint or Better
    'Lightly Played': '400015',     // Lightly Played (Excellent)
    'Moderately Played': '400016',  // Moderately Played (Very Good)
    'Heavily Played': '400017',     // Heavily Played (Poor)
    'Damaged': '400017',
  };

  // Item specifics sent as C: columns. "need" = counted as missing when blank.
  const SPECIFICS = [
    { key: 'Game', need: true },
    { key: 'Card Name', need: true },
    { key: 'Character', need: false },
    { key: 'Card Type', need: true },
    { key: 'Set', need: true },
    { key: 'Card Number', need: true },
    { key: 'Rarity', need: true },
    { key: 'Finish', need: true },
    { key: 'Language', need: true },
    { key: 'Manufacturer', need: true },
    { key: 'Year Manufactured', need: false },
    { key: 'Features', need: false },
    { key: 'Graded', need: true },
  ];

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- storage ----------

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function store(key, value) {
    try {
      // keys starting with _ are temporary UI state and are not saved
      localStorage.setItem(key, JSON.stringify(value, (k, v) => (k.startsWith('_') ? undefined : v)));
      return true;
    } catch (e) {
      toast('Phone storage is full — export and clear some cards');
      return false;
    }
  }

  let settings = { ...DEFAULT_SETTINGS, ...load(LS_SETTINGS, {}) };
  let rows = load(LS_ROWS, []);
  let onlyCheck = false;
  let photoHost = true;          // updated from /api/health
  let pulseOn = true;            // updated from /api/health
  let nextRole = 'front';        // in front & back mode: what the next photo is
  let lastFrontJobId = null;
  let jobSeq = 0;
  let running = 0;
  let saveTimer = null;
  let rowPhotoTarget = null;     // { rowId, side } for the Add back / Replace front buttons
  const jobs = [];
  const backs = new Map();       // front job id -> { url, thumb, error }
  const searchResults = new Map(); // row id -> candidates from manual search

  function saveRows() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushRows, 250);
  }
  function flushRows() {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    store(LS_ROWS, rows);
  }
  // save straight away if the app is closed or switched away from
  window.addEventListener('pagehide', flushRows);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushRows(); });

  // ---------- API ----------

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.password) headers['X-App-Key'] = settings.password;
    let r;
    try {
      r = await fetch(path, { ...opts, headers });
    } catch (e) {
      throw new Error('Could not reach the server — check your connection');
    }
    let data = {};
    try { data = await r.json(); } catch (e) { /* ignore */ }
    if (r.status === 401) throw new Error('Wrong app password — check Settings');
    if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
    return data;
  }

  async function uploadPhoto(dataUrl, name) {
    const data = await api('/api/photo', { method: 'POST', body: JSON.stringify({ image: dataUrl, name }) });
    if (!data.url) throw new Error('Photo upload failed');
    return data.url;
  }

  // ---------- images ----------

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read this image'));
      img.src = src;
    });
  }

  function drawScaled(img, maxEdge, quality) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const s = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  }

  async function prepareFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      return { full: drawScaled(img, MAX_EDGE, JPEG_Q), thumb: drawScaled(img, THUMB_EDGE, 0.6) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- photo queue ----------

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const f of files) {
      const job = { id: uid(), seq: ++jobSeq, file: f, status: 'queued', thumb: '', error: '', count: 0, role: 'front' };
      if (settings.pairsMode) {
        job.role = nextRole;
        if (job.role === 'back') {
          job.pairedWith = lastFrontJobId;
          if (!job.pairedWith) job.role = 'front'; // nothing to pair with
        }
        if (job.role === 'front') lastFrontJobId = job.id;
        nextRole = job.role === 'front' ? 'back' : 'front';
      } else {
        lastFrontJobId = job.id;
      }
      jobs.push(job);
    }
    renderJobs();
    renderNextHint();
    pump();
  }

  function pump() {
    while (running < MAX_PARALLEL) {
      const job = jobs.find((j) => j.status === 'queued');
      if (!job) break;
      running++;
      const work = job.role === 'back' ? runBackJob(job) : runFrontJob(job);
      work.finally(() => { running--; renderJobs(); pump(); });
    }
  }

  function finishJob(job, count) {
    job.status = 'done';
    job.count = count;
    job.prepared = null;
    job.file = null;
    setTimeout(() => {
      const i = jobs.indexOf(job);
      if (i >= 0) jobs.splice(i, 1);
      renderJobs();
    }, 4000);
  }

  async function runFrontJob(job) {
    job.status = 'working';
    renderJobs();
    let upload = Promise.resolve();
    try {
      if (!job.prepared) {
        job.prepared = await prepareFile(job.file);
        job.thumb = job.prepared.thumb;
        renderJobs();
      }
      // upload the photo while the AI reads it
      if (photoHost && !job.frontUrl) {
        job.uploadError = '';
        upload = uploadPhoto(job.prepared.full, `front-${job.id}`)
          .then((u) => { job.frontUrl = u; })
          .catch((e) => { job.uploadError = e.message; });
      }
      const data = await api('/api/identify', { method: 'POST', body: JSON.stringify({ image: job.prepared.full }) });
      const cards = data.cards || [];

      if (!cards.length && data.cardBack) {
        // A card back taken outside front & back mode: attach it to the previous photo.
        const prev = jobs.filter((j) => j.role === 'front' && j.seq < job.seq && j.id !== job.id).pop();
        const prevRows = prev ? rows.filter((r) => r.jobId === prev.id) : [];
        const target = prev && (prevRows.length || prev.status !== 'error') ? prev.id : (rows[0] && rows[0].jobId);
        if (!target) throw new Error('That was a card back — scan the front first');
        await upload;
        job.role = 'back';
        job.pairedWith = target;
        setBack(target, { url: job.frontUrl || '', thumb: job.thumb, error: job.uploadError });
        finishJob(job, 0);
        toast('Card back added to the previous card');
        return;
      }
      if (!cards.length) throw new Error('No card found in this photo');

      await upload;
      const back = backs.get(job.id);
      const newRows = cards.map((c) => makeRow(c, job, back));
      rows = [...newRows, ...rows];
      finishJob(job, cards.length);
      saveRows();
      renderList();
      if (job.uploadError) toast('Card found, but the photo upload failed — use Replace front');
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      toast(e.message);
    }
  }

  async function runBackJob(job) {
    job.status = 'working';
    renderJobs();
    try {
      if (!job.prepared) {
        job.prepared = await prepareFile(job.file);
        job.thumb = job.prepared.thumb;
        renderJobs();
      }
      let url = '';
      if (photoHost) url = await uploadPhoto(job.prepared.full, `back-${job.id}`);
      setBack(job.pairedWith, { url, thumb: job.thumb, error: '' });
      finishJob(job, 0);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      toast('Back photo: ' + e.message);
    }
  }

  // Store a back photo for a front job and apply it to any rows already made from that photo.
  function setBack(frontJobId, back) {
    backs.set(frontJobId, back);
    let changed = false;
    for (const r of rows) {
      if (r.jobId !== frontJobId) continue;
      r.backPhoto = back.thumb;
      r.backUrl = back.url;
      changed = true;
      rerenderRow(r);
    }
    if (changed) saveRows();
  }

  function renderJobs() {
    const el = $('#jobs');
    el.hidden = !jobs.length;
    el.innerHTML = jobs.map((j) => {
      const label = j.status === 'queued' ? 'Waiting'
        : j.status === 'working' ? (j.role === 'back' ? 'Uploading…' : 'Reading…')
        : j.status === 'done' ? (j.role === 'back' ? '✓ Back added' : `✓ ${j.count} card${j.count === 1 ? '' : 's'}`)
        : 'Tap to retry';
      return `<div class="job ${j.status}" data-job="${j.id}" title="${esc(j.error)}">
        ${j.thumb ? `<img src="${j.thumb}" alt="">` : ''}
        <span class="job-role">${j.role === 'back' ? 'BACK' : 'FRONT'}</span>
        ${j.status === 'error' ? `<button class="job-x" data-x="${j.id}" aria-label="Dismiss">✕</button>` : ''}
        <span class="job-status">${label}</span></div>`;
    }).join('');
  }

  function renderNextHint() {
    const el = $('#nextHint');
    if (!settings.pairsMode) { el.innerHTML = ''; return; }
    el.innerHTML = nextRole === 'back'
      ? '<span>Next photo: <strong>BACK</strong> of the last card</span><button class="btn small" id="skipBack">Skip back</button>'
      : '<span>Next photo: <strong>FRONT</strong> of a card. Library: pick front, back, front, back…</span>';
  }

  // ---------- rows ----------

  function normNumber(n) {
    const s = String(n || '').replace(/\s+/g, '').toUpperCase();
    return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
  }

  function chosen(r) {
    return r.chosen >= 0 ? r.candidates[r.chosen] : null;
  }

  function makeRow(result, job, back) {
    const d = result.detected || {};
    const candidates = result.candidates || [];
    const row = {
      id: uid(),
      jobId: job.id,
      photo: job.thumb,
      frontUrl: job.frontUrl || '',
      backPhoto: back ? back.thumb : '',
      backUrl: back ? back.url : '',
      detected: d,
      candidates,
      chosen: candidates.length ? 0 : -1,
      status: result.status || 'check',
      finish: d.finish,
      firstEd: !!d.first_edition,
      condition: settings.defaultCondition,
      qty: settings.defaultQty || 1,
      price: '',
      priceAuto: true,
      pulse: result.pulse || null,
      pulseManual: '',
      dbError: result.error || '',
      title: '',
      titleEdited: false,
      createdAt: Date.now(),
    };
    if (!['normal', 'holo', 'reverse holo'].includes(row.finish)) {
      const rarity = ((chosen(row) || {}).rarity || d.rarity || '').toLowerCase();
      row.finish = rarity.includes('holo') ? 'holo' : 'normal';
      if (row.status === 'ok') row.status = 'check'; // AI wasn't sure of the finish
    }
    applyAutoPrice(row);
    row.title = buildTitle(row);
    return row;
  }

  // Card details, preferring the database match but keeping the number as printed (e.g. 025/198).
  function cardInfo(r) {
    const d = r.detected || {};
    const c = chosen(r);
    const language = d.language || 'English';
    if (c) {
      const printedNum = d.number && normNumber(d.number) === normNumber(c.number) ? d.number : c.number;
      const total = /^\d+$/.test(d.set_total || '') && Number(d.set_total) === Number(c.printedTotal)
        ? d.set_total : String(c.printedTotal || '');
      const hasLetters = /[A-Z]/i.test(c.number);
      const number = hasLetters || !total ? printedNum : `${printedNum}/${total}`;
      return { name: c.name, number, set: c.setName, rarity: c.rarity, language, id: c.id };
    }
    const number = d.number ? (d.set_total ? `${d.number}/${d.set_total}` : d.number) : '';
    return { name: d.name || '', number, set: d.set_name || '', rarity: d.rarity || '', language, id: '' };
  }

  function finishLabel(f) {
    return f === 'holo' ? 'Holo' : f === 'reverse holo' ? 'Reverse Holo' : '';
  }

  function buildTitle(r) {
    const i = cardInfo(r);
    const rarity = i.rarity || '';
    const extras = [];
    if (i.set) extras.push(i.set);
    if (r.firstEd) extras.push('1st Edition');
    const fl = finishLabel(r.finish);
    if (fl && !(r.finish === 'holo' && /holo/i.test(rarity))) extras.push(fl);
    if (i.language && !/^english$/i.test(i.language)) extras.push(i.language);
    if (rarity && !/^(common|uncommon)$/i.test(rarity)) extras.push(rarity);
    extras.push('Pokemon Card');
    let t = [i.name, i.number].filter(Boolean).join(' ');
    for (const e of extras) if ((t + ' ' + e).length <= 80) t += ' ' + e;
    return t.slice(0, 80);
  }

  const usePulse = () => settings.priceSource !== 'cardmarket';
  const round2 = (n) => Math.round(n * 100) / 100;

  // The price the rule gives, or null if there's nothing to base it on.
  function suggestedPrice(r) {
    const min = Number(settings.minPrice || 0);
    if (usePulse()) {
      const manual = parseFloat(String(r.pulseManual || '').replace(',', '.'));
      const hasManual = isFinite(manual) && manual > 0;
      const fetched = r.pulse && r.pulse.status === 'ok' ? r.pulse.gbp : null;
      const base = hasManual ? manual : fetched;
      if (base == null) return null;
      const discounted = round2(base * (1 - Number(settings.pulseDiscount || 0) / 100));
      return { source: 'pulse', base, manual: hasManual, discounted, raisedToMin: discounted < min, gbp: Math.max(min, discounted) };
    }
    const c = chosen(r);
    if (!c) return null;
    const eur = r.finish === 'reverse holo' && c.cmReverseHoloTrend ? c.cmReverseHoloTrend : c.cmTrend;
    if (!eur) return null;
    const gbp = round2(eur * Number(settings.eurToGbp || 0.85) * Number(settings.priceMultiplier || 1));
    return { source: 'cardmarket', eur, raisedToMin: gbp < min, gbp: Math.max(min, gbp) };
  }

  function ruleSummary() {
    if (!settings.autoPrice) return 'Auto-pricing is <strong>off</strong>: you type every price yourself.';
    const min = Number(settings.minPrice || 0);
    const minText = min > 0 ? `, never below £${min.toFixed(2)}` : '';
    return usePulse()
      ? `Your pricing rule: <strong>Pulse price − ${Number(settings.pulseDiscount || 0)}%</strong>${minText}.`
      : `Your pricing rule: <strong>Cardmarket trend × ${settings.eurToGbp} × ${settings.priceMultiplier}</strong>${minText}.`;
  }

  // The reminder shown on each card, e.g. "Pulse £4.70 − 10% = £4.23"
  function ruleText(r) {
    const sp = suggestedPrice(r);
    if (!sp) return '';
    const minNote = sp.raisedToMin ? ` → raised to your £${Number(settings.minPrice).toFixed(2)} minimum` : '';
    if (sp.source === 'pulse') {
      return `Rule (set in Settings): ${sp.manual ? 'your Pulse price' : 'Pulse'} £${sp.base.toFixed(2)} − ${Number(settings.pulseDiscount || 0)}% = <strong>£${sp.discounted.toFixed(2)}</strong>${minNote}`;
    }
    return `Rule (set in Settings): Cardmarket €${sp.eur.toFixed(2)} → <strong>£${sp.gbp.toFixed(2)}</strong>${minNote}`;
  }

  function pulseStatusText(r) {
    const p = r.pulse;
    if (r.pulseManual && parseFloat(r.pulseManual) > 0) return { text: 'Using the Pulse price you typed in.', bad: false };
    if (!pulseOn) return { text: 'Pulse isn\'t set up (add PULSE_API_KEY on Render). Type the Pulse price in.', bad: true };
    if (!p) return { text: 'No Pulse price yet.', bad: true, fetch: true };
    if (p.status === 'pending') return { text: 'Checking Pulse…', bad: false };
    if (p.status === 'ok') {
      const parts = [];
      if (typeof p.market === 'number') parts.push(`market price £${p.market.toFixed(2)}`);
      if (typeof p.cmNm === 'number') parts.push(`Cardmarket NM £${p.cmNm.toFixed(2)}`);
      const using = p.basis && p.basis.startsWith('Cardmarket') ? ' (using Cardmarket NM, no market price)' : '';
      return { text: `From PulseTCG: ${parts.join(' · ') || p.basis}${using}.`, bad: false, recheck: true };
    }
    if (p.status === 'nomatch') {
      let why = '';
      if (p.tried && p.tried.length) {
        const looked = p.tried.map((t) => `"${t.search}" (${t.results} result${t.results === 1 ? '' : 's'}${t.sample && t.sample.length ? ': ' + t.sample.join(', ') : ''})`).join('; ');
        const wanted = [p.wanted && p.wanted.number, p.wanted && p.wanted.set].filter(Boolean).join(', ');
        why = ` Searched ${looked}${wanted ? `; needed ${wanted}` : ''}.`;
      }
      return { text: `Pulse couldn't confirm this card, so it didn't guess a price.${why} Type its price from the PulseTCG app, or fix the match and tap Check Pulse.`, bad: true, fetch: true };
    }
    if (p.status === 'limit') return { text: p.error || 'Daily Pulse limit reached. Type the price in.', bad: true };
    return { text: 'Pulse lookup failed' + (p.error ? `: ${p.error}` : '') + '.', bad: true, fetch: true };
  }

  async function fetchPulse(r) {
    if (!usePulse() || !pulseOn) return;
    const c = chosen(r);
    const d = r.detected || {};
    const q = c
      ? { name: c.name, number: d.number && normNumber(d.number) === normNumber(c.number) ? d.number : c.number,
          total: String(c.printedTotal || ''), setId: c.setId || '' }
      : { name: d.name || '', number: d.number || '', total: d.set_total || '', setId: '',
          setCode: d.set_code || '', setName: d.set_name || '' };
    r.pulse = { status: 'pending' };
    rerenderRow(r);
    try {
      const data = await api('/api/pulse?' + new URLSearchParams(q).toString());
      r.pulse = data.pulse || { status: 'error' };
    } catch (e) {
      r.pulse = { status: 'error', error: e.message };
    }
    refreshDerived(r);
    rerenderRow(r);
    saveRows();
  }

  function applyAutoPrice(r, force) {
    if (!settings.autoPrice) return;
    if (!force && !r.priceAuto) return;
    const s = suggestedPrice(r);
    r.price = s ? s.gbp.toFixed(2) : '';
    r.priceAuto = true;
  }

  function refreshDerived(r) {
    applyAutoPrice(r);
    if (!r.titleEdited) r.title = buildTitle(r);
  }

  // ---------- item specifics ----------

  // "Team Rocket's Mewtwo ex" -> "Mewtwo", "Radiant Charizard" -> "Charizard"
  function characterName(name) {
    let s = String(name || '').trim();
    s = s.replace(/^.+?'s\s+/, '');
    s = s.replace(/^(Radiant|Shining|Dark|Light|Alolan|Galarian|Hisuian|Paldean|Mega|M)\s+/i, '');
    const suffix = /[\s-]+(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|Prime|LEGEND|Star|δ|☆|TAG TEAM|◇)$/;
    while (suffix.test(s)) s = s.replace(suffix, '');
    return s.trim();
  }

  function autoSpecifics(r) {
    const i = cardInfo(r);
    const c = chosen(r);
    const supertype = (c && c.supertype) || '';
    const cardType = /pok/i.test(supertype) ? 'Pokémon' : supertype;
    const finish = r.finish === 'holo' ? 'Holo' : r.finish === 'reverse holo' ? 'Reverse Holo' : 'Non-Holo';
    const year = c && c.releaseDate ? String(c.releaseDate).slice(0, 4) : '';
    return {
      'Game': settings.specGame || 'Pokémon TCG',
      'Card Name': i.name || '',
      'Character': cardType === 'Pokémon' || (!supertype && i.name) ? characterName(i.name) : '',
      'Card Type': cardType,
      'Set': i.set || '',
      'Card Number': i.number || '',
      'Rarity': i.rarity || '',
      'Finish': finish,
      'Language': i.language || 'English',
      'Manufacturer': settings.specManufacturer || '',
      'Year Manufactured': year,
      'Features': r.firstEd ? '1st Edition' : '',
      'Graded': 'No',
    };
  }

  // Your edits win; anything you haven't touched follows the card match.
  function getSpecifics(r) {
    const auto = autoSpecifics(r);
    const own = r.specifics || {};
    const out = {};
    for (const { key } of SPECIFICS) out[key] = key in own ? own[key] : auto[key];
    return out;
  }

  function parseExtraSpecifics(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      // split on the last ": " so names like "Attribute/MTG:Colour: Colorless" work;
      // fall back to the first ":" for lines typed without a space
      const m = line.match(/^\s*(.+):\s+(.+?)\s*$/) || line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (m && m[1].trim()) out[m[1].trim()] = m[2];
    }
    return out;
  }

  function missingSpecifics(r) {
    const s = getSpecifics(r);
    return SPECIFICS.filter((x) => x.need && !String(s[x.key] || '').trim()).map((x) => x.key);
  }

  // ---------- export ----------

  function skuFor(r) {
    const i = cardInfo(r);
    const base = (i.id || 'X').replace(/[^A-Za-z0-9-]/g, '');
    return `${settings.skuPrefix || 'PKM'}-${base}-${r.id.slice(-4).toUpperCase()}`;
  }

  function exportPrefix() {
    return settings.exportMode === 'drafts' ? 'ebay-drafts' : 'ebay-listings';
  }

  function buildDescription(r) {
    const i = cardInfo(r);
    const map = {
      name: i.name, number: i.number, set: i.set, rarity: i.rarity || '',
      finish: finishLabel(r.finish) || 'Normal', condition: r.condition, language: i.language,
      edition: r.firstEd ? '1st Edition' : 'Unlimited',
    };
    return String(settings.descTemplate || '')
      .replace(/\{(\w+)\}/g, (m, k) => (k in map ? esc(map[k]) : m))
      .replace(/\r?\n/g, '<br>');
  }

  function photoUrls(r) {
    const c = chosen(r);
    const urls = [r.frontUrl, r.backUrl];
    if (settings.includeStockPhoto && c && c.imageLarge) urls.push(c.imageLarge);
    return urls.filter(Boolean).slice(0, 12);
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function priceStr(p) {
    const n = parseFloat(String(p).replace(',', '.'));
    return isFinite(n) && n > 0 ? n.toFixed(2) : '';
  }

  const ACTION_HEADER = 'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8)';

  // Item specific column names: the standard ones plus any extras typed on any card.
  function specificColumns(list) {
    const names = SPECIFICS.map((x) => x.key);
    for (const r of list) {
      for (const k of Object.keys(parseExtraSpecifics(r.extraSpecifics))) {
        if (!names.some((n) => n.toLowerCase() === k.toLowerCase())) names.push(k);
      }
    }
    return names;
  }

  function specificValues(r, names) {
    const s = { ...getSpecifics(r) };
    const extra = parseExtraSpecifics(r.extraSpecifics);
    for (const [k, v] of Object.entries(extra)) {
      const match = names.find((n) => n.toLowerCase() === k.toLowerCase());
      if (match) s[match] = v;
    }
    return names.map((n) => s[n] || '');
  }

  function infoLine(text, columns) {
    return text + ','.repeat(Math.max(0, columns - 1));
  }

  function buildDraftCSV(list) {
    const specNames = specificColumns(list);
    const header = [
      ACTION_HEADER, 'Custom label (SKU)', 'Category ID', 'Title', 'UPC', 'Price', 'Quantity',
      'Item photo URL', 'Condition ID', 'Description', 'Format',
      ...specNames.map((n) => 'C:' + n),
    ];
    const lines = [
      infoLine('#INFO,Version=0.0.2,Template= eBay-draft-listings-template_GB', header.length - 1),
      header.map(csvCell).join(','),
    ];
    for (const r of list) {
      lines.push([
        'Draft', skuFor(r), settings.categoryId, r.title, '', priceStr(r.price),
        parseInt(r.qty, 10) || 1, photoUrls(r).join('|'), settings.conditionId, buildDescription(r), 'FixedPrice',
        ...specificValues(r, specNames),
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function buildLiveCSV(list) {
    const specNames = specificColumns(list);
    const header = [
      ACTION_HEADER, 'CustomLabel', 'Category', 'Title', 'ConditionID', 'CD:Card Condition - (ID: 40001)',
      ...specNames.map((n) => 'C:' + n),
      'PicURL', 'Description', 'Format', 'Duration', 'StartPrice', 'BestOfferEnabled', 'Quantity',
      'Location', 'PostalCode', 'ShippingProfileName', 'ReturnProfileName', 'PaymentProfileName',
    ];
    const lines = [
      infoLine('#INFO,Version=1.0.0,Template=fx_category_template_EBAY_GB', header.length - 1),
      header.map(csvCell).join(','),
    ];
    for (const r of list) {
      lines.push([
        'Add', skuFor(r), settings.categoryId, r.title, '4000', CD_CONDITION[r.condition] || '400010',
        ...specificValues(r, specNames),
        photoUrls(r).join('|'), buildDescription(r), 'FixedPrice', 'GTC', priceStr(r.price),
        settings.bestOffer ? '1' : '0', parseInt(r.qty, 10) || 1,
        settings.location || settings.postcode, settings.postcode,
        settings.shippingPolicy, settings.returnPolicy, settings.paymentPolicy,
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function buildCSV(list) {
    return settings.exportMode === 'drafts' ? buildDraftCSV(list) : buildLiveCSV(list);
  }

  function exportName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${exportPrefix()}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
  }

  function readyToExport() {
    if (!rows.length) { toast('No cards to export'); return false; }
    const live = settings.exportMode !== 'drafts';
    if (live) {
      const missingSettings = [];
      if (!String(settings.shippingPolicy).trim()) missingSettings.push('postage policy name');
      if (!String(settings.returnPolicy).trim()) missingSettings.push('returns policy name');
      if (!String(settings.postcode).trim()) missingSettings.push('postcode');
      if (missingSettings.length) {
        alert(`For live listings, add your ${missingSettings.join(', ')} in Settings first.`);
        openSettings();
        return false;
      }
      const noPriceLive = rows.filter((r) => !priceStr(r.price)).length;
      if (noPriceLive) {
        alert(`${noPriceLive} card${noPriceLive === 1 ? ' has' : 's have'} no price. Live listings need a price.`);
        return false;
      }
    }
    const noSpecs = rows.filter((r) => missingSpecifics(r).length).length;
    const busy = jobs.filter((j) => j.status === 'queued' || j.status === 'working').length
      + rows.filter((r) => r._uploading).length;
    const noPrice = rows.filter((r) => !priceStr(r.price)).length;
    const toCheck = rows.filter((r) => r.status !== 'ok').length;
    const noPhotos = photoHost ? rows.filter((r) => !r.frontUrl).length : 0;
    const noBack = photoHost && settings.pairsMode ? rows.filter((r) => !r.backUrl).length : 0;
    const issues = [];
    if (busy) issues.push(`${busy} photo${busy === 1 ? ' is' : 's are'} still processing`);
    if (noPrice) issues.push(`${noPrice} without a price`);
    if (toCheck) issues.push(`${toCheck} still marked to check`);
    if (noPhotos) issues.push(`${noPhotos} without an uploaded front photo`);
    if (noBack) issues.push(`${noBack} without a back photo`);
    if (noSpecs) issues.push(`${noSpecs} with item specifics missing`);
    if (issues.length && !confirm(`${issues.join(', ')}. Export anyway?`)) return false;
    if (live && !confirm(`Export ${rows.length} LIVE listing${rows.length === 1 ? '' : 's'}? They go live as soon as you upload the file to eBay.`)) return false;
    return true;
  }

  function downloadCSV() {
    if (!readyToExport()) return;
    const blob = new Blob([buildCSV(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Exported ${rows.length} card${rows.length === 1 ? '' : 's'}`);
  }

  async function shareCSV() {
    if (!readyToExport()) return;
    const file = new File([buildCSV(rows)], exportName(), { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'eBay drafts' });
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message);
      }
    } else {
      toast('Sharing files is not supported here — use Download');
    }
  }

  // ---------- per-card photo buttons ----------

  async function handleRowPhoto(file) {
    const target = rowPhotoTarget;
    rowPhotoTarget = null;
    const r = target && rows.find((x) => x.id === target.rowId);
    if (!r || !file) return;
    r._uploading = target.side;
    rerenderRow(r);
    try {
      const p = await prepareFile(file);
      let url = '';
      if (photoHost) url = await uploadPhoto(p.full, `${target.side}-${r.id}`);
      if (target.side === 'back') { r.backPhoto = p.thumb; r.backUrl = url; }
      else { r.photo = p.thumb; r.frontUrl = url; }
      toast(target.side === 'back' ? 'Back photo added' : 'Front photo replaced');
    } catch (e) {
      toast(e.message);
    } finally {
      r._uploading = null;
      rerenderRow(r);
      saveRows();
    }
  }

  // ---------- rendering ----------

  function candidateLabel(x) {
    const num = x.printedTotal && !/[A-Z]/i.test(x.number) ? `${x.number}/${x.printedTotal}` : x.number;
    return `${x.name} ${num} · ${x.setName}${x.rarity ? ' · ' + x.rarity : ''}`;
  }

  function photoStatusHtml(r) {
    if (!photoHost) return '';
    const f = r.frontUrl ? '<span class="ok">front ✓</span>' : '<span class="bad">front not uploaded</span>';
    const b = r.backUrl ? '<span class="ok">back ✓</span>' : '<span class="bad">no back</span>';
    const busy = r._uploading ? ` · uploading ${r._uploading}…` : '';
    return `<p class="photo-status">Listing photos: ${f} · ${b}${busy}</p>`;
  }

  function specCountHtml(r) {
    const missing = missingSpecifics(r);
    return missing.length
      ? `<span class="spec-count warn">${missing.length} missing</span>`
      : '<span class="spec-count ok">✓ complete</span>';
  }

  function specsHtml(r) {
    const s = getSpecifics(r);
    const fields = SPECIFICS.map(({ key, need }) => {
      const v = s[key] || '';
      const wide = ['Card Name', 'Set', 'Game', 'Rarity', 'Manufacturer'].includes(key);
      return `<label class="field${need && !v.trim() ? ' missing' : ''}${wide ? ' wide' : ''}"><span>${esc(key)}</span>
        <input data-spec="${esc(key)}" value="${esc(v)}" placeholder="${need ? 'needed' : 'optional'}"></label>`;
    }).join('');
    const edited = r.specifics && Object.keys(r.specifics).length;
    return `<details class="specs"${r._specOpen ? ' open' : ''}>
      <summary><span>Item specifics</span>${specCountHtml(r)}</summary>
      <div class="spec-grid">${fields}
        <label class="field wide"><span>Extra specifics (one per line, Name: Value)</span>
          <textarea data-f="extraSpecifics" rows="2" placeholder="Attribute/MTG:Colour: Colorless">${esc(r.extraSpecifics || '')}</textarea></label>
      </div>
      ${edited ? '<div class="spec-actions"><button class="btn small" data-a="resetSpecs">Undo my edits</button></div>' : ''}
    </details>`;
  }

  function rowEl(r) {
    const c = chosen(r);
    const i = cardInfo(r);
    const sp = suggestedPrice(r);
    const el = document.createElement('article');
    el.className = 'card-row' + (r.status === 'ok' ? '' : ' needs-check');
    el.dataset.id = r.id;
    el.hidden = onlyCheck && r.status === 'ok';

    const options = r.candidates.map((x, idx) =>
      `<option value="${idx}"${idx === r.chosen ? ' selected' : ''}>${esc(candidateLabel(x))}</option>`).join('');
    const condOpts = CONDITIONS.map((x) => `<option${x === r.condition ? ' selected' : ''}>${esc(x)}</option>`).join('');
    const finishOpts = FINISHES.map(([v, l]) => `<option value="${v}"${v === r.finish ? ' selected' : ''}>${l}</option>`).join('');
    const badge = r.status === 'ok' ? '<span class="badge ok">✓ OK</span>'
      : `<span class="badge warn">${r.status === 'nomatch' ? 'No match' : 'Check'}</span>`;
    let priceHint;
    if (usePulse()) {
      const st = pulseStatusText(r);
      const showUse = sp && priceStr(r.price) !== sp.gbp.toFixed(2);
      priceHint = `<div class="pulse-box">
          <div class="rule-text">${sp ? ruleText(r) : ruleSummary()}</div>
          <div class="pulse-row">
            <label class="field"><span>Pulse price £ (type to override)</span>
              <input data-f="pulseManual" inputmode="decimal" value="${esc(r.pulseManual || '')}"
                placeholder="${r.pulse && r.pulse.status === 'ok' ? esc(r.pulse.gbp.toFixed(2)) : 'from PulseTCG app'}"></label>
            ${showUse ? '<button class="btn small" data-a="usePrice">Apply rule</button>' : ''}
            ${(st.fetch || st.recheck) && pulseOn ? `<button class="btn small" data-a="getPulse">${st.recheck ? 'Recheck' : 'Check Pulse'}</button>` : ''}
          </div>
          <div class="pulse-status${st.bad ? ' bad' : ''}">${esc(st.text)}</div>
        </div>`;
    } else {
      priceHint = sp
        ? `<div class="price-hint">${ruleText(r)} <button class="btn small" data-a="usePrice">Use</button></div>`
        : (c ? '<div class="price-hint">No Cardmarket price for this card</div>' : '');
    }
    let notes = r.detected && r.detected.notes ? `<p class="notes">AI note: ${esc(r.detected.notes)}</p>` : '';
    if (r.chosen === -1) {
      const why = r.dbError
        ? `The card database didn't answer (${esc(r.dbError)}).`
        : 'The card database found nothing for what the AI read.';
      notes += `<p class="notes">${why} Tap <strong>Retry match</strong>, or <strong>Search</strong> to pick the card yourself.</p>`;
    }
    const results = searchResults.get(r.id) || [];
    const busy = !!r._uploading;

    el.innerHTML = `
      <div class="row-imgs">
        <div class="photo-pair">
          <figure>${r.photo ? `<img src="${r.photo}" alt="Front">` : '<div class="missing">No front</div>'}<figcaption>Front</figcaption></figure>
          <figure>${r.backPhoto ? `<img src="${r.backPhoto}" alt="Back"><figcaption>Back</figcaption>` : '<div class="missing">No back</div>'}</figure>
        </div>
        ${c && c.image ? `<img class="stock" src="${esc(c.image)}" alt="Matched card" loading="lazy">`
          : '<div class="empty-img">No match</div>'}
      </div>
      <div class="row-body">
        <div class="row-head">
          <div class="row-name">${esc(i.name || 'Unknown card')} <span class="muted">${esc(i.number)}</span></div>
          ${badge}
        </div>
        <label class="field"><span>Match</span>
          <select data-f="chosen">${options}<option value="-1"${r.chosen === -1 ? ' selected' : ''}>None – use what the AI read</option></select>
        </label>
        <label class="field"><span>Title <em class="count">${r.title.length}/80</em></span>
          <textarea data-f="title" maxlength="80" rows="3">${esc(r.title)}</textarea>
        </label>
        <div class="field-row">
          <label class="field"><span>Price £</span>
            <input data-f="price" inputmode="decimal" value="${esc(r.price)}" placeholder="0.00"></label>
          <label class="field qty"><span>Qty</span>
            <input data-f="qty" inputmode="numeric" value="${esc(r.qty)}"></label>
        </div>
        ${priceHint}
        <div class="field-row">
          <label class="field"><span>Condition</span><select data-f="condition">${condOpts}</select></label>
          <label class="field"><span>Finish</span><select data-f="finish">${finishOpts}</select></label>
        </div>
        <label class="check"><input type="checkbox" data-f="firstEd"${r.firstEd ? ' checked' : ''}> 1st Edition</label>
        ${notes}
        ${specsHtml(r)}
        ${photoStatusHtml(r)}
        <div class="row-actions">
          <button class="btn small" data-a="addBack"${busy ? ' disabled' : ''}>${r.backPhoto ? 'Replace back' : 'Add back'}</button>
          <button class="btn small" data-a="replaceFront"${busy ? ' disabled' : ''}>Replace front</button>
          ${r.chosen === -1 ? `<button class="btn small" data-a="retryMatch"${r._matching ? ' disabled' : ''}>${r._matching ? 'Retrying…' : 'Retry match'}</button>` : ''}
          <button class="btn small" data-a="search">Search</button>
          ${r.titleEdited ? '<button class="btn small" data-a="retitle">Reset title</button>' : ''}
          ${r.status !== 'ok' ? '<button class="btn small" data-a="ok">Mark OK</button>' : ''}
          <button class="btn small danger" data-a="remove">Remove</button>
        </div>
        <div class="search-box"${results.length || r._searchOpen ? '' : ' hidden'}>
          <div class="field-row">
            <input class="s-name" placeholder="Name" value="${esc(i.name)}">
            <input class="s-number" placeholder="No." value="${esc(normNumber((r.detected || {}).number))}" style="flex:0 0 80px">
          </div>
          <input class="s-set" placeholder="Set (optional)">
          <button class="btn small primary" data-a="doSearch">Find</button>
          <div class="s-results">${results.map((x, idx) => `
            <button class="s-result" data-a="pick" data-idx="${idx}">
              ${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy">` : ''}
              ${esc(candidateLabel(x))}
            </button>`).join('')}</div>
        </div>
      </div>`;
    return el;
  }

  function renderList() {
    const list = $('#list');
    list.innerHTML = '';
    for (const r of rows) list.appendChild(rowEl(r));
    renderSummary();
  }

  function rerenderRow(r) {
    const old = document.querySelector(`.card-row[data-id="${r.id}"]`);
    if (old) old.replaceWith(rowEl(r));
    renderSummary();
  }

  function renderSummary() {
    const el = $('#summary');
    $('#empty').hidden = rows.length > 0;
    el.hidden = !rows.length;
    if (!rows.length) return;
    const qty = rows.reduce((n, r) => n + (parseInt(r.qty, 10) || 1), 0);
    const toCheck = rows.filter((r) => r.status !== 'ok').length;
    const noPrice = rows.filter((r) => !priceStr(r.price)).length;
    const noBack = rows.filter((r) => !r.backPhoto).length;
    const noSpecs = rows.filter((r) => missingSpecifics(r).length).length;
    const total = rows.reduce((s, r) => s + (parseFloat(priceStr(r.price)) || 0) * (parseInt(r.qty, 10) || 1), 0);
    el.innerHTML = `
      <span><strong>${rows.length}</strong> listing${rows.length === 1 ? '' : 's'} (${qty} cards)</span>
      ${toCheck ? `<span class="warn">${toCheck} to check</span>` : ''}
      ${noPrice ? `<span class="warn">${noPrice} no price</span>` : ''}
      ${noBack ? `<span class="warn">${noBack} no back</span>` : ''}
      ${noSpecs ? `<span class="warn">${noSpecs} specifics missing</span>` : ''}
      <span class="muted">${settings.exportMode === 'drafts' ? 'Exporting drafts' : 'Exporting live listings'}</span>
      <span class="muted small">${ruleSummary()}</span>
      <span>£${total.toFixed(2)}</span>
      <label class="small"><input type="checkbox" id="onlyCheck"${onlyCheck ? ' checked' : ''}> Only to check</label>`;
  }

  function rowFor(target) {
    const el = target.closest('.card-row');
    return el ? rows.find((r) => r.id === el.dataset.id) : null;
  }

  // ---------- events ----------

  function bindEvents() {
    $('#cameraBtn').addEventListener('click', () => $('#cameraInput').click());
    $('#libraryBtn').addEventListener('click', () => $('#libraryInput').click());
    for (const id of ['#cameraInput', '#libraryInput']) {
      $(id).addEventListener('change', (e) => {
        addFiles(e.target.files);
        e.target.value = '';
      });
    }
    $('#rowPhotoInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      handleRowPhoto(f);
    });

    $('#pairsMode').checked = !!settings.pairsMode;
    $('#pairsMode').addEventListener('change', (e) => {
      settings.pairsMode = e.target.checked;
      nextRole = 'front';
      store(LS_SETTINGS, settings);
      renderNextHint();
    });
    $('#nextHint').addEventListener('click', (e) => {
      if (e.target.id !== 'skipBack') return;
      nextRole = 'front';
      renderNextHint();
    });

    $('#jobs').addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]');
      if (x) {
        const i = jobs.findIndex((j) => j.id === x.dataset.x);
        if (i >= 0) jobs.splice(i, 1);
        renderJobs();
        return;
      }
      const jobEl = e.target.closest('.job.error');
      if (!jobEl) return;
      const job = jobs.find((j) => j.id === jobEl.dataset.job);
      if (job) { job.status = 'queued'; job.error = ''; renderJobs(); pump(); }
    });

    $('#summary').addEventListener('change', (e) => {
      if (e.target.id !== 'onlyCheck') return;
      onlyCheck = e.target.checked;
      renderList();
    });

    const list = $('#list');

    // remember which item-specifics panels are open (toggle doesn't bubble, so capture it)
    list.addEventListener('toggle', (e) => {
      if (!e.target.matches || !e.target.matches('details.specs')) return;
      const r = rowFor(e.target);
      if (r) r._specOpen = e.target.open;
    }, true);

    list.addEventListener('input', (e) => {
      const spec = e.target.dataset.spec;
      if (spec) {
        const r = rowFor(e.target);
        if (!r) return;
        r.specifics = r.specifics || {};
        r.specifics[spec] = e.target.value;
        const need = SPECIFICS.find((x) => x.key === spec);
        e.target.closest('.field').classList.toggle('missing', !!(need && need.need && !e.target.value.trim()));
        e.target.closest('details').querySelector('.spec-count').outerHTML = specCountHtml(r);
        renderSummary();
        saveRows();
        return;
      }
      const f = e.target.dataset.f;
      const r = f && rowFor(e.target);
      if (!r) return;
      if (f === 'extraSpecifics') {
        r.extraSpecifics = e.target.value;
        saveRows();
        return;
      }
      if (f === 'pulseManual') {
        // update price + reminder live without redrawing (keeps the keyboard open)
        r.pulseManual = e.target.value.replace(',', '.');
        applyAutoPrice(r);
        const node = e.target.closest('.card-row');
        node.querySelector('[data-f="price"]').value = r.price;
        node.querySelector('.rule-text').innerHTML = suggestedPrice(r) ? ruleText(r) : ruleSummary();
        const st = pulseStatusText(r);
        const stEl = node.querySelector('.pulse-status');
        stEl.textContent = st.text;
        stEl.classList.toggle('bad', !!st.bad);
        renderSummary();
        saveRows();
        return;
      }
      if (f === 'title') {
        r.title = e.target.value;
        if (!r.titleEdited) {
          r.titleEdited = true;
          const actions = e.target.closest('.row-body').querySelector('.row-actions');
          if (!actions.querySelector('[data-a="retitle"]')) {
            actions.querySelector('[data-a="search"]').insertAdjacentHTML('afterend', '<button class="btn small" data-a="retitle">Reset title</button>');
          }
        }
        e.target.closest('.field').querySelector('.count').textContent = `${r.title.length}/80`;
      } else if (f === 'price') {
        r.price = e.target.value.replace(',', '.');
        r.priceAuto = false;
        renderSummary();
      } else if (f === 'qty') {
        r.qty = e.target.value;
        renderSummary();
      } else {
        return;
      }
      saveRows();
    });

    list.addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      const r = f && rowFor(e.target);
      if (!r) return;
      if (f === 'chosen') {
        r.chosen = parseInt(e.target.value, 10);
        r.status = r.chosen >= 0 ? 'ok' : 'check';
        r.pulseManual = ''; // a typed Pulse price belonged to the old match
        r.pulse = null;
        refreshDerived(r);
        rerenderRow(r);
        fetchPulse(r);
      } else if (f === 'condition') {
        r.condition = e.target.value;
      } else if (f === 'finish') {
        r.finish = e.target.value;
        refreshDerived(r);
        rerenderRow(r);
      } else if (f === 'firstEd') {
        r.firstEd = e.target.checked;
        refreshDerived(r);
        rerenderRow(r);
      } else if (f === 'qty') {
        r.qty = Math.max(1, parseInt(e.target.value, 10) || 1);
        e.target.value = r.qty;
        renderSummary();
      } else if (f === 'price' || f === 'pulseManual') {
        rerenderRow(r); // show/hide "Apply rule" once you've finished typing
      }
      saveRows();
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-a]');
      if (!btn) return;
      const r = rowFor(btn);
      if (!r) return;
      const a = btn.dataset.a;
      const rowNode = btn.closest('.card-row');

      if (a === 'addBack' || a === 'replaceFront') {
        rowPhotoTarget = { rowId: r.id, side: a === 'addBack' ? 'back' : 'front' };
        $('#rowPhotoInput').click();
      } else if (a === 'remove') {
        rows = rows.filter((x) => x !== r);
        searchResults.delete(r.id);
        rowNode.remove();
        renderSummary();
        saveRows();
      } else if (a === 'resetSpecs') {
        r.specifics = {};
        rerenderRow(r);
        saveRows();
      } else if (a === 'ok') {
        r.status = 'ok';
        rerenderRow(r);
        saveRows();
      } else if (a === 'retitle') {
        r.titleEdited = false;
        r.title = buildTitle(r);
        rerenderRow(r);
        saveRows();
      } else if (a === 'usePrice') {
        const s = suggestedPrice(r);
        if (s) { r.price = s.gbp.toFixed(2); r.priceAuto = true; }
        rerenderRow(r);
        saveRows();
      } else if (a === 'search') {
        const box = rowNode.querySelector('.search-box');
        box.hidden = !box.hidden;
        r._searchOpen = !box.hidden;
        if (!box.hidden) box.querySelector('.s-name').focus();
      } else if (a === 'doSearch') {
        const box = rowNode.querySelector('.search-box');
        const params = new URLSearchParams({
          name: box.querySelector('.s-name').value.trim(),
          number: box.querySelector('.s-number').value.trim(),
          set: box.querySelector('.s-set').value.trim(),
        });
        btn.disabled = true;
        btn.textContent = 'Searching…';
        try {
          const data = await api('/api/search?' + params.toString());
          const found = data.candidates || [];
          if (!found.length) toast('Nothing found — try fewer details');
          searchResults.set(r.id, found);
          r._searchOpen = true;
          rerenderRow(r);
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = 'Find';
        }
      } else if (a === 'pick') {
        const found = searchResults.get(r.id) || [];
        const pick = found[parseInt(btn.dataset.idx, 10)];
        if (!pick) return;
        r.candidates = [pick, ...r.candidates.filter((x) => x.id !== pick.id)].slice(0, 12);
        r.chosen = 0;
        r.status = 'ok';
        r._searchOpen = false;
        r.pulseManual = '';
        r.pulse = null;
        searchResults.delete(r.id);
        refreshDerived(r);
        rerenderRow(r);
        saveRows();
        fetchPulse(r);
      } else if (a === 'getPulse') {
        fetchPulse(r);
      } else if (a === 'retryMatch') {
        r._matching = true;
        rerenderRow(r);
        try {
          const m = await api('/api/match', { method: 'POST', body: JSON.stringify({ detected: r.detected }) });
          r.candidates = m.candidates || [];
          r.chosen = r.candidates.length ? 0 : -1;
          r.status = m.status || (r.chosen >= 0 ? 'check' : 'nomatch');
          r.dbError = m.error || '';
          r.pulse = m.pulse || null;
          r.pulseManual = '';
          refreshDerived(r);
          toast(r.chosen >= 0 ? 'Card matched' : (r.dbError ? 'Card database still not answering, try again shortly' : 'Still no match, try Search'));
        } catch (err) {
          toast(err.message);
        } finally {
          r._matching = false;
          rerenderRow(r);
          saveRows();
        }
      }
    });

    $('#exportBtn').addEventListener('click', downloadCSV);
    $('#shareBtn').addEventListener('click', shareCSV);
    $('#clearBtn').addEventListener('click', () => {
      if (!rows.length) return;
      if (!confirm(`Remove all ${rows.length} listings? Export first if you need them.`)) return;
      rows = [];
      searchResults.clear();
      store(LS_ROWS, rows);
      renderList();
    });

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);
    $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });
    $('#saveSettings').addEventListener('click', saveSettings);
    // live preview of the pricing rule while editing (not saved until you tap Save)
    const previewRule = () => {
      const saved = settings;
      settings = { ...saved };
      readSettingsForm();
      const html = ruleSummary();
      settings = saved;
      $('#ruleReminder').innerHTML = html + ' <em>(tap Save to apply)</em>';
    };
    $('#settings').addEventListener('input', previewRule);
    $('#settings').addEventListener('change', previewRule);
    $('#repriceBtn').addEventListener('click', () => {
      readSettingsForm();
      store(LS_SETTINGS, settings);
      let n = 0;
      for (const r of rows) {
        const s = suggestedPrice(r);
        if (s) { r.price = s.gbp.toFixed(2); r.priceAuto = true; n++; }
      }
      saveRows();
      renderList();
      toast(`Updated ${n} price${n === 1 ? '' : 's'}`);
    });
  }

  // ---------- settings ----------

  const SETTING_FIELDS = ['password', 'exportMode', 'categoryId', 'conditionId', 'skuPrefix', 'defaultQty',
    'defaultCondition', 'includeStockPhoto', 'autoPrice', 'priceSource', 'pulseDiscount',
    'eurToGbp', 'priceMultiplier', 'minPrice', 'descTemplate',
    'shippingPolicy', 'returnPolicy', 'paymentPolicy', 'postcode', 'location', 'bestOffer',
    'specGame', 'specManufacturer'];

  function openSettings() {
    $('#s_defaultCondition').innerHTML = CONDITIONS.map((c) => `<option>${esc(c)}</option>`).join('');
    for (const k of SETTING_FIELDS) {
      const el = $('#s_' + k);
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else el.value = settings[k];
    }
    $('#settings').hidden = false;
    document.body.classList.add('sheet-open');
    $('#ruleReminder').innerHTML = ruleSummary();
    checkServer();
  }

  function closeSettings() {
    $('#settings').hidden = true;
    document.body.classList.remove('sheet-open');
  }

  function readSettingsForm() {
    const numOr = (v, d) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : d; };
    for (const k of SETTING_FIELDS) {
      const el = $('#s_' + k);
      settings[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    settings.defaultQty = Math.max(1, parseInt(settings.defaultQty, 10) || 1);
    settings.eurToGbp = numOr(settings.eurToGbp, DEFAULT_SETTINGS.eurToGbp);
    settings.priceMultiplier = numOr(settings.priceMultiplier, 1);
    settings.minPrice = numOr(settings.minPrice, 0);
    settings.pulseDiscount = Math.min(90, Math.max(0, numOr(settings.pulseDiscount, 10)));
    settings.categoryId = String(settings.categoryId).trim() || DEFAULT_SETTINGS.categoryId;
    if (!String(settings.descTemplate).trim()) settings.descTemplate = DEFAULT_DESC;
    for (const k of ['shippingPolicy', 'returnPolicy', 'paymentPolicy', 'location', 'specGame', 'specManufacturer']) {
      settings[k] = String(settings[k] || '').trim();
    }
    settings.postcode = String(settings.postcode || '').trim().toUpperCase();
    if (!settings.specGame) settings.specGame = DEFAULT_SETTINGS.specGame;
  }

  async function saveSettings() {
    readSettingsForm();
    store(LS_SETTINGS, settings);
    renderList(); // export mode / defaults may change what each card shows
    try {
      await api('/api/auth');
      toast('Saved');
      closeSettings();
    } catch (e) {
      toast(e.message);
    }
  }

  function applyHealth(h) {
    photoHost = !!h.photoHostSet;
    pulseOn = !!h.pulseSet;
    $('#photoHostWarn').hidden = photoHost;
    renderList();
  }

  async function checkServer() {
    const el = $('#serverStatus');
    el.textContent = 'Checking server…';
    try {
      const r = await fetch('/api/health');
      const h = await r.json();
      applyHealth(h);
      el.textContent = (h.claudeKeySet
        ? `Server OK · AI model: ${h.model}`
        : 'Server is up, but ANTHROPIC_API_KEY is not set on Render')
        + (h.photoHostSet ? ' · Photo hosting on' : ' · Photo hosting off (no IMGBB_API_KEY)')
        + (h.pulseSet ? ` · Pulse on (${h.pulseCreditsLeft} of ${h.pulseDailyLimit} lookups left today)` : ' · Pulse off (no PULSE_API_KEY)');
      return h;
    } catch (e) {
      el.textContent = 'Could not reach the server (Render may be waking up — try again in a minute)';
      return null;
    }
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- start ----------

  bindEvents();
  renderList();
  renderNextHint();
  // Cards priced before the switch to Pulse's market price get re-checked once.
  const PULSE_PRICE_VERSION = 2;
  async function upgradeOldPulsePrices() {
    if (!usePulse() || !pulseOn) return;
    const old = rows.filter((r) => r.pulse && r.pulse.status === 'ok' && r.pulse.v !== PULSE_PRICE_VERSION);
    for (const r of old) await fetchPulse(r); // one at a time, one lookup each
    if (old.length) toast(`Updated ${old.length} Pulse price${old.length === 1 ? '' : 's'} to the market price`);
  }

  fetch('/api/health').then((r) => r.json()).then((h) => {
    applyHealth(h);
    if (h.passwordRequired && !settings.password) openSettings();
    else upgradeOldPulsePrices();
  }).catch(() => {});

  // exposed for debugging in the browser console
  window.PokeLister = { buildCSV: () => buildCSV(rows), rows: () => rows, settings: () => settings };
})();
