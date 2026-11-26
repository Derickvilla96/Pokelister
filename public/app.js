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
    photoBoost: 8,
    photoContext: 'Cards are photographed standing upright on a clear acrylic display stand, against a plain background.',
    autoLevels: true,
    exportMode: 'live',
    shippingPolicy: '',
    returnPolicy: '',
    paymentPolicy: '',
    postcode: '',
    location: '',
    bestOffer: false,
    specGame: 'Pokémon TCG',
    specManufacturer: 'The Pokémon Company',
    topLine: 'Buying more than one card? Add them all to your basket and check out once – postage is only charged once.',
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
  try { localStorage.removeItem('pokelister.live.v1'); } catch (e) { /* old 'Already on eBay' report, feature removed */ }
  let onlyCheck = false;
  // Tap "4 no price" etc. to show just those cards. Cards stay shown while you fix them,
  // until you tap the filter again or "Show all".
  let filterKind = '';
  let filterIds = new Set();
  const FILTERS = {
    check: { label: 'to check', test: (r) => r.status !== 'ok' },
    noprice: { label: 'no price', test: (r) => !priceStr(r.price) },
    noback: { label: 'no back', test: (r) => !r.backPhoto },
    nospecs: { label: 'specifics missing', test: (r) => missingSpecifics(r).length > 0 },
    nophoto: { label: 'front photo not uploaded', test: (r) => photoHost && !r.frontUrl },
    listed: { label: 'listed on eBay', test: (r) => !!r.ebayItemId },
    ebayfail: { label: 'eBay errors', test: (r) => !!r.ebayError && !r.ebayItemId },
  };
  function setFilter(kind) {
    filterKind = kind && kind !== filterKind ? kind : '';
    filterIds = new Set(filterKind ? rows.filter(FILTERS[filterKind].test).map((r) => r.id) : []);
    onlyCheck = filterKind === 'check';
    renderList();
    window.scrollTo({ top: Math.max(0, $('#summary').getBoundingClientRect().top + window.scrollY - 70), behavior: 'smooth' });
  }
  function rowHidden(r) {
    if (filterKind) return !filterIds.has(r.id);
    return onlyCheck && r.status === 'ok';
  }
  let photoHost = true;          // updated from /api/health
  let pulseOn = true;            // updated from /api/health
  let nextRole = 'front';        // in front & back mode: what the next photo is
  let lastFrontJobId = null;
  let jobSeq = 0;
  const jobBySeq = new Map();    // seq -> job, kept after the thumbnail disappears
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

  // Makes up for the brightness lost when an iPhone HDR photo becomes a standard JPEG:
  // lifts the white point (grey background -> white) and gently brightens the midtones,
  // keeping blacks black. strength 0.08 = 8%.
  function brightenLUT(strength) {
    const k = Math.max(0, Math.min(0.3, strength));
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const x = Math.min(1, (v / 255) / (1 - k));      // white point
      lut[v] = Math.round(255 * Math.pow(x, 1 / (1 + k / 2))); // midtone lift
    }
    return lut;
  }

  function drawScaled(img, maxEdge, quality) {
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    const s = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const boost = Number(settings.photoBoost || 0) / 100;
    const auto = settings.autoLevels !== false;
    if (boost > 0 || auto) {
      const data = ctx.getImageData(0, 0, w, h);
      const px = data.data;
      const luts = auto ? autoLevelLUTs(px, boost, w, h) : [brightenLUT(boost), brightenLUT(boost), brightenLUT(boost)];
      for (let i = 0; i < px.length; i += 4) {
        px[i] = luts[0][px[i]];
        px[i + 1] = luts[1][px[i + 1]];
        px[i + 2] = luts[2][px[i + 2]];
      }
      ctx.putImageData(data, 0, 0);
    }
    return c.toDataURL('image/jpeg', quality);
  }

  // Per-photo correction: measure the background around the edges of the photo, lift it to
  // near-white and remove a slight colour cast there, then lift midtones by `boost`.
  // (The brightest pixels are often holo glare, so they're a poor guide to the background.)
  function autoLevelLUTs(px, boost, w, h) {
    const L = (i) => px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const bw = Math.max(2, Math.round(w * 0.06)), bh = Math.max(2, Math.round(h * 0.06));
    const edge = [];
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        if (x >= bw && x < w - bw && y >= bh && y < h - bh) { x = w - bw - 1; continue; } // skip the middle
        edge.push((y * w + x) * 4);
      }
    }
    const lums = edge.map(L).sort((a, b) => a - b);
    const median = lums.length ? lums[lums.length >> 1] : 255;
    let sr = 0, sg = 0, sb = 0, m = 0;
    for (const i of edge) {
      if (Math.abs(L(i) - median) <= 20) { sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; m++; }
    }
    let avg = m ? [sr / m, sg / m, sb / m] : [255, 255, 255];
    // A dark or strongly coloured background (e.g. a playmat) isn't meant to be white: only brighten gently.
    const chroma = Math.max(...avg) - Math.min(...avg);
    if (median < 110 || chroma > 40) avg = [median + 60, median + 60, median + 60].map((v) => Math.min(255, v));
    const target = 245;
    const lum = avg[0] * 0.299 + avg[1] * 0.587 + avg[2] * 0.114;
    const baseGain = Math.min(1.45, Math.max(1, target / Math.max(lum, 1))); // never darken, cap the lift
    const gamma = 1 / (1 + boost);
    return avg.map((a) => {
      // neutralise a cast in the background, but only by up to ±8% per channel
      const cast = Math.min(1.08, Math.max(0.92, lum / Math.max(a, 1)));
      const gain = baseGain * cast;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(Math.min(1, (v * gain) / 255), gamma));
      return lut;
    });
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
      jobBySeq.set(job.seq, job);
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
      // Every photo is read, so a front picked where a back was expected (or the other way
      // round) still ends up in the right place.
      const work = runFrontJob(job);
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
      const data = await api('/api/identify', { method: 'POST', body: JSON.stringify({ image: job.prepared.full, photoContext: settings.photoContext || '' }) });
      const cards = data.cards || [];

      if (!cards.length && data.cardBack) {
        // A card back belongs to the photo picked just before it (front, back, front, back…).
        // If that photo was a back too, use the nearest earlier front.
        let prev = jobBySeq.get(job.seq - 1);
        if (!prev || prev.role === 'back' && prev.status === 'done') {
          prev = [...jobBySeq.values()].filter((j) => j.seq < job.seq && !(j.role === 'back' && j.status === 'done')).pop();
        }
        const target = prev ? prev.id : (rows[0] && rows[0].jobId);
        if (!target) throw new Error('That was a card back — scan the front first');
        await upload;
        job.role = 'back';
        job.pairedWith = target;
        if (prev) prev.role = 'front';
        setBack(target, { url: job.frontUrl || '', thumb: job.thumb, error: job.uploadError });
        finishJob(job, 0);
        if (!settings.pairsMode) toast('Card back added to the previous card');
        return;
      }
      if (!cards.length) throw new Error('No card found in this photo');

      job.role = 'front'; // it shows a card, whatever position it was picked in
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
      ? '<span>Next photo: <strong>BACK</strong> of the last card. PokeLister checks each photo, so a slip in the order is fixed for you.</span><button class="btn small" id="skipBack">Skip back</button>'
      : '<span>Next photo: <strong>FRONT</strong> of a card. Library: pick front, back, front, back… PokeLister checks each photo, so a slip in the order is fixed for you.</span>';
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
      stamp: shortStamp(d.stamp),
      stampConfirmed: !d.stamp,
      condition: settings.defaultCondition,
      qty: settings.defaultQty || 1,
      price: '',
      priceAuto: true,
      pulse: result.pulse || null,
      pulseManual: '',
      dbError: result.error || '',
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
      title: '',
      titleEdited: false,
      createdAt: Date.now(),
    };
    if (!['normal', 'holo', 'reverse holo'].includes(row.finish)) {
      const rarity = ((chosen(row) || {}).rarity || d.rarity || '').toLowerCase();
      row.finish = rarity.includes('holo') ? 'holo' : 'normal';
      if (row.status === 'ok') row.status = 'check'; // AI wasn't sure of the finish
      row.reasons.push(`the AI couldn't tell the finish, so it guessed ${row.finish === 'holo' ? 'Holo' : 'Normal'}`);
    }
    if (row.stamp) { row.reasons.push(`confirm the ${row.stamp} stamp`); if (row.status === 'ok') row.status = 'check'; } // stamps are easy to misread
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
      return { name: c.name, number, set: c.setName || d.set_name || c.setNameLocal || '', rarity: c.rarity, language, id: c.id };
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
    // keep titles in English letters: buyers on eBay UK don't search in Chinese/Japanese script
    const latin = (t) => !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/.test(t);
    if (i.set && latin(i.set)) extras.push(i.set.replace(/\s*\((simplified|traditional)?\s*chinese\)|\s*\(japanese\)/ig, ''));
    if (r.firstEd) extras.push('1st Edition');
    if (String(r.stamp || '').trim()) extras.push('Stamped');
    const fl = finishLabel(r.finish);
    if (fl && !(r.finish === 'holo' && /holo/i.test(rarity))) extras.push(fl);
    if (i.language && !/^english$/i.test(i.language)) extras.push(/chinese/i.test(i.language) ? 'Chinese' : i.language);
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
      const loose = p.matchedBy === 'number'
        ? ` Matched by card number only (Pulse ${p.productId ? 'listed it as ' + p.productId.split('|').slice(0, 2).join(' ') : 'had no set confirmation'}), so double-check this price.`
        : '';
      const ver = p.productId ? ` Version: ${versionLabel(p)}${p.userPicked ? ' (your choice)' : ''}.` : '';
      return { text: `From PulseTCG: ${parts.join(' · ') || p.basis}${using}.${ver}${loose}`, bad: !!loose, recheck: true };
    }
    if (p.status === 'nomatch') {
      let why = '';
      if (p.tried && p.tried.length) {
        const looked = p.tried.map((t) => `"${t.search}" (${t.results} result${t.results === 1 ? '' : 's'}`
          + (t.foreignSkipped ? `, ${t.foreignSkipped} foreign skipped` : '')
          + (t.sample && t.sample.length ? ': ' + t.sample.join(', ') : '')
          + (t.skippedSample && t.skippedSample.length ? `; other language skipped: ${t.skippedSample.join(', ')}` : '') + ')').join('; ');
        const wanted = [p.wanted && p.wanted.number, p.wanted && p.wanted.set].filter(Boolean).join(', ');
        why = ` Searched ${looked}${wanted ? `; needed ${wanted}` : ''}.`;
      }
      return { text: `Pulse couldn't confirm this card, so it didn't guess a price.${why} Type its price from the PulseTCG app, or fix the match and tap Check Pulse.`, bad: true, fetch: true };
    }
    if (p.status === 'limit') return { text: p.error || 'Daily Pulse limit reached. Type the price in.', bad: true };
    return { text: 'Pulse lookup failed' + (p.error ? `: ${p.error}` : '') + '.', bad: true, fetch: true };
  }

  // Same preference order as the server: matching finish, then plain version, then cheapest.
  function rankPulseVersions(versions, finish, stamp) {
    const f = String(finish || '').toLowerCase();
    const stamped = !!String(stamp || '').trim();
    const words = String(stamp || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['stamp', 'stamped', 'logo'].includes(w));
    const score = (x) => {
      const v = String(x.variant || '').toLowerCase();
      const isStampVersion = /stamp|prerelease|staff|promo|pok[eé]mon center|worlds/.test(v);
      let sc = 0;
      if (stamped) {
        if (isStampVersion) sc += 8;
        if (words.some((w) => v.includes(w))) sc += 4;
      } else {
        if (isStampVersion) sc -= 8;
        if (['', 'normal', 'holo', 'reverse holo'].includes(v)) sc += 2;
      }
      if (f === 'reverse holo' ? /reverse/.test(v) : f === 'holo' ? /(^|\s)holo/.test(v) && !/reverse/.test(v) : !/holo/.test(v)) sc += 3;
      return sc;
    };
    return [...versions].sort((a, b) => score(b) - score(a) || a.gbp - b.gbp);
  }

  function usePulseVersion(r, ver, userPicked) {
    if (!r.pulse || !ver) return;
    Object.assign(r.pulse, {
      gbp: ver.gbp, basis: ver.basis, market: ver.market, cmNm: ver.cmNm,
      productId: ver.productId, variant: ver.variant, userPicked: !!userPicked,
    });
  }

  function versionLabel(v) {
    return v.variant || 'Normal';
  }

  async function fetchPulse(r) {
    if (!usePulse() || !pulseOn) return;
    const c = chosen(r);
    const d = r.detected || {};
    const q = c
      ? { name: c.name, nameLocal: c.nameLocal || d.name_printed || '', number: d.number && normNumber(d.number) === normNumber(c.number) ? d.number : c.number,
          total: d.set_total && normNumber(d.set_total) === normNumber(c.printedTotal) ? d.set_total : String(c.printedTotal || ''),
          setId: c.setId || '', setName: c.setName || '', language: d.language || '', finish: r.finish || '', stamp: r.stamp || '' }
      : { name: d.name || '', nameLocal: d.name_printed || '', number: d.number || '', total: d.set_total || '', setId: '',
          setCode: d.set_code || '', setName: d.set_name || '', language: d.language || '', finish: r.finish || '', stamp: r.stamp || '' };
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

  // "'Scarlet & Violet Twilight Masquerade' set-logo stamp on the artwork" -> "Twilight Masquerade"
  function shortStamp(v) {
    const raw = String(v == null ? '' : v).trim();
    let t = raw.replace(/["'‘’“”]/g, '');
    if (/^(none|no|n\/a|null)$/i.test(t)) return '';
    t = t.replace(/\b(on|in) the (artwork|art|card|text box|image)\b/gi, '')
      .replace(/\bscarlet\s*(&|and)\s*violet\b/gi, '')
      .replace(/\b(set[- ]?logo|logo|stamped|stamp|foil|gold|silver)\b/gi, '')
      .replace(/\s+/g, ' ').replace(/^[\s,.\-–()]+|[\s,.\-–()]+$/g, '').trim();
    return t.slice(0, 30).trim() || (raw ? 'Stamped' : '');
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
      'Language': /chinese/i.test(i.language || '') ? 'Chinese' : (i.language || 'English'),
      'Manufacturer': settings.specManufacturer || '',
      'Year Manufactured': year,
      'Features': [r.firstEd ? '1st Edition' : '', shortStamp(r.stamp) ? `Stamped (${shortStamp(r.stamp)})` : ''].filter(Boolean).join(', '),
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
      stamp: String(r.stamp || '').trim() ? `Stamped: ${String(r.stamp).trim()}` : '',
    };
    const body = String(settings.descTemplate || '')
      .replace(/\{(\w+)\}/g, (m, k) => (k in map ? esc(map[k]) : m))
      .replace(/\r?\n/g, '<br>');
    return withTopLine(body);
  }

  // Puts your "always at the top" line first, moving it there if the template has it lower down.
  function withTopLine(desc) {
    const line = esc(String(settings.topLine || '').trim()).replace(/\r?\n/g, '<br>');
    if (!line) return desc;
    if (desc.startsWith(line)) return desc;
    const rest = desc.split(line).join('').replace(/^(\s*<br>)+/, '').replace(/(<br>\s*)+$/, '').replace(/(<br>){3,}/g, '<br><br>');
    return line + '<br><br>' + rest;
  }
  function topLineMissing(r) {
    const line = esc(String(settings.topLine || '').trim()).replace(/\r?\n/g, '<br>');
    if (!line) return false;
    const raw = String(settings.descTemplate || '').replace(/\r?\n/g, '<br>');
    return !raw.startsWith(line);
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
    return names.map((n) => String(s[n] || '').trim().slice(0, 65)); // eBay limit: 65 characters per item specific
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
    openCheck('download');
  }
  function oldDownloadCSV() {
    if (!readyToExport()) return;
    saveFile(buildCSV(rows), exportName());
    toast(`Exported ${rows.length} card${rows.length === 1 ? '' : 's'}`);
  }

  function shareCSV() {
    openCheck('share');
  }
  async function oldShareCSV() {
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

  function saveFile(text, name) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
    const set = x.setName || x.setNameLocal || '';
    const code = x.source === 'tcgdex' && x.setId ? ` (${String(x.setId).toUpperCase()})` : '';
    return `${x.name} ${num} · ${set}${code}${x.rarity ? ' · ' + x.rarity : ''}`;
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
    el.className = 'card-row' + (r.status === 'ok' ? '' : ' needs-check') + (selectMode && selected.has(r.id) ? ' selected' : '') + (r.ebayItemId ? ' is-listed' : '');
    el.dataset.id = r.id;
    el.hidden = rowHidden(r);

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
          ${r.pulse && r.pulse.status === 'ok' && r.pulse.versions && r.pulse.versions.length > 1 ? `
          <label class="field"><span>Pulse version (${r.pulse.versions.length} found)</span>
            <select data-f="pulseVersion">${r.pulse.versions.map((v, i) => `<option value="${i}"${v.productId === r.pulse.productId ? ' selected' : ''}>${esc(versionLabel(v))} – £${Number(v.gbp).toFixed(2)}</option>`).join('')}</select>
          </label>` : ''}
          <div class="pulse-status${st.bad ? ' bad' : ''}">${esc(st.text)}</div>
        </div>`;
    } else {
      priceHint = sp
        ? `<div class="price-hint">${ruleText(r)} <button class="btn small" data-a="usePrice">Use</button></div>`
        : (c ? '<div class="price-hint">No Cardmarket price for this card</div>' : '');
    }
    let notes = r.detected && r.detected.notes ? `<p class="notes">AI note: ${esc(r.detected.notes)}</p>` : '';
    if (r.stamp && !r.stampConfirmed) {
      notes += `<p class="notes">⭐ The AI thinks this card has a <strong>${esc(r.stamp)}</strong> stamp. Check the card: clear the Stamp box if there isn't one, then tap Mark OK.</p>`;
    }
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
          : `<div class="empty-img">${c ? 'No picture in the database' : 'No match'}</div>`}
      </div>
      <div class="row-body">
        ${r._listing ? '<p class="listing-now">Listing on eBay…</p>' : ''}
        ${r.ebayItemId ? `<p class="listed">✓ Live on eBay · <a href="https://www.ebay.co.uk/itm/${esc(r.ebayItemId)}" target="_blank" rel="noopener">${esc(r.ebayItemId)}</a>${r.ebayWarnings ? `<br><span class="muted small">eBay notes: ${esc(r.ebayWarnings)}</span>` : ''}</p>` : ''}
        ${r.ebayError && !r.ebayItemId ? `<p class="why-check">eBay didn't list it: ${esc(r.ebayError)}</p>` : ''}
        <div class="row-head">
          ${selectMode ? `<label class="sel"><input type="checkbox" data-sel="${r.id}"${selected.has(r.id) ? ' checked' : ''} aria-label="Select"></label>` : ''}
          <div class="row-name">${esc(i.name || 'Unknown card')} <span class="muted">${esc(i.number)}</span></div>
          ${badge}
        </div>
        ${r.status !== 'ok' && r.reasons && r.reasons.length ? `<p class="why-check">Why check: ${r.reasons.map(esc).join('; ')}.</p>` : ''}
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
        <label class="field"><span>Card language</span><select data-f="language"${r._matching ? ' disabled' : ''}>${languageOpts(r)}</select></label>
        <label class="check"><input type="checkbox" data-f="firstEd"${r.firstEd ? ' checked' : ''}> 1st Edition</label>
        <label class="field"><span>Stamp ${String(r.stamp || '').trim() ? '<em class="stamp-flag">⭐ stamped</em>' : '(leave blank if none)'}</span>
          <input data-f="stamp" value="${esc(r.stamp || '')}" placeholder="e.g. Twilight Masquerade, Prerelease, Pokémon Center"></label>
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

  const LANGUAGES = ['English', 'Japanese', 'Chinese (Traditional)', 'Chinese (Simplified)', 'Korean', 'French', 'German', 'Italian', 'Spanish', 'Portuguese', 'Thai', 'Indonesian'];
  function languageOpts(r) {
    const cur = (r.detected && r.detected.language) || 'English';
    const list = LANGUAGES.some((l) => l.toLowerCase() === cur.toLowerCase()) ? LANGUAGES : [cur, ...LANGUAGES];
    return list.map((l) => `<option${l.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }

  // Look the card up again (after a database hiccup, or when you change its language)
  async function rematch(r) {
    r._matching = true;
    rerenderRow(r);
    try {
      const m = await api('/api/match', { method: 'POST', body: JSON.stringify({ detected: r.detected }) });
      if (m.detected && m.detected.name) r.detected = { ...r.detected, name: m.detected.name }; // spelling fixed by the server
      r.candidates = m.candidates || [];
      r.chosen = r.candidates.length ? 0 : -1;
      r.status = m.status || (r.chosen >= 0 ? 'check' : 'nomatch');
      r.dbError = m.error || '';
      r.reasons = Array.isArray(m.reasons) ? m.reasons : [];
      r.pulse = m.pulse || null;
      r.pulseManual = '';
      r.priceAuto = true;
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

  function chip(kind, n) {
    const on = filterKind === kind;
    if (!n && !on) return '';
    const cls = kind === 'listed' ? 'good' : 'warn';
    return `<button class="chip ${cls}${on ? ' on' : ''}" data-filter="${kind}" aria-pressed="${on}">${n} ${FILTERS[kind].label}</button>`;
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
      ${chip('check', toCheck)}${chip('noprice', noPrice)}${chip('noback', noBack)}${chip('nospecs', noSpecs)}${chip('ebayfail', rows.filter(FILTERS.ebayfail.test).length)}${chip('listed', rows.filter(FILTERS.listed.test).length)}
      ${rows.some((r) => r.ebayItemId) ? '<button class="chip clear" data-tool="clearListed">Remove listed</button>' : ''}
      ${filterKind ? `<button class="chip clear" data-filter="">Show all ${rows.length}</button>` : ''}
      <span class="muted">${settings.exportMode === 'drafts' ? 'Exporting drafts' : 'Exporting live listings'}</span>
      <span class="muted small">${ruleSummary()}</span>
      <span>£${total.toFixed(2)}</span>
      <label class="small"><input type="checkbox" id="onlyCheck"${onlyCheck ? ' checked' : ''}> Only to check</label>
      <div class="tools"><button class="btn small" data-tool="review">▶ Review cards</button>
        <button class="btn small${selectMode ? ' primary' : ''}" data-tool="select">${selectMode ? 'Done selecting' : '☑ Select & bulk edit'}</button></div>`;
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
      filterKind = '';
      onlyCheck = e.target.checked;
      renderList();
    });
    $('#summary').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (b) setFilter(b.dataset.filter);
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
      } else if (f === 'language') {
        r.detected = { ...(r.detected || {}), language: e.target.value };
        // the AI's English name is fine for any language; the printed name only applies to its own
        if (/^english$/i.test(e.target.value)) r.detected.name_printed = '';
        searchResults.delete(r.id);
        rematch(r);
      } else if (f === 'condition') {
        r.condition = e.target.value;
      } else if (f === 'stamp') {
        r.stamp = e.target.value.trim();
        r.stampConfirmed = true;
        if (r.pulse && r.pulse.status === 'ok' && r.pulse.versions && r.pulse.versions.length > 1 && !r.pulse.userPicked) {
          usePulseVersion(r, rankPulseVersions(r.pulse.versions, r.finish, r.stamp)[0], false);
        }
        refreshDerived(r);
        rerenderRow(r);
      } else if (f === 'pulseVersion') {
        const ver = r.pulse && r.pulse.versions && r.pulse.versions[parseInt(e.target.value, 10)];
        usePulseVersion(r, ver, true);
        refreshDerived(r);
        rerenderRow(r);
      } else if (f === 'finish') {
        r.finish = e.target.value;
        // re-pick the Pulse version for the new finish, unless you chose one yourself
        if (r.pulse && r.pulse.status === 'ok' && r.pulse.versions && r.pulse.versions.length > 1 && !r.pulse.userPicked) {
          usePulseVersion(r, rankPulseVersions(r.pulse.versions, r.finish, r.stamp)[0], false);
        }
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
        r.stampConfirmed = true;
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
          language: (r.detected && r.detected.language) || 'English',
          englishName: (r.detected && r.detected.name) || '',
          englishSet: (r.detected && r.detected.set_name) || '',
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
        await rematch(r);
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

  // ======================================================================
  // Pre-upload check, bulk edit, quick review, list straight to eBay
  // ======================================================================

  const LS_EBAY = 'pokelister.ebay.v1';
  let ebayConn = load(LS_EBAY, null);  // { token, connectedAt, expires } – sealed by the server
  let ebayServer = false;               // server has the eBay developer keys
  let ebayRunning = false;

  function ebayReady() {
    return !!(ebayServer && ebayConn && ebayConn.token && (!ebayConn.expires || ebayConn.expires > Date.now()));
  }

  function renderBottomBar() {
    const on = ebayReady();
    $('#ebayBtn').hidden = !on;
    // with eBay connected the CSV buttons stay, but smaller
    $('#exportBtn').classList.toggle('primary', !on);
    $('#exportBtn').textContent = on ? 'CSV' : 'Download CSV';
    $('#shareBtn').textContent = on ? 'Share' : 'Share CSV';
  }

  // ---------- one card as an eBay listing (same data as the live CSV) ----------

  function listingFor(r) {
    const names = specificColumns([r]);
    const vals = specificValues(r, names);
    const specifics = {};
    names.forEach((n, i) => { if (vals[i]) specifics[n] = vals[i]; });
    return {
      sku: skuFor(r), title: String(r.title || '').slice(0, 80), description: buildDescription(r),
      categoryId: settings.categoryId, price: priceStr(r.price), qty: parseInt(r.qty, 10) || 1,
      cardCondition: CD_CONDITION[r.condition] || '400010', pictures: photoUrls(r), specifics,
      bestOffer: !!settings.bestOffer, location: settings.location || settings.postcode, postcode: settings.postcode,
      shippingPolicy: settings.shippingPolicy, returnPolicy: settings.returnPolicy, paymentPolicy: settings.paymentPolicy,
    };
  }

  // ---------- pre-upload check ----------

  const CHECK_LABELS = {
    busy: 'photo still processing',
    noprice: 'no price',
    nophoto: 'front photo not uploaded',
    listed: 'already live on eBay',
    check: 'still marked to check',
    noback: 'no back photo',
    nospecs: 'item specifics missing',
  };

  // Fixes what can be fixed safely, then sorts the cards into ready / left out.
  function runCheck(mode) {
    const live = mode === 'ebay' || settings.exportMode !== 'drafts';
    const fixed = [];
    const passed = [];
    let n;

    // titles: rebuild empty ones, tidy spaces, keep within 80 characters
    n = 0;
    for (const r of rows) {
      let t = String(r.title || '').replace(/\s+/g, ' ').trim();
      if (!t) t = buildTitle(r);
      if (t.length > 80) t = t.slice(0, 80).trim();
      if (t !== r.title) { r.title = t; n++; }
    }
    if (n) fixed.push(`Tidied ${n} title${n === 1 ? '' : 's'} (spaces, empty or over 80 characters)`);
    else passed.push('Every title is 80 characters or less');

    // prices: never below your minimum
    const min = Number(settings.minPrice) || 0;
    n = 0;
    if (min > 0) {
      for (const r of rows) {
        const p = parseFloat(priceStr(r.price));
        if (p && p < min) { r.price = min.toFixed(2); r.priceAuto = false; n++; }
      }
    }
    if (n) fixed.push(`Raised ${n} price${n === 1 ? '' : 's'} to your £${min.toFixed(2)} minimum`);

    // postage line
    if (String(settings.topLine || '').trim()) {
      if (topLineMissing()) fixed.push('Put your postage line at the top of every description');
      else passed.push('Postage line is at the top of every description');
    }

    // item specifics over 65 characters get cut on export
    n = rows.filter((r) => Object.values(getSpecifics(r)).some((v) => String(v || '').trim().length > 65)
      || Object.values(parseExtraSpecifics(r.extraSpecifics)).some((v) => String(v).trim().length > 65)).length;
    if (n) fixed.push(`Shortened item specifics on ${n} card${n === 1 ? '' : 's'} to eBay's 65 characters`);
    else passed.push('Every item specific is 65 characters or less');

    const missingSettings = [];
    if (live) {
      if (!String(settings.shippingPolicy).trim()) missingSettings.push('postage policy name');
      if (!String(settings.returnPolicy).trim()) missingSettings.push('returns policy name');
      if (!String(settings.postcode).trim()) missingSettings.push('postcode');
      if (!missingSettings.length) passed.push(`Postage policy: "${settings.shippingPolicy}"`);
    }

    const busyJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'working').length;
    const ready = [];
    const blocked = {};
    const warn = {};
    const add = (obj, k, r) => { (obj[k] = obj[k] || []).push(r); };
    for (const r of rows) {
      const why = [];
      if (r.ebayItemId) why.push('listed');
      if (r._uploading || r._listing) why.push('busy');
      if (live && !priceStr(r.price)) why.push('noprice');
      if (live && photoHost && !r.frontUrl) why.push('nophoto');
      if (why.length) { add(blocked, why[0], r); continue; }
      ready.push(r);
      if (r.status !== 'ok') add(warn, 'check', r);
      if (settings.pairsMode && (photoHost ? !r.backUrl : !r.backPhoto)) add(warn, 'noback', r);
      if (missingSpecifics(r).length) add(warn, 'nospecs', r);
    }
    if (photoHost && !blocked.nophoto && !warn.noback) passed.push('Every card has its front and back photo');
    saveRows();
    renderList();
    return { mode, live, fixed, passed, missingSettings, ready, blocked, warn, busyJobs };
  }

  let lastCheck = null;

  function openCheck(mode) {
    if (!rows.length) { toast('No cards yet'); return; }
    lastCheck = runCheck(mode);
    renderCheck();
    openSheet('checkSheet');
  }

  function renderCheck() {
    const c = lastCheck;
    const verb = c.mode === 'ebay' ? 'List' : c.mode === 'share' ? 'Share' : 'Download';
    const what = c.mode === 'ebay' ? 'live on eBay now' : c.live ? 'as live listings' : 'as drafts';
    const showBtn = (k, list) => (FILTERS[k] ? `<button class="btn small" data-check-show="${k}">Show ${list.length}</button>` : '');
    const line = (k, list) => `<li><span>${list.length} ${esc(CHECK_LABELS[k])}</span>${showBtn(k, list)}</li>`;
    const blockedKeys = Object.keys(c.blocked);
    const warnKeys = Object.keys(c.warn);
    const left = blockedKeys.reduce((n, k) => n + c.blocked[k].length, 0);
    let html = '';
    if (c.fixed.length) html += `<h3>Fixed for you</h3><ul class="check-list ok">${c.fixed.map((f) => `<li><span>✓ ${esc(f)}</span></li>`).join('')}</ul>`;
    if (c.passed.length) html += `<h3>All good</h3><ul class="check-list ok">${c.passed.map((f) => `<li><span>✓ ${esc(f)}</span></li>`).join('')}</ul>`;
    if (c.busyJobs) html += `<p class="warn-text">${c.busyJobs} photo${c.busyJobs === 1 ? ' is' : 's are'} still being read – wait for them to finish if they're part of this upload.</p>`;
    if (c.missingSettings.length) {
      html += `<h3>Needed first</h3><p class="warn-text">Add your ${esc(c.missingSettings.join(', '))} in Settings.</p>
        <div class="sheet-actions"><button class="btn primary" data-check-settings>Open Settings</button></div>`;
      $('#checkBody').innerHTML = html;
      return;
    }
    if (blockedKeys.length) html += `<h3>Left out of this upload (${left})</h3><ul class="check-list bad">${blockedKeys.map((k) => line(k, c.blocked[k])).join('')}</ul>`;
    if (warnKeys.length) html += `<h3>Worth a look (still included)</h3><ul class="check-list warn">${warnKeys.map((k) => line(k, c.warn[k])).join('')}</ul>`;
    const n = c.ready.length;
    html += n
      ? `<div class="sheet-actions">
          ${c.mode === 'ebay' ? '<button class="btn" data-check-test>Test 1 card first</button>' : ''}
          <button class="btn primary" data-check-go>${verb} ${n} card${n === 1 ? '' : 's'}</button>
        </div>
        <p class="help">${n} card${n === 1 ? '' : 's'} will go ${what}.${c.mode === 'ebay' ? ' "Test 1 card first" asks eBay to check the first card without listing it.' : ''}</p>
        <div id="checkTest" class="help"></div>`
      : '<p class="warn-text">No cards are ready yet.</p>';
    $('#checkBody').innerHTML = html;
  }

  async function checkGo() {
    const c = lastCheck;
    if (!c || !c.ready.length) return;
    closeSheet('checkSheet');
    if (c.mode === 'download') {
      saveFile(buildCSV(c.ready), exportName());
      toast(`Exported ${c.ready.length} card${c.ready.length === 1 ? '' : 's'}`);
    } else if (c.mode === 'share') {
      const file = new File([buildCSV(c.ready)], exportName(), { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'eBay listings' }); } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
      } else {
        toast('Sharing files is not supported here — use Download');
      }
    } else if (c.mode === 'ebay') {
      listOnEbay(c.ready);
    }
  }

  // ---------- list straight to eBay ----------

  async function ebayCall(r, verify) {
    return api('/api/ebay/list', { method: 'POST', body: JSON.stringify({ token: ebayConn && ebayConn.token, listing: listingFor(r), verify: !!verify }) });
  }
  const ebayMsg = (res) => (res.errors || []).map((e) => e.message).filter(Boolean).join(' ') || 'eBay didn\'t accept it';

  async function testOnEbay() {
    const r = lastCheck && lastCheck.ready[0];
    const box = $('#checkTest');
    if (!r || !box) return;
    box.textContent = `Asking eBay to check "${r.title}"…`;
    try {
      const res = await ebayCall(r, true);
      if (res.ok) {
        const fees = (res.fees || []).reduce((s, f) => s + f.amount, 0);
        box.innerHTML = `<span class="ok-text">✓ eBay accepted "${esc(r.title)}" (not listed). Listing fees: £${fees.toFixed(2)}.</span>`
          + ((res.warnings || []).length ? `<br>eBay notes: ${esc(res.warnings.map((w) => w.message).join(' '))}` : '');
      } else {
        box.innerHTML = `<span class="warn-text">eBay wouldn't accept it: ${esc(ebayMsg(res))}</span>`;
      }
    } catch (e) {
      box.innerHTML = `<span class="warn-text">${esc(e.message)}</span>`;
    }
  }

  async function listOnEbay(list) {
    if (ebayRunning) { toast('Already listing – wait for it to finish'); return; }
    if (!confirm(`List ${list.length} card${list.length === 1 ? '' : 's'} LIVE on eBay now?`)) return;
    ebayRunning = true;
    let done = 0, okN = 0, failN = 0;
    for (const r of list) { r._listing = true; r.ebayError = ''; }
    renderList();
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        try {
          const res = await ebayCall(r, false);
          if (res.ok && res.itemId) {
            r.ebayItemId = res.itemId;
            r.listedAt = Date.now();
            r.ebayWarnings = (res.warnings || []).map((w) => w.message).join(' ');
            okN++;
          } else {
            r.ebayError = ebayMsg(res);
            failN++;
          }
        } catch (e) {
          r.ebayError = e.message;
          failN++;
        }
        r._listing = false;
        done++;
        toast(`Listing on eBay… ${done} of ${list.length}`);
        rerenderRow(r);
        saveRows();
      }
    };
    await Promise.all([worker(), worker()]);
    ebayRunning = false;
    renderList();
    toast(failN ? `${okN} listed, ${failN} failed – tap "${failN} eBay errors" to see why` : `All ${okN} listed on eBay ✓`);
  }

  async function connectEbay() {
    try {
      const { url } = await api('/api/ebay/connect-url');
      location.href = url;
    } catch (e) {
      toast(e.message);
    }
  }

  async function checkPolicies() {
    const out = $('#ebayPolicyResult');
    out.textContent = 'Asking eBay for your policies…';
    try {
      const { policies } = await api('/api/ebay/policies', { method: 'POST', body: JSON.stringify({ token: ebayConn.token }) });
      const part = (label, list, want) => {
        if (!list) return `${label}: couldn't read them`;
        const hit = want && list.some((p) => p.name.trim().toLowerCase() === want.trim().toLowerCase());
        return `${label}: ${list.map((p) => p.name).join(', ') || 'none'}${want ? (hit ? ` – "${want}" ✓` : ` – "${want}" NOT FOUND`) : ''}`;
      };
      out.innerHTML = [part('Postage', policies.shipping, settings.shippingPolicy), part('Returns', policies.returns, settings.returnPolicy),
        part('Payment', policies.payment, settings.paymentPolicy)].map(esc).join('<br>');
    } catch (e) {
      out.textContent = e.message;
    }
  }

  function renderEbaySettings() {
    const st = $('#ebayStatus');
    if (!ebayServer) st.textContent = 'Not set up on the server yet (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RUNAME on Render).';
    else if (ebayReady()) st.textContent = `Connected on this device since ${new Date(ebayConn.connectedAt).toLocaleDateString('en-GB')}.`;
    else st.textContent = 'Not connected on this device.';
    $('#ebayConnect').hidden = !ebayServer || ebayReady();
    $('#ebayCheckPolicies').hidden = !ebayReady();
    $('#ebayDisconnect').hidden = !ebayConn;
  }

  // ---------- sheets ----------

  function openSheet(id) {
    $('#' + id).hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeSheet(id) {
    $('#' + id).hidden = true;
    if (![...document.querySelectorAll('.sheet, .review')].some((el) => !el.hidden)) document.body.classList.remove('sheet-open');
  }

  // ---------- bulk edit ----------

  let selectMode = false;
  const selected = new Set();

  function setSelectMode(on) {
    selectMode = on;
    if (!on) selected.clear();
    $('#bulkBar').hidden = !on;
    $('#mainBar').hidden = on;
    renderList();
    renderBulkCount();
  }
  function renderBulkCount() {
    $('#bulkCount').textContent = `${selected.size} selected`;
    $('#bulkEdit').disabled = !selected.size;
  }
  function selectedRows() {
    return rows.filter((r) => selected.has(r.id));
  }

  function openBulk() {
    const n = selected.size;
    if (!n) return;
    $('#bulkTitle').textContent = `Edit ${n} card${n === 1 ? '' : 's'}`;
    const keep = '<option value="">No change</option>';
    $('#b_condition').innerHTML = keep + CONDITIONS.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#b_finish').innerHTML = keep + FINISHES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#b_language').innerHTML = keep + LANGUAGES.map((l) => `<option>${esc(l)}</option>`).join('');
    $('#b_priceMode').value = '';
    $('#b_price').value = '';
    $('#b_qty').value = '';
    $('#b_ok').checked = false;
    openSheet('bulkSheet');
  }

  async function applyBulk() {
    const list = selectedRows();
    const cond = $('#b_condition').value;
    const finish = $('#b_finish').value;
    const lang = $('#b_language').value;
    const priceMode = $('#b_priceMode').value;
    const price = parseFloat(String($('#b_price').value).replace(',', '.'));
    const qty = parseInt($('#b_qty').value, 10);
    if (priceMode === 'set' && !(price > 0)) { toast('Type the price to set'); return; }
    const rematchList = [];
    for (const r of list) {
      if (cond) r.condition = cond;
      if (finish) {
        r.finish = finish;
        if (r.pulse && r.pulse.status === 'ok' && r.pulse.versions && r.pulse.versions.length > 1 && !r.pulse.userPicked) {
          usePulseVersion(r, rankPulseVersions(r.pulse.versions, r.finish, r.stamp)[0], false);
        }
      }
      if (qty > 0) r.qty = qty;
      if (lang && lang !== ((r.detected && r.detected.language) || 'English')) {
        r.detected = { ...(r.detected || {}), language: lang };
        if (/^english$/i.test(lang)) r.detected.name_printed = '';
        rematchList.push(r);
      }
      if (priceMode === 'set') { r.price = price.toFixed(2); r.priceAuto = false; }
      if (priceMode === 'rule') { const s = suggestedPrice(r); if (s) { r.price = s.gbp.toFixed(2); r.priceAuto = true; } }
      if (priceMode === 'min') {
        const min = Number(settings.minPrice) || 0;
        const p = parseFloat(priceStr(r.price));
        if (min && (!p || p < min)) { r.price = min.toFixed(2); r.priceAuto = false; }
      }
      if ($('#b_ok').checked) r.status = 'ok';
      refreshDerived(r);
    }
    saveRows();
    closeSheet('bulkSheet');
    renderList();
    toast(`Updated ${list.length} card${list.length === 1 ? '' : 's'}`);
    for (const r of rematchList) await rematch(r); // one at a time, to go easy on Pulse
  }

  function removeBulk() {
    const list = selectedRows();
    if (!list.length || !confirm(`Remove ${list.length} card${list.length === 1 ? '' : 's'} from PokeLister?`)) return;
    rows = rows.filter((r) => !selected.has(r.id));
    selected.clear();
    saveRows();
    closeSheet('bulkSheet');
    renderList();
    renderBulkCount();
  }

  // ---------- quick review ----------

  let review = { ids: [], i: 0 };

  function openReview() {
    // the cards shown right now (so tap "4 to check" first to review just those)
    const ids = rows.filter((r) => !rowHidden(r)).map((r) => r.id);
    if (!ids.length) { toast('No cards to review'); return; }
    const firstCheck = rows.findIndex((r) => ids.includes(r.id) && r.status !== 'ok');
    review = { ids, i: Math.max(0, ids.indexOf(firstCheck >= 0 ? rows[firstCheck].id : ids[0])) };
    $('#review').hidden = false;
    document.body.classList.add('sheet-open');
    renderReview();
  }
  function closeReview() {
    $('#review').hidden = true;
    if (![...document.querySelectorAll('.sheet')].some((el) => !el.hidden)) document.body.classList.remove('sheet-open');
    renderList();
  }
  function reviewRow() {
    return rows.find((r) => r.id === review.ids[review.i]);
  }

  function renderReview() {
    review.ids = review.ids.filter((id) => rows.some((r) => r.id === id));
    if (!review.ids.length) { closeReview(); return; }
    review.i = Math.min(Math.max(0, review.i), review.ids.length - 1);
    const r = reviewRow();
    const c = chosen(r);
    const i = cardInfo(r);
    const sp = suggestedPrice(r);
    const big = r.frontUrl || r.photo;
    const checked = review.ids.filter((id) => (rows.find((x) => x.id === id) || {}).status === 'ok').length;
    $('#rvPos').textContent = `${review.i + 1} of ${review.ids.length} · ${checked} OK`;
    const condOpts = CONDITIONS.map((x) => `<option${x === r.condition ? ' selected' : ''}>${esc(x)}</option>`).join('');
    const finishOpts = FINISHES.map(([v, l]) => `<option value="${v}"${v === r.finish ? ' selected' : ''}>${esc(l)}</option>`).join('');
    $('#rvBody').innerHTML = `
      <div class="rv-photos">
        ${big ? `<img class="rv-main" src="${esc(big)}" alt="Front">` : '<div class="rv-main empty-img">No photo</div>'}
        <div class="rv-side">
          ${r.backPhoto ? `<img src="${r.backPhoto}" alt="Back"><span>Back</span>` : '<div class="empty-img">No back</div>'}
          ${c && c.image ? `<img src="${esc(c.image)}" alt="Database match"><span>Match</span>` : '<div class="empty-img">No match picture</div>'}
        </div>
      </div>
      <div class="rv-head">
        <strong>${esc(i.name || 'Unknown card')}</strong> <span class="muted">${esc(i.number)}</span>
        <span class="badge ${r.status === 'ok' ? 'ok' : 'warn'}">${r.status === 'ok' ? '✓ OK' : r.status === 'nomatch' ? 'No match' : 'Check'}</span>
      </div>
      <div class="muted small">${esc([i.set, i.rarity, i.language].filter(Boolean).join(' · '))}</div>
      ${r.status !== 'ok' && r.reasons && r.reasons.length ? `<p class="why-check">Why check: ${r.reasons.map(esc).join('; ')}.</p>` : ''}
      ${r.ebayItemId ? `<p class="listed">✓ Live on eBay · ${esc(r.ebayItemId)}</p>` : ''}
      ${r.ebayError && !r.ebayItemId ? `<p class="why-check">eBay didn't list it: ${esc(r.ebayError)}</p>` : ''}
      <label class="field"><span>Title <em class="count">${r.title.length}/80</em></span>
        <textarea data-rv="title" maxlength="80" rows="2">${esc(r.title)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Price £</span><input data-rv="price" inputmode="decimal" value="${esc(r.price)}" placeholder="0.00"></label>
        <label class="field"><span>Condition</span><select data-rv="condition">${condOpts}</select></label>
      </div>
      <p class="muted small">${sp ? esc(sp.source === 'pulse'
        ? `Rule: Pulse £${Number(sp.base).toFixed(2)} – ${Number(settings.pulseDiscount) || 0}% = £${sp.gbp.toFixed(2)}${sp.raisedToMin ? ' (your minimum)' : ''}`
        : `Rule price: £${sp.gbp.toFixed(2)}`) : 'No Pulse price – type one in.'}</p>
      <label class="field"><span>Finish</span><select data-rv="finish">${finishOpts}</select></label>`;
    $('#rvPrev').disabled = review.i === 0;
  }

  function reviewMove(step) {
    review.i += step;
    if (review.i >= review.ids.length) {
      toast('That was the last card');
      closeReview();
      return;
    }
    renderReview();
    $('#rvBody').scrollTop = 0;
  }

  // ---------- wiring ----------

  function bindTools() {
    $('#ebayBtn').addEventListener('click', () => openCheck('ebay'));
    document.addEventListener('click', (e) => {
      const close = e.target.closest('[data-close]');
      if (close) closeSheet(close.dataset.close);
    });
    $('#checkSheet').addEventListener('click', (e) => {
      const show = e.target.closest('[data-check-show]');
      if (show) { closeSheet('checkSheet'); if (filterKind !== show.dataset.checkShow) setFilter(show.dataset.checkShow); return; }
      if (e.target.closest('[data-check-settings]')) { closeSheet('checkSheet'); openSettings(); return; }
      if (e.target.closest('[data-check-test]')) { testOnEbay(); return; }
      if (e.target.closest('[data-check-go]')) checkGo();
    });

    $('#summary').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tool]');
      if (!t) return;
      if (t.dataset.tool === 'review') openReview();
      if (t.dataset.tool === 'select') setSelectMode(!selectMode);
      if (t.dataset.tool === 'clearListed') {
        const n = rows.filter((r) => r.ebayItemId).length;
        if (!n || !confirm(`Remove the ${n} card${n === 1 ? '' : 's'} already live on eBay from PokeLister?`)) return;
        rows = rows.filter((r) => !r.ebayItemId);
        if (filterKind === 'listed') filterKind = '';
        saveRows();
        renderList();
      }
    });

    $('#list').addEventListener('change', (e) => {
      const id = e.target.dataset && e.target.dataset.sel;
      if (!id) return;
      if (e.target.checked) selected.add(id); else selected.delete(id);
      e.target.closest('.card-row').classList.toggle('selected', e.target.checked);
      renderBulkCount();
    });
    $('#bulkAll').addEventListener('click', () => {
      for (const r of rows) if (!rowHidden(r)) selected.add(r.id);
      renderList();
      renderBulkCount();
    });
    $('#bulkNone').addEventListener('click', () => { selected.clear(); renderList(); renderBulkCount(); });
    $('#bulkDone').addEventListener('click', () => setSelectMode(false));
    $('#bulkEdit').addEventListener('click', openBulk);
    $('#bulkApply').addEventListener('click', applyBulk);
    $('#bulkRemove').addEventListener('click', removeBulk);

    $('#rvClose').addEventListener('click', closeReview);
    $('#rvPrev').addEventListener('click', () => reviewMove(-1));
    $('#rvSkip').addEventListener('click', () => reviewMove(1));
    $('#rvGood').addEventListener('click', () => {
      const r = reviewRow();
      if (r) { r.status = 'ok'; saveRows(); }
      reviewMove(1);
    });
    $('#rvEdit').addEventListener('click', () => {
      const r = reviewRow();
      closeReview();
      const el = r && document.querySelector(`.card-row[data-id="${r.id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#rvBody').addEventListener('change', (e) => {
      const f = e.target.dataset.rv;
      const r = reviewRow();
      if (!f || !r) return;
      if (f === 'title') { r.title = e.target.value.slice(0, 80); r.titleEdited = true; }
      if (f === 'price') { r.price = priceStr(e.target.value) || e.target.value.trim(); r.priceAuto = false; }
      if (f === 'condition') r.condition = e.target.value;
      if (f === 'finish') {
        r.finish = e.target.value;
        if (r.pulse && r.pulse.status === 'ok' && r.pulse.versions && r.pulse.versions.length > 1 && !r.pulse.userPicked) {
          usePulseVersion(r, rankPulseVersions(r.pulse.versions, r.finish, r.stamp)[0], false);
        }
        refreshDerived(r);
        renderReview();
      }
      saveRows();
    });

    $('#ebayConnect').addEventListener('click', connectEbay);
    $('#ebayCheckPolicies').addEventListener('click', checkPolicies);
    $('#ebayDisconnect').addEventListener('click', () => {
      if (!confirm('Disconnect eBay on this device?')) return;
      ebayConn = null;
      try { localStorage.removeItem(LS_EBAY); } catch (e) { /* ignore */ }
      renderEbaySettings();
      renderBottomBar();
    });

    // back from eBay's sign-in page
    if (/[?&]ebay=connected/.test(location.search)) {
      ebayConn = load(LS_EBAY, null);
      history.replaceState(null, '', location.pathname);
      setTimeout(() => toast('eBay connected ✓ – "List on eBay" is at the bottom'), 300);
    }
    renderBottomBar();
  }


  // ---------- settings ----------

  const SETTING_FIELDS = ['password', 'exportMode', 'categoryId', 'conditionId', 'skuPrefix', 'defaultQty',
    'defaultCondition', 'includeStockPhoto', 'autoPrice', 'priceSource', 'pulseDiscount',
    'eurToGbp', 'priceMultiplier', 'minPrice', 'descTemplate',
    'shippingPolicy', 'returnPolicy', 'paymentPolicy', 'postcode', 'location', 'bestOffer', 'photoBoost', 'autoLevels', 'photoContext',
    'specGame', 'specManufacturer', 'topLine'];

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
    renderEbaySettings();
    $('#ebayPolicyResult').textContent = '';
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
    settings.photoBoost = Math.min(30, Math.max(0, numOr(settings.photoBoost, 8)));
    settings.categoryId = String(settings.categoryId).trim() || DEFAULT_SETTINGS.categoryId;
    if (!String(settings.descTemplate).trim()) settings.descTemplate = DEFAULT_DESC;
    for (const k of ['shippingPolicy', 'returnPolicy', 'paymentPolicy', 'location', 'specGame', 'specManufacturer', 'topLine']) {
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
    ebayServer = !!h.ebaySet;
    renderBottomBar();
    renderEbaySettings();
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
  bindTools();
  renderList();
  renderNextHint();
  // Cards priced before the switch to Pulse's market price get re-checked once.
  const PULSE_PRICE_VERSION = 4;
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
