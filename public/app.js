'use strict';
// PokeLister frontend — vanilla JS, no build step.

(() => {
  const LS_ROWS = 'pokelister.rows.v1';
  const LS_SETTINGS = 'pokelister.settings.v1';
  const MAX_PARALLEL = 2;     // photos processed at once
  const MAX_EDGE = 1568;      // px sent to the AI (larger gets downscaled by the API anyway)
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
    eurToGbp: 0.85,
    priceMultiplier: 1,
    minPrice: 0.99,
    descTemplate: DEFAULT_DESC,
  };

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
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) {
      toast('Phone storage is full — export and clear some cards');
      return false;
    }
  }

  let settings = { ...DEFAULT_SETTINGS, ...load(LS_SETTINGS, {}) };
  let rows = load(LS_ROWS, []);
  let onlyCheck = false;
  const jobs = [];
  const searchResults = new Map(); // row id -> candidates from manual search
  let running = 0;
  let saveTimer = null;

  function saveRows() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store(LS_ROWS, rows), 250);
  }

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
    for (const f of files) jobs.push({ id: uid(), file: f, status: 'queued', thumb: '', error: '', count: 0 });
    renderJobs();
    pump();
  }

  function pump() {
    while (running < MAX_PARALLEL) {
      const job = jobs.find((j) => j.status === 'queued');
      if (!job) break;
      running++;
      runJob(job).finally(() => { running--; renderJobs(); pump(); });
    }
  }

  async function runJob(job) {
    job.status = 'working';
    renderJobs();
    try {
      if (!job.prepared) {
        job.prepared = await prepareFile(job.file);
        job.thumb = job.prepared.thumb;
        renderJobs();
      }
      const data = await api('/api/identify', { method: 'POST', body: JSON.stringify({ image: job.prepared.full }) });
      const cards = data.cards || [];
      if (!cards.length) throw new Error('No card found in this photo');
      const newRows = cards.map((c) => makeRow(c, job.thumb));
      rows = [...newRows, ...rows];
      job.status = 'done';
      job.count = cards.length;
      job.prepared = null;
      job.file = null;
      saveRows();
      renderList();
      setTimeout(() => {
        const i = jobs.indexOf(job);
        if (i >= 0) jobs.splice(i, 1);
        renderJobs();
      }, 4000);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      toast(e.message);
    }
  }

  function renderJobs() {
    const el = $('#jobs');
    el.hidden = !jobs.length;
    el.innerHTML = jobs.map((j) => {
      const label = j.status === 'queued' ? 'Waiting'
        : j.status === 'working' ? 'Reading…'
        : j.status === 'done' ? `✓ ${j.count} card${j.count === 1 ? '' : 's'}`
        : 'Tap to retry';
      return `<div class="job ${j.status}" data-job="${j.id}" title="${esc(j.error)}">
        ${j.thumb ? `<img src="${j.thumb}" alt="">` : ''}
        ${j.status === 'error' ? `<button class="job-x" data-x="${j.id}" aria-label="Dismiss">✕</button>` : ''}
        <span class="job-status">${label}</span></div>`;
    }).join('');
  }

  // ---------- rows ----------

  function normNumber(n) {
    const s = String(n || '').replace(/\s+/g, '').toUpperCase();
    return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s;
  }

  function chosen(r) {
    return r.chosen >= 0 ? r.candidates[r.chosen] : null;
  }

  function makeRow(result, thumb) {
    const d = result.detected || {};
    const candidates = result.candidates || [];
    const row = {
      id: uid(),
      photo: thumb,
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

  function suggestedPrice(r) {
    const c = chosen(r);
    if (!c) return null;
    const eur = r.finish === 'reverse holo' && c.cmReverseHoloTrend ? c.cmReverseHoloTrend : c.cmTrend;
    if (!eur) return null;
    const gbp = eur * Number(settings.eurToGbp || 0.85) * Number(settings.priceMultiplier || 1);
    return { eur, gbp: Math.max(Number(settings.minPrice || 0), gbp) };
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

  // ---------- export ----------

  function skuFor(r) {
    const i = cardInfo(r);
    const base = (i.id || 'X').replace(/[^A-Za-z0-9-]/g, '');
    return `${settings.skuPrefix || 'PKM'}-${base}-${r.id.slice(-4).toUpperCase()}`;
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

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function priceStr(p) {
    const n = parseFloat(String(p).replace(',', '.'));
    return isFinite(n) && n > 0 ? n.toFixed(2) : '';
  }

  function buildCSV(list) {
    const header = [
      'Action(SiteID=UK|Country=GB|Currency=GBP|Version=1193|CC=UTF-8)',
      'Custom label (SKU)', 'Category ID', 'Title', 'UPC', 'Price', 'Quantity',
      'Item photo URL', 'Condition ID', 'Description', 'Format',
    ];
    const lines = [
      '#INFO,Version=0.0.2,Template= eBay-draft-listings-template_GB,,,,,,,,',
      header.map(csvCell).join(','),
    ];
    for (const r of list) {
      const c = chosen(r);
      const photo = settings.includeStockPhoto && c && c.imageLarge ? c.imageLarge : '';
      lines.push([
        'Draft', skuFor(r), settings.categoryId, r.title, '', priceStr(r.price),
        parseInt(r.qty, 10) || 1, photo, settings.conditionId, buildDescription(r), 'FixedPrice',
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  function exportName() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `ebay-drafts-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
  }

  function readyToExport() {
    if (!rows.length) { toast('No cards to export'); return false; }
    const noPrice = rows.filter((r) => !priceStr(r.price)).length;
    const toCheck = rows.filter((r) => r.status !== 'ok').length;
    const issues = [];
    if (noPrice) issues.push(`${noPrice} without a price`);
    if (toCheck) issues.push(`${toCheck} still marked to check`);
    if (issues.length && !confirm(`${issues.join(' and ')}. Export anyway?`)) return false;
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

  // ---------- rendering ----------

  function candidateLabel(x) {
    const num = x.printedTotal && !/[A-Z]/i.test(x.number) ? `${x.number}/${x.printedTotal}` : x.number;
    return `${x.name} ${num} · ${x.setName}${x.rarity ? ' · ' + x.rarity : ''}`;
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
    const priceHint = sp
      ? `<div class="price-hint">Cardmarket trend €${sp.eur.toFixed(2)} ≈ £${sp.gbp.toFixed(2)}
           <button class="btn small" data-a="usePrice">Use</button></div>`
      : (c ? '<div class="price-hint">No Cardmarket price for this card</div>' : '');
    const notes = r.detected && r.detected.notes ? `<p class="notes">AI note: ${esc(r.detected.notes)}</p>` : '';
    const results = searchResults.get(r.id) || [];

    el.innerHTML = `
      <div class="row-imgs">
        ${r.photo ? `<img class="photo" src="${r.photo}" alt="Your photo">` : ''}
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
          <textarea data-f="title" maxlength="80" rows="2">${esc(r.title)}</textarea>
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
        <div class="row-actions">
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
    const total = rows.reduce((s, r) => s + (parseFloat(priceStr(r.price)) || 0) * (parseInt(r.qty, 10) || 1), 0);
    el.innerHTML = `
      <span><strong>${rows.length}</strong> listing${rows.length === 1 ? '' : 's'} (${qty} cards)</span>
      ${toCheck ? `<span class="warn">${toCheck} to check</span>` : ''}
      ${noPrice ? `<span class="warn">${noPrice} no price</span>` : ''}
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

    list.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      const r = f && rowFor(e.target);
      if (!r) return;
      if (f === 'title') {
        r.title = e.target.value;
        if (!r.titleEdited) {
          r.titleEdited = true;
          const actions = e.target.closest('.row-body').querySelector('.row-actions');
          if (!actions.querySelector('[data-a="retitle"]')) {
            actions.firstElementChild.insertAdjacentHTML('afterend', '<button class="btn small" data-a="retitle">Reset title</button>');
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
        refreshDerived(r);
        rerenderRow(r);
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

      if (a === 'remove') {
        rows = rows.filter((x) => x !== r);
        searchResults.delete(r.id);
        rowNode.remove();
        renderSummary();
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
        applyAutoPrice(r, true);
        const s = suggestedPrice(r);
        if (s) r.price = s.gbp.toFixed(2);
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
        searchResults.delete(r.id);
        refreshDerived(r);
        rerenderRow(r);
        saveRows();
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

  const SETTING_FIELDS = ['password', 'categoryId', 'conditionId', 'skuPrefix', 'defaultQty',
    'defaultCondition', 'includeStockPhoto', 'autoPrice', 'eurToGbp', 'priceMultiplier', 'minPrice', 'descTemplate'];

  function openSettings() {
    $('#s_defaultCondition').innerHTML = CONDITIONS.map((c) => `<option>${esc(c)}</option>`).join('');
    for (const k of SETTING_FIELDS) {
      const el = $('#s_' + k);
      if (el.type === 'checkbox') el.checked = !!settings[k];
      else el.value = settings[k];
    }
    $('#settings').hidden = false;
    checkServer();
  }

  function closeSettings() {
    $('#settings').hidden = true;
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
    settings.categoryId = String(settings.categoryId).trim() || DEFAULT_SETTINGS.categoryId;
    if (!String(settings.descTemplate).trim()) settings.descTemplate = DEFAULT_DESC;
  }

  async function saveSettings() {
    readSettingsForm();
    store(LS_SETTINGS, settings);
    try {
      await api('/api/auth');
      toast('Saved');
      closeSettings();
    } catch (e) {
      toast(e.message);
    }
  }

  async function checkServer() {
    const el = $('#serverStatus');
    el.textContent = 'Checking server…';
    try {
      const r = await fetch('/api/health');
      const h = await r.json();
      el.textContent = h.claudeKeySet
        ? `Server OK · AI model: ${h.model}`
        : 'Server is up, but ANTHROPIC_API_KEY is not set on Render';
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
  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (h.passwordRequired && !settings.password) openSettings();
  }).catch(() => {});

  // exposed for debugging in the browser console
  window.PokeLister = { buildCSV: () => buildCSV(rows), rows: () => rows, settings: () => settings };
})();
