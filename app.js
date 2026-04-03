'use strict';

// ── Theme colours for age rating badges ───────────────────────────────────────
const AGE_COLOURS = {
  'Kids':         '#4DB350',
  'Middle Grade': '#219CF2',
  'Young Adult':  '#9C8049',
  'Adult':        '#FF9900',
  'Mature (18+)': '#F54236',
};

// ── Age rating badge icons (SF Symbol equivalents as inline SVG) ─────────────
const AGE_ICONS = {
  'Kids':         `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`,
  'Middle Grade': `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1z"/></svg>`,
  'Young Adult':  `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
  'Adult':        `<svg width="12" height="10" viewBox="0 0 28 24" fill="currentColor"><path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05C16.19 13.89 17 15.02 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
  'Mature (18+)': `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
};
const HEART_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

// ── In-memory caches ──────────────────────────────────────────────────────────
const queryCache = {};
const isbnCache  = {};

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab       = 'scan';
let searchPending    = null;   // AbortController for in-flight search
let currentDetailId  = null;   // tracks which book's detail is open (prevents stale desc race)
let activeLookupId   = 0;      // incremented on every new ISBN lookup; stale async results check this

// ── Custom error to distinguish deliberate throws from network failures ────────
class FetchError extends Error {
  constructor(msg) { super(msg); this.name = 'FetchError'; }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  // Only clear search state when navigating away from the search tab.
  // Clearing on every switch (including scan → search after a failed barcode)
  // was wiping the search fields the user hadn't typed anything in yet, and
  // aborting any in-flight search request unnecessarily.
  if (currentTab === 'search' && tab !== 'search') clearSearch();
  currentTab = tab;
  document.querySelectorAll('.view:not(.modal)').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view-' + tab).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'scan') startScanner();
  else stopScanner();
}

// ── Scanner (ZBar WASM) ───────────────────────────────────────────────────────
// Uses @undecaf/zbar-wasm for EAN/UPC decoding via WebAssembly.
// ZBar's C++ core runs in WASM — significantly more accurate than Quagga2
// (pure-JS) for EAN-13 book barcodes on iOS Safari. No BarcodeDetector API
// dependency (unavailable/broken on iOS through at least iOS 18).

// Load ZBar WASM immediately on page load so it's ready by the time the user
// taps the camera button. Dynamic import() works in non-module scripts on
// iOS Safari 14.1+ (ES2020 support). The module fetches its own .wasm file
// from the same CDN origin (CORS: Access-Control-Allow-Origin: *).
let _scanFn = null;
// Use the inlined build — WASM binary is bundled in the .mjs file itself so
// there is no separate .wasm fetch that can silently fail on iOS Safari when
// the CORS/referrer policy for the CDN sub-resource differs from the module.
import('https://cdn.jsdelivr.net/npm/@undecaf/zbar-wasm@0.11.0/dist/inlined/index.mjs')
  .then(m => { _scanFn = m.scanImageData ?? m.default?.scanImageData ?? null; })
  .catch(() => {}); // non-fatal; scanner surfaces its own error if still null

let _videoEl    = null;  // <video> showing live camera feed
let _procCanvas = null;  // offscreen canvas for ZBar — reused each frame
let _procCtx    = null;
let _rafId      = null;  // requestAnimationFrame handle
let _scanning   = false; // true while the decode loop should run
let _frameReady = true;  // false while a ZBar decode is awaiting
let lastScanned = null;
let _readCounts = {};    // { isbn: score } — hit/miss sliding window

// Scan zone dimensions — must match CSS #scan-box width/height.
const SCAN_ZONE_W = 280;
const SCAN_ZONE_H = 120;

// Confirmation threshold. Score += 2 per hit, -= 1 per miss, confirm at >= 3.
// Equivalent to requiring 2 consecutive reads but tolerant of one missed frame.
const CONFIRM_SCORE = 3;

function startScanner() {
  const area     = document.getElementById('scanner-area');
  const fallback = document.getElementById('scan-fallback');
  area.classList.remove('hidden');
  fallback.classList.add('hidden');
  stopScanner();

  if (!navigator.mediaDevices?.getUserMedia) {
    showScanFallback('Camera not supported in this browser.');
    return;
  }

  // Reuse the video element across sessions — avoids a Safari bug where creating
  // a new <video> after a stream has been stopped sometimes blocks getUserMedia.
  if (!_videoEl) {
    _videoEl = document.createElement('video');
    _videoEl.setAttribute('autoplay', '');
    _videoEl.setAttribute('playsinline', ''); // required on iOS Safari
    _videoEl.setAttribute('muted', '');
    _videoEl.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;';
  }
  area.appendChild(_videoEl);

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
  })
  .then(stream => {
    _videoEl.srcObject = stream;
    return _videoEl.play();
  })
  .then(() => {
    _scanning   = true;
    _frameReady = true;
    lastScanned = null;
    _readCounts = {};
    _rafId = requestAnimationFrame(_scanLoop);
  })
  .catch(err => showScanFallback('Camera unavailable — ' + (err.message || err)));
}

function stopScanner() {
  _scanning = false;
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_videoEl?.srcObject) {
    _videoEl.srcObject.getTracks().forEach(t => t.stop());
    _videoEl.srcObject = null;
  }
  _videoEl?.remove();
  lastScanned = null;
  _readCounts = {};
  _frameReady = true;
}

// ── Frame decode loop ─────────────────────────────────────────────────────────
let _lastFrameTs = 0;
const FRAME_MS = 100; // decode at most every 100 ms (~10 fps)

function _scanLoop(ts) {
  if (!_scanning) return;

  // Throttle: only decode if ZBar is idle and enough time has passed
  if (ts - _lastFrameTs >= FRAME_MS && _frameReady && _scanFn &&
      _videoEl?.readyState >= 2 && _videoEl.videoWidth) {
    _lastFrameTs = ts;
    _frameReady  = false;
    _decodeFrame().finally(() => { _frameReady = true; });
  }

  _rafId = requestAnimationFrame(_scanLoop);
}

async function _decodeFrame() {
  const vw = _videoEl.videoWidth;
  const vh = _videoEl.videoHeight;
  if (!vw || !vh) return;

  // Map the visible scan zone to video pixel coordinates.
  // The video fills the area via object-fit:cover, so we must apply the same
  // scale factor the browser uses to crop the video to the area dimensions.
  const area  = document.getElementById('scanner-area');
  const aw    = area.clientWidth;
  const ah    = area.clientHeight;
  const scale = Math.max(vw / aw, vh / ah); // object-fit:cover scale

  // Crop with ×1.4 padding on width, ×1.8 on height so barcodes held slightly
  // outside the visible zone boundary still decode — ZBar is fast enough to
  // handle a moderately larger region without meaningful latency increase.
  const cropW = Math.min(Math.round(SCAN_ZONE_W * scale * 1.4), vw);
  const cropH = Math.min(Math.round(SCAN_ZONE_H * scale * 1.8), vh);
  const cropX = Math.max(0, Math.round(vw / 2 - cropW / 2));
  const cropY = Math.max(0, Math.round(vh / 2 - cropH / 2));

  if (!_procCanvas) {
    _procCanvas = document.createElement('canvas');
    _procCtx    = _procCanvas.getContext('2d', { willReadFrequently: true });
  }
  _procCanvas.width  = cropW;
  _procCanvas.height = cropH;
  _procCtx.drawImage(_videoEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  let symbols;
  try {
    symbols = await _scanFn(_procCtx.getImageData(0, 0, cropW, cropH));
  } catch { return; }

  if (!symbols?.length || !_scanning) {
    // No read this frame — decay all counts so one missed frame doesn't reset
    // a nearly-confirmed code (the ×1.8 height tolerance also helps here).
    for (const k in _readCounts) {
      _readCounts[k]--;
      if (_readCounts[k] <= 0) delete _readCounts[k];
    }
    document.getElementById('scan-box')?.classList.remove('locking');
    return;
  }

  // ZBar returns the raw decoded string; strip non-digit characters
  // (some symbol types include a checksum character or prefix text).
  const raw  = symbols[0].decode();
  const code = raw.replace(/[^0-9X]/gi, '').toUpperCase();

  if (!code || !isValidISBNCode(code)) {
    document.getElementById('scan-box')?.classList.remove('locking');
    return;
  }

  // Score this read — +2 per hit, capped at 5 to avoid slow drift
  _readCounts[code] = Math.min((_readCounts[code] || 0) + 2, 5);

  if (_readCounts[code] >= CONFIRM_SCORE && code !== lastScanned) {
    lastScanned = code;
    _readCounts = {};
    _scanning   = false; // pause decode loop while lookup runs
    cancelAnimationFrame(_rafId); _rafId = null;
    document.getElementById('scan-box')?.classList.remove('locking');
    flashScanBox();
    handleScannedISBN(code);
  } else {
    // First hit — show a subtle "locking on" glow so the user knows to hold still
    document.getElementById('scan-box')?.classList.add('locking');
  }
}

// ── ISBN validation ───────────────────────────────────────────────────────────

// Returns true only for codes with a valid EAN-13 or ISBN-10 check digit.
function isValidISBNCode(isbn) {
  if (isbn.length === 13) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === parseInt(isbn[12]);
  }
  if (isbn.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(isbn[i]) * (10 - i);
    const check = isbn[9] === 'X' ? 10 : parseInt(isbn[9]);
    return (sum + check) % 11 === 0;
  }
  return false;
}

function showScanFallback(msg) {
  const fallback = document.getElementById('scan-fallback');
  const area     = document.getElementById('scanner-area');
  area.classList.add('hidden');
  fallback.classList.remove('hidden');
  const p = fallback.querySelector('p');
  if (p) p.textContent = msg;
}

let _flashTimer = null;
function flashScanBox() {
  const box   = document.getElementById('scan-box');
  const flash = document.getElementById('scan-flash');
  if (box)   box.classList.add('detected');
  if (flash) flash.classList.add('show');
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => {
    if (box)   box.classList.remove('detected');
    if (flash) flash.classList.remove('show');
  }, 800);
}

async function handleScannedISBN(isbn) {
  // Capture this lookup's ID. If the user retries or navigates away before we
  // finish, activeLookupId will have been incremented and our result is discarded.
  const lookupId = ++activeLookupId;

  stopScanner(); // pause scanning while we look up the book

  const resultEl = document.getElementById('scan-result');
  resultEl.innerHTML = `
    <div class="scan-status-card">
      <div class="loading-cluster">
        <div class="wisp-orb"></div><div class="wisp-orb"></div>
        <div class="wisp-orb"></div><div class="wisp-orb"></div>
      </div>
      <p class="scan-status-title">Searching…</p>
      <p class="scan-status-sub">Looking up barcode in the catalogue</p>
    </div>`;
  resultEl.classList.remove('hidden');

  try {
    const books = await searchByISBN(isbn);
    if (activeLookupId !== lookupId) return; // user moved on — discard stale result
    resultEl.classList.add('hidden');
    if (books.length > 0) openDetail(books[0]);
  } catch (e) {
    if (activeLookupId !== lookupId) return; // user moved on — discard stale error
    // Distinguish a genuine "not found" from a network/server error
    const isNetworkError = e.name === 'FetchError' &&
      (e.message.includes('Network') || e.message.includes('respond') || e.message.includes('Server'));
    const title   = isNetworkError ? 'Connection problem'   : 'Book not found';
    const message = isNetworkError
      ? 'Could not reach the catalogue. Check your connection and try again.'
      : 'No match for this barcode in the catalogue. Try searching by title or author.';
    resultEl.innerHTML = `
      <div class="scan-status-card">
        <p style="font-size:28px">${isNetworkError ? '⚠️' : '📚'}</p>
        <p class="scan-status-title">${title}</p>
        <p class="scan-status-sub">${message}</p>
        <div class="scan-status-actions">
          ${isNetworkError ? '' : '<button class="btn-primary" onclick="scanGoToSearch()">Search by title / author</button>'}
          <button class="read-more-btn" onclick="scanRetry()">${isNetworkError ? 'Try again' : 'Scan a different barcode'}</button>
          <button class="read-more-btn" onclick="showManualISBN()">Type ISBN manually</button>
        </div>
      </div>`;
    lastScanned = null;
  }
}

function scanGoToSearch() {
  activeLookupId++; // cancel any in-flight lookup
  document.getElementById('scan-result').classList.add('hidden');
  switchTab('search');
}

function scanRetry() {
  activeLookupId++; // cancel any in-flight lookup
  document.getElementById('scan-result').classList.add('hidden');
  startScanner();
}

function showManualISBN() {
  stopScanner();
  const resultEl = document.getElementById('scan-result');
  resultEl.innerHTML = `
    <div class="scan-status-card">
      <p style="font-size:26px">⌨️</p>
      <p class="scan-status-title">Enter ISBN</p>
      <p class="scan-status-sub">Type or paste the 10 or 13‑digit ISBN from the back of the book.</p>
      <input id="manual-isbn-input" type="text" inputmode="numeric"
        placeholder="e.g. 9781649376565"
        autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
        onkeydown="if(event.key==='Enter')submitManualISBN()"
        style="width:100%;padding:12px 14px;border-radius:10px;border:1px solid #9b804a60;background:#132A1F;color:#F2EDE3;font-size:16px;margin-top:8px;outline:none;text-align:center;letter-spacing:1px;">
      <div class="scan-status-actions" style="margin-top:4px">
        <button class="btn-primary" onclick="submitManualISBN()">Look Up</button>
        <button class="read-more-btn" onclick="scanRetry()">Back to scanner</button>
      </div>
    </div>`;
  resultEl.classList.remove('hidden');
  // Small delay ensures the element is in the DOM before focusing
  setTimeout(() => document.getElementById('manual-isbn-input')?.focus(), 60);
}

function submitManualISBN() {
  const input = document.getElementById('manual-isbn-input');
  if (!input) return;
  // Strip hyphens, spaces, and any non-digit except trailing X for ISBN-10
  const raw  = input.value.trim();
  const isbn = raw.replace(/[-\s]/g, '').toUpperCase();
  const digits = isbn.replace(/[^0-9X]/g, '');
  if (digits.length < 10) {
    input.style.borderColor = '#F54236';
    input.focus();
    return;
  }
  document.getElementById('scan-result').classList.add('hidden');
  handleScannedISBN(digits);
}

// ── Search form logic ─────────────────────────────────────────────────────────
function onFieldInput(input) {
  const clearBtn = input.nextElementSibling;
  if (clearBtn) clearBtn.classList.toggle('hidden', input.value === '');
  updateSearchBtn();
}

function clearField(id) {
  const el = document.getElementById(id);
  el.value = '';
  const clearBtn = el.nextElementSibling;
  if (clearBtn) clearBtn.classList.add('hidden');
  updateSearchBtn();
  el.focus();
}

function onFieldKey(e, field) {
  if (e.key === 'Enter') {
    if (field === 'title')  document.getElementById('input-author').focus();
    else if (field === 'author') document.getElementById('input-isbn').focus();
    else performSearch();
  }
}

function updateSearchBtn() {
  const t = document.getElementById('input-title').value.trim();
  const a = document.getElementById('input-author').value.trim();
  const i = document.getElementById('input-isbn').value.trim();
  const hasInput = t || a || i;
  document.getElementById('search-btn').disabled = !hasInput;
  const clearBtn = document.getElementById('clear-btn');
  // Show the clear button when there's input OR when results are displayed.
  // Using currentResults.length is reliable; innerHTML === '' was fragile
  // because the placeholder HTML made it always non-empty.
  clearBtn.classList.toggle('hidden', !hasInput && !currentResults.length);
}

function clearSearch() {
  if (searchPending) { searchPending.abort(); searchPending = null; }
  ['input-title','input-author','input-isbn'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    const cb = el.nextElementSibling;
    if (cb) cb.classList.add('hidden');
  });
  renderPlaceholder();
  document.getElementById('search-btn').disabled = true;
  document.getElementById('clear-btn').classList.add('hidden');
  document.getElementById('search-label').textContent = 'Search Books';
  document.getElementById('search-icon').style.display = '';
}

async function performSearch() {
  const t    = document.getElementById('input-title').value.trim();
  const a    = document.getElementById('input-author').value.trim();
  const isbn = document.getElementById('input-isbn').value.replace(/\D/g, '');

  if (!t && !a && !isbn) return;

  // Cancel any in-flight request
  if (searchPending) { searchPending.abort(); searchPending = null; }

  // Dismiss keyboard
  document.activeElement?.blur();

  setSearchLoading(true);

  try {
    let books;
    if (isbn) {
      books = await searchByISBN(isbn);
    } else {
      books = await searchByQuery(t, a);
    }
    renderResults(books);
  } catch (e) {
    if (e.name === 'AbortError') return;
    renderError(e.message || 'Something went wrong.');
  } finally {
    setSearchLoading(false);
  }
}

function setSearchLoading(on) {
  const btn   = document.getElementById('search-btn');
  const label = document.getElementById('search-label');
  const icon  = document.getElementById('search-icon');
  btn.disabled = on;
  label.textContent = on ? 'Searching…' : 'Search Books';
  icon.style.display = on ? 'none' : '';
  if (on) {
    const spinner = document.createElement('div');
    spinner.className = 'spinner'; spinner.id = 'search-spinner';
    btn.insertBefore(spinner, label);
    document.getElementById('search-results').innerHTML = `
      <div class="state-view">
        <div class="loading-cluster">
          <div class="wisp-orb"></div><div class="wisp-orb"></div>
          <div class="wisp-orb"></div><div class="wisp-orb"></div>
        </div>
        <p style="font-family:Georgia,serif;font-style:italic;margin-top:16px;font-size:15px">The wisps are searching…</p>
        <p style="font-size:12px;margin-top:4px;color:var(--gold);opacity:0.65">consulting the ancient tomes</p>
      </div>`;
  } else {
    document.getElementById('search-spinner')?.remove();
  }
}

function renderResults(books) {
  currentResults = books;
  const el = document.getElementById('search-results');
  if (!books.length) {
    const BOOK_ICON = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
    el.innerHTML = `<div class="state-view">
      <div class="state-icon-wrap">
        <div class="state-orb"></div>
        <div class="state-orb state-orb-sm" style="left:60px;top:10px;background:radial-gradient(circle,#59b88533 0%,#59b8850a 50%,transparent 70%);box-shadow:none"></div>
        <span class="state-icon" style="color:var(--gold);opacity:0.7">${BOOK_ICON}</span>
      </div>
      <h2>The wisps found nothing</h2>
      <p>Try a different title, author, or ISBN</p></div>`;
    return;
  }
  let html = `<div class="results-label"><span class="diamond">✦</span>
    ${books.length} ${books.length === 1 ? 'tome' : 'tomes'} revealed</div>`;
  books.forEach((book, i) => {
    html += bookCardHTML(book, i);
  });
  el.innerHTML = html;
  document.getElementById('clear-btn').classList.remove('hidden');

  // Background: enrich any special editions so their age/romance badges reflect
  // the richer description and categories from the canonical edition.
  // Runs after the initial render so it never delays showing results.
  books.forEach((book, i) => {
    const lc = book.title.toLowerCase();
    if (!EDITION_WORD_RE.test(lc) || !lc.includes('edition') || book.description) return;
    enrichSpecialEdition(book).then(enriched => {
      if (enriched === book) return; // nothing changed
      currentResults[i] = enriched; // update so detail view gets richer data on tap
      // Patch the badge row in the already-rendered card
      const card = document.querySelector(`[data-card-idx="${i}"]`);
      if (!card) return;
      const badgesEl = card.querySelector('.book-badges');
      if (!badgesEl) return;
      const newAge    = ageRating(enriched);
      const newColour = AGE_COLOURS[newAge] || '#9B804A';
      const newIcon   = AGE_ICONS[newAge] || '';
      const newRomance = hasRomanticThemes(enriched)
        ? `<span class="badge badge-romance">${HEART_SVG}Romance</span>` : '';
      badgesEl.innerHTML = `<span class="badge badge-age" style="--badge-color:${newColour}">${newIcon}${escHtml(newAge)}</span>${newRomance}`;
    });
  });

  // Background: fetch descriptions for books that don't yet show a romance badge
  // (categories alone often lack romance signals — description keywords are needed).
  // Only fires for books with a /works/ key; capped at 5 per render to limit traffic.
  let descFetchCount = 0;
  books.forEach((book, i) => {
    if (descFetchCount >= 5) return;
    if (hasRomanticThemes(book)) return; // already showing romance — skip
    if (!book.id?.startsWith('/works/')) return;
    descFetchCount++;
    fetchDescription(book.id).then(desc => {
      if (!desc) return;
      const enriched = Object.assign({}, currentResults[i], { description: desc });
      if (!hasRomanticThemes(enriched)) return; // description didn't add romance
      currentResults[i] = enriched;
      const card = document.querySelector(`[data-card-idx="${i}"]`);
      if (!card) return;
      const badgesEl = card.querySelector('.book-badges');
      if (!badgesEl) return;
      const newAge    = ageRating(enriched);
      const newColour = AGE_COLOURS[newAge] || '#9B804A';
      const newIcon   = AGE_ICONS[newAge] || '';
      badgesEl.innerHTML = `<span class="badge badge-age" style="--badge-color:${newColour}">${newIcon}${escHtml(newAge)}</span><span class="badge badge-romance">${HEART_SVG}Romance</span>`;
    });
  });
}

function renderPlaceholder() {
  currentResults = [];
  const LOGO = 'https://www.wispbookshop.com/uploads/b/83d087e4aa8e2de4459401d9bcf103ff53ee9d453751c4902ece251eb7bbef58/Wisp-Bookshop-Logo-3_1752237750.png';
  document.getElementById('search-results').innerHTML = `
    <div class="search-placeholder">
      <div class="ph-float-wisps" aria-hidden="true">
        <div class="ph-wisp ph-tl"></div>
        <div class="ph-wisp ph-tr"></div>
        <div class="ph-wisp ph-bl"></div>
        <div class="ph-wisp ph-br"></div>
      </div>
      <div class="ph-logo-wrap">
        <div class="ph-orb-lg"></div>
        <div class="ph-orb-sm"></div>
        <img class="ph-logo" src="${LOGO}" alt="Wisp Bookshop" loading="lazy">
      </div>
      <h2 class="ph-title">Find Your Next Read</h2>
      <p class="ph-sub">Search by title, author, ISBN,<br>or any combination</p>
      <p class="ph-tagline">because reality is overrated</p>
    </div>`;
}

function renderError(msg) {
  const WARN = `<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`;
  document.getElementById('search-results').innerHTML = `
    <div class="state-view">
      <div class="state-icon-wrap">
        <div class="state-orb" style="background:radial-gradient(circle,#FF990033 0%,#FF990011 50%,transparent 70%);box-shadow:0 0 33px #FF990022"></div>
        <span class="state-icon" style="color:var(--gold)">${WARN}</span>
      </div>
      <h2>${escHtml(msg)}</h2>
      <button class="btn-primary" style="margin-top:16px;max-width:160px" onclick="performSearch()">Try Again</button>
    </div>`;
}

function bookCardHTML(book, idx) {
  const age    = ageRating(book);
  const colour = AGE_COLOURS[age] || '#9B804A';
  const thumb  = book.coverURL
    ? `<img src="${escHtml(book.coverURL)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=thumb-placeholder>📖</span>'">`
    : `<span class="thumb-placeholder">📖</span>`;
  const ageIcon = AGE_ICONS[age] || '';
  const romance = hasRomanticThemes(book)
    ? `<span class="badge badge-romance">${HEART_SVG}Romance</span>` : '';

  return `<div class="book-card" data-card-idx="${idx}" onclick="openBookByIndex(${idx})" role="button" tabindex="0"
    onkeydown="if(event.key==='Enter')openBookByIndex(${idx})">
    <div class="book-thumb">${thumb}</div>
    <div class="book-info">
      <div class="book-title">${escHtml(book.title)}</div>
      <div class="book-author">${escHtml(book.authors?.join(', ') || 'Unknown Author')}</div>
      <div class="book-badges">
        <span class="badge badge-age" style="--badge-color:${colour}">${ageIcon}${escHtml(age)}</span>
        ${romance}
      </div>
    </div>
    <span class="chevron">›</span>
  </div>`;
}

// Store current results for tap-to-detail
let currentResults = [];
function openBookByIndex(i) { openDetail(currentResults[i]); }

// ── Detail view ───────────────────────────────────────────────────────────────
function openDetail(book) {
  currentResults  = currentResults.length ? currentResults : [book];
  currentDetailId = book.id;   // guard against stale description race conditions
  descExpanded    = false;     // always start with description collapsed

  const detail = document.getElementById('view-detail');
  document.getElementById('detail-content').innerHTML = detailHTML(book);
  detail.classList.remove('hidden');

  // Precompute ratings without description — used to detect change after fetch
  const baseAge     = ageRating(book);
  const baseRomance = hasRomanticThemes(book);

  // Applies a freshly-loaded description to the open detail view.
  // Updates the text element, reveals the section, and re-evaluates
  // age/romance ratings so they reflect the description text.
  const applyDesc = desc => {
    if (!desc || book.id !== currentDetailId) return;
    const el = document.getElementById('detail-desc-text');
    if (el) {
      el.dataset.full = desc;
      el.textContent = desc.length > 400 ? desc.slice(0, 400) + '\u2026' : desc;
      const section = document.getElementById('detail-desc-section');
      if (section) section.classList.remove('hidden');
      const btn = document.getElementById('detail-desc-toggle');
      if (btn) btn.style.display = desc.length <= 400 ? 'none' : '';
    }
    const bookWithDesc = Object.assign({}, book, { description: desc });
    const newAge     = ageRating(bookWithDesc);
    const newRomance = hasRomanticThemes(bookWithDesc);
    if (newAge !== baseAge || newRomance !== baseRomance) {
      const row = document.getElementById('detail-ratings-row');
      if (row) {
        const colour = AGE_COLOURS[newAge] || '#9B804A';
        const romanceCard = newRomance ? `
          <div class="rating-card">
            <span class="rating-icon" style="color:#D16B8F">♥</span>
            <span class="rating-label">Romance</span>
            <span class="rating-sub">Romantic themes</span>
          </div>` : '';
        row.innerHTML = `
          <div class="rating-card">
            <span class="rating-icon" style="color:${colour}">${ageIcon(newAge)}</span>
            <span class="rating-label">${escHtml(newAge)}</span>
            <span class="rating-sub">${escHtml(ageRange(newAge))}</span>
          </div>
          ${romanceCard}`;
      }
    }
  };

  // Lazy-load description in the background (non-blocking).
  // Phase 1: try the direct works endpoint (descWorksId for enriched books,
  //          book.id for regular lookups).
  // Phase 2: if that returns nothing AND the title has edition qualifiers,
  //          run enrichSpecialEdition to locate the canonical edition and
  //          pull its description. This handles books opened via title/author
  //          search where enrichment hasn't run yet.
  (async () => {
    const descKey = book.descWorksId ?? book.id;
    let desc = descKey?.startsWith('/works/')
      ? await fetchDescription(descKey)
      : null;

    if (!desc) {
      // Fallback: enrich special editions whose description lives on a
      // different works record (e.g. deluxe edition → main edition).
      const lc = book.title.toLowerCase();
      if (EDITION_WORD_RE.test(lc) && lc.includes('edition')) {
        const enriched = await enrichSpecialEdition(book);
        desc = enriched.description ?? null;
      }
    }

    applyDesc(desc);
  })();
}

function closeDetail() {
  document.getElementById('view-detail').classList.add('hidden');
  currentDetailId = null;
  lastScanned = null;
  // Call startScanner synchronously — iOS requires getUserMedia to be invoked
  // within the same user-gesture call stack as the button tap. A setTimeout
  // breaks that context and silently blocks the camera on Safari.
  if (currentTab === 'scan') startScanner();
}

function detailHTML(book) {
  const age    = ageRating(book);
  const colour = AGE_COLOURS[age] || '#9B804A';
  const romance = hasRomanticThemes(book);
  const cover = book.coverURL
    ? `<img src="${escHtml(book.coverURL)}" alt="" onerror="this.parentElement.innerHTML='<span class=detail-cover-placeholder>📖</span>'">`
    : `<span class="detail-cover-placeholder">📖</span>`;

  const rows = [];
  if (book.pageCount)    rows.push(['Pages', book.pageCount]);
  if (book.publisher)    rows.push(['Publisher', book.publisher]);
  if (book.publishedDate) rows.push(['Published', book.publishedDate]);

  const rowsHTML = rows.map(([l,v]) => `
    <div class="detail-row">
      <span class="detail-row-label">${escHtml(l)}</span>
      <span class="detail-row-value">${escHtml(String(v))}</span>
    </div>`).join('');

  const cats = (book.categories || []).slice(0, 20);
  const catsHTML = cats.length ? cats.map(c =>
    `<span class="category-chip">${escHtml(c)}</span>`).join('') : '';

  const romanceCard = romance ? `
    <div class="rating-card">
      <span class="rating-icon" style="color:#D16B8F">♥</span>
      <span class="rating-label">Romance</span>
      <span class="rating-sub">Romantic themes</span>
    </div>` : '';

  // Pre-populate description if already available (e.g. fetched during enrichment).
  // The description section starts visible when content exists; the lazy-load in
  // openDetail will update it later if a richer version is found via /works/ id.
  const preDesc       = book.description || '';
  const preDescTrunc  = preDesc.length > 400 ? preDesc.slice(0, 400) + '\u2026' : preDesc;
  const descHidden    = preDesc ? '' : 'hidden';
  const toggleHidden  = !preDesc || preDesc.length <= 400 ? 'style="display:none"' : '';

  return `
    <div class="detail-header">
      <div class="detail-cover-wrap">${cover}</div>
    </div>
    <div class="detail-body">
      <div>
        <div class="detail-title">${escHtml(book.title)}</div>
        <div class="detail-author">by ${escHtml(book.authors?.join(', ') || 'Unknown Author')}</div>
        ${book.publishedDate ? `<div class="detail-year">${escHtml(String(book.publishedDate).slice(0,4))}</div>` : ''}
      </div>
      <hr class="detail-divider">
      <div class="ratings-row" id="detail-ratings-row">
        <div class="rating-card">
          <span class="rating-icon" style="color:${colour}">${ageIcon(age)}</span>
          <span class="rating-label">${escHtml(age)}</span>
          <span class="rating-sub">${escHtml(ageRange(age))}</span>
        </div>
        ${romanceCard}
      </div>
      <div id="detail-desc-section" class="${descHidden}">
        <div class="section-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
          Description
        </div>
        <p class="detail-description" id="detail-desc-text"
           data-full="${escHtml(preDesc)}">${escHtml(preDescTrunc)}</p>
        <button class="read-more-btn" id="detail-desc-toggle"
          onclick="toggleDesc()" ${toggleHidden}>Read more</button>
      </div>
      ${rowsHTML ? `
        <div>
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Details
          </div>
          <div class="details-table">${rowsHTML}</div>
        </div>` : ''}
      ${catsHTML ? `
        <div>
          <div class="section-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
            Categories
          </div>
          <div class="categories-flow">${catsHTML}</div>
        </div>` : ''}
    </div>`;
}

let descExpanded = false;
function toggleDesc() {
  const el  = document.getElementById('detail-desc-text');
  const btn = document.getElementById('detail-desc-toggle');
  if (!el || !btn) return;
  descExpanded = !descExpanded;
  if (descExpanded) {
    el.textContent = el.dataset.full;
    btn.textContent = 'Show less';
  } else {
    el.textContent = el.dataset.full.slice(0, 400) + '…';
    btn.textContent = 'Read more';
  }
}

// ── Info modal ────────────────────────────────────────────────────────────────
let _infoCached = false;
function showInfo() {
  // Build the info HTML once and inject it — it's static content so rebuilding
  // on every open is wasteful and can cause a layout flash.
  if (!_infoCached) {
    document.getElementById('info-content').innerHTML = infoHTML();
    _infoCached = true;
  }
  document.getElementById('view-info').classList.remove('hidden');
}
function closeInfo() {
  document.getElementById('view-info').classList.add('hidden');
}

function infoHTML() {
  return `
    <div class="info-header">
      <img class="info-logo" src="https://www.wispbookshop.com/uploads/b/83d087e4aa8e2de4459401d9bcf103ff53ee9d453751c4902ece251eb7bbef58/Wisp-Bookshop-Logo-3_1752237750.png" alt="Wisp Bookshop">
      <h1>Wisp Scanner</h1>
      <p>A book lookup tool for Wisp Bookshop</p>
    </div>
    <hr class="info-divider">
    <div class="info-section">
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        Where the book data comes from
      </h2>
      <p>Open Library is a free, non-profit book catalogue run by the Internet Archive. It contains records for millions of books contributed by libraries, publishers, and readers around the world.<br><br>
      When you scan a barcode or search by title or author, Wisp Scanner queries Open Library in real time and displays whatever information is available for that book. Because the catalogue is community-maintained, the completeness of any given record — cover image, page count, publisher, subject tags — can vary.</p>
    </div>
    <hr class="info-divider">
    <div class="info-section">
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        How age ratings work
      </h2>
      <p>Age ratings are estimated automatically by reading the subject tags attached to each book in Open Library. These tags — things like "Young Adult Fiction," "Picture Books," or "Erotica" — are added by librarians and contributors and give a general sense of who a book is intended for.<br><br>
      <strong style="color:var(--gold)">Important limitation:</strong> subject tagging on Open Library is not always complete or accurate. Some editions of a book carry different tags than others, and tags are sometimes missing entirely. As a result, a book may receive a younger rating than is actually appropriate. These ratings are a helpful starting point, not a guarantee — always cross-reference with other sources before recommending a book to a younger reader.</p>
    </div>
    <hr class="info-divider">
    <div class="info-section">
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        How the romantic themes flag works
      </h2>
      <p>The romantic themes indicator appears when a book's subject tags or description contain words associated with romance — things like "romance," "love stories," "romantasy," "slow burn," or "enemies to lovers."<br><br>
      This flag is not a measure of how explicit the content is. A book can carry the romantic themes flag at any age rating, from Young Adult to Mature. Books with sparse or missing tags may not show the flag even when romantic themes are present.</p>
    </div>
    <hr class="info-divider">
    <p class="attribution">Book data is sourced from Open Library (openlibrary.org), a project of the Internet Archive, and is made available under open licensing. Cover images are served from the Open Library Covers API.</p>`;
}

// ── Age rating logic (ported from BookModel.swift) ────────────────────────────
const ROMANCE_SIGNALS = [
  'romance','romantic','love stories','love story','romantasy',
  'chick lit',"women's fiction",'womens fiction','boys love','bl manga',
  'love & romance','love and romance','romantic suspense','romantic thriller',
  'romantic comedy','adult romance',
];
const DESC_ROMANCE_SIGNALS = [
  'romance','romantic','love story','love interest','falling in love',
  'enemies to lovers','second chance romance','slow burn','fated mates',
  'love triangle','fake dating','forced proximity','happily ever after',
  'swoon','forbidden love','will they won\'t they',
  'hea','dark romance','newfound love',
  // dark romance / romantasy / spicy book community signals
  'steamy','spicy','sexual tension','romantic tension','love affair',
  'instalove','insta-love','romantically','their chemistry',
  'fell in love','falls in love','fall in love',
  'attraction between','drawn to each other','heart races',
];
const EROTICA_TERMS = [
  'erotica','erotic fiction','erotic romance','erotic literature',
  'erotic fantasy','erotic science fiction','adult erotica',
  'sexually explicit','explicit sexual',
];
const EXPLICIT_ROMANCE = ['dark romance','steamy romance','explicit romance','erotic romance novels'];
const EXPLICIT_DESC    = ['explicit sex','graphic sexual','explicit sexual content','sexually explicit','graphic sex scenes'];
const KIDS_SUBJECTS    = [
  'picture books','picture book','board books','board book','baby books',
  'toddler books','toddler','early readers','early reader','easy readers',
  'easy reader','beginning readers','beginning reader','leveled readers',
  'leveled reader','preschool','kindergarten',"children's picture books","children's poetry",
];
const MG_SUBJECTS = [
  'middle grade','middle-grade','chapter books','chapter book',
  'middle school fiction','middle school','school stories',
];
const JUVENILE_TERMS = [
  'juvenile fiction','juvenile nonfiction','juvenile literature',
  'juvenile fantasy fiction','juvenile science fiction','juvenile mystery',
  'juvenile adventure','juvenile',"children's fiction","children's literature","children's novels",
];
const YA_SUBJECTS = [
  'young adult fiction','young adult fantasy fiction','young adult fantasy',
  'young adult science fiction','young adult sci-fi','young adult romance',
  'young adult romantic fiction','young adult mystery','young adult thriller',
  'young adult horror','young adult paranormal','young adult dystopian',
  'young adult nonfiction','young adult literature','young adult',
];
const TEEN_SUBJECTS = [
  'teen fiction','teen fantasy','teen romance','teen science fiction',
  'teen mystery','teen thriller','teen lit','teen literature',
  'teenage fiction','teenage romance','teenage',
];
const COMING_OF_AGE = ['coming-of-age fiction','coming of age fiction','coming-of-age','coming of age'];
const GENRE_TAGS    = ['fantasy','science fiction','romance','thriller','mystery','horror','adventure'];

function hasRomanticThemes(book) {
  const cats = (book.categories || []).join(' ').toLowerCase();
  if (ROMANCE_SIGNALS.some(s => cats.includes(s))) return true;
  const desc = (book.description || '').toLowerCase();
  if (desc && DESC_ROMANCE_SIGNALS.some(s => desc.includes(s))) return true;
  return false;
}

function ageRating(book) {
  const cats = (book.categories || []).join(' ').toLowerCase();
  const desc = (book.description || '').toLowerCase();
  const c = s => cats.includes(s);
  const d = s => desc.includes(s);

  if (book.maturityRating === 'MATURE') return 'Mature (18+)';
  if (EROTICA_TERMS.some(c))    return 'Mature (18+)';
  if (EXPLICIT_ROMANCE.some(c)) return 'Mature (18+)';
  if (EXPLICIT_ROMANCE.some(d)) return 'Mature (18+)';
  if (EXPLICIT_DESC.some(d))    return 'Mature (18+)';

  // Category-level romance guard — prevents Kids/MG being assigned for books
  // tagged as romance. Description-based romance is checked via hasRomanticThemes
  // at the end, where we can bump the already-computed rating.
  const catRomance = ROMANCE_SIGNALS.some(s => cats.includes(s));

  let rating = 'Adult';
  if      (KIDS_SUBJECTS.some(c) && !catRomance)                                           rating = 'Kids';
  else if ((c("children's") || c('childrens')) && !c('young adult') && !c('teen') && !catRomance) rating = 'Kids';
  else if (MG_SUBJECTS.some(c) && !catRomance)                                             rating = 'Middle Grade';
  else if (JUVENILE_TERMS.some(c) && !c('young adult') && !c('teen') && !catRomance)      rating = 'Middle Grade';
  else if (YA_SUBJECTS.some(c))                                                            rating = 'Young Adult';
  else if (TEEN_SUBJECTS.some(c))                                                          rating = 'Young Adult';
  else if (COMING_OF_AGE.some(c) && GENRE_TAGS.some(c))                                   rating = 'Young Adult';
  else if (c('dystopian fiction') && !c('adult fiction'))                                  rating = 'Young Adult';

  // Bump Kids/MG to Young Adult when romantic themes are present — checks both
  // categories AND description, so description-only signals (e.g. "steamy",
  // "enemies to lovers") correctly raise the floor to Young Adult.
  if ((rating === 'Kids' || rating === 'Middle Grade') && hasRomanticThemes(book)) {
    return 'Young Adult';
  }
  return rating;
}

function ageIcon(age) {
  return { 'Kids':'★', 'Middle Grade':'📖', 'Young Adult':'👤', 'Adult':'👥', 'Mature (18+)':'⚠' }[age] || '👥';
}
function ageRange(age) {
  return {
    'Kids':'Ages 0–8', 'Middle Grade':'Ages 8–12',
    'Young Adult':'Ages 13–17', 'Adult':'Ages 18+', 'Mature (18+)':'Ages 18+ · Explicit'
  }[age] || 'Ages 18+';
}

// ── API calls ─────────────────────────────────────────────────────────────────
const SEARCH_BASE  = 'https://openlibrary.org/search.json';
const BOOKS_BASE   = 'https://openlibrary.org/api/books';
const WORKS_BASE   = 'https://openlibrary.org';
const SEARCH_FIELDS = 'key,title,author_name,subject,cover_i,number_of_pages_median,first_publish_year,publisher';

async function fetchWithRetry(url, maxAttempts = 3) {
  let attempt = 0;
  while (true) {
    attempt++;
    let timedOut = false;
    try {
      const controller = new AbortController();
      searchPending = controller;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      searchPending = null;
      if (res.ok) return res;
      if ((res.status === 500 || res.status === 503 || res.status === 429) && attempt < maxAttempts) {
        await sleep(attempt * 600);
        continue;
      }
      throw new FetchError(`Server error (HTTP ${res.status}). Please try again.`);
    } catch (e) {
      // Re-throw errors we threw deliberately — don't retry or re-wrap them
      if (e.name === 'FetchError') throw e;
      // AbortError: either user-cancelled (silent) or timed out (show message)
      if (e.name === 'AbortError') {
        if (timedOut) throw new FetchError('Open Library didn\'t respond in time. Please try again.');
        throw e; // user-cancelled — performSearch will return silently
      }
      if (attempt < maxAttempts) { await sleep(400); continue; }
      throw new FetchError('Network error. Please check your connection and try again.');
    }
  }
}

async function searchByISBN(isbn) {
  if (isbnCache[isbn]) return [isbnCache[isbn]];

  const candidates = buildISBNCandidates(isbn);

  // Check variant cache hits before any network calls
  for (const c of candidates) {
    if (isbnCache[c]) { isbnCache[isbn] = isbnCache[c]; return [isbnCache[c]]; }
  }

  // For each candidate ISBN, fire both endpoints simultaneously and wait for both
  // to settle (or timeout). We then merge the best fields from each:
  //   - Search index: always returns a /works/ key (enables description fetch)
  //                   but may lack page count (number_of_pages_median missing)
  //   - Books API:    may lack a works key but carries pagination/page count,
  //                   publisher, and cover when the search index doesn't
  // Racing alone would mean the slower endpoint's data is discarded. By waiting
  // for both (up to 8 s), we get the richest possible record every time.
  for (const candidate of candidates) {
    const booksPromise  = fetchISBNFromBooksAPI(candidate).catch(() => null);
    const searchPromise = fetchISBNFromSearch(candidate).catch(() => null);

    // Fast-path: wait for whichever endpoint responds first (up to 8 s),
    // then give the other endpoint up to 3 more seconds to arrive so we can
    // merge the two responses. This avoids always waiting the full 8 s when
    // one endpoint is fast and the other is slow or unreachable.
    const winner = await Promise.race([
      booksPromise.then(b  => b  && { src: 'books',  b  }).catch(() => null),
      searchPromise.then(s => s  && { src: 'search', s  }).catch(() => null),
      sleep(8000).then(() => ({ src: 'timeout' })),
    ]);
    if (!winner || winner.src === 'timeout') continue;

    let booksBook, searchBook;
    if (winner.src === 'books') {
      booksBook  = winner.b;
      searchBook = await Promise.race([searchPromise.catch(() => null), sleep(3000).then(() => null)]);
    } else {
      searchBook = winner.s;
      booksBook  = await Promise.race([booksPromise.catch(() => null), sleep(3000).then(() => null)]);
    }

    // winner already guaranteed at least one is non-null
    if (!booksBook && !searchBook) continue;

    let book;
    if (searchBook && booksBook) {
      // Both found — merge: prefer /works/ id and search subjects; fill blanks from Books API
      book = {
        ...searchBook,
        id:        searchBook.id.startsWith('/works/') ? searchBook.id : (booksBook.id ?? searchBook.id),
        coverURL:  searchBook.coverURL  ?? booksBook.coverURL,
        pageCount: searchBook.pageCount ?? booksBook.pageCount,
        publisher: searchBook.publisher ?? booksBook.publisher,
        // Books API subjects are richer objects — only use them if search came back empty
        categories: searchBook.categories.length ? searchBook.categories : booksBook.categories,
      };
    } else {
      book = searchBook ?? booksBook;
    }

    // Special-edition enrichment: if the title contains edition qualifiers
    // (Deluxe, Collector's, Special Edition, etc.) and the record is missing a
    // cover or has sparse categories, search for the base title to fill gaps.
    // We keep the original title, id, and ISBN so catalogue links stay correct.
    book = await enrichSpecialEdition(book);

    isbnCache[isbn] = isbnCache[candidate] = book;
    return [book];
  }

  throw new FetchError('No books found. Try a different search.');
}

// Fetch one ISBN from the Books API with retries — throws if not found.
async function fetchISBNFromBooksAPI(candidate) {
  const url = `${BOOKS_BASE}?bibkeys=ISBN:${candidate}&format=json&jscmd=data`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 503 || res.status === 429 || res.status === 500) {
        if (attempt < 3) { await sleep(attempt * 600); continue; }
        throw new Error('server error');
      }
      if (!res.ok) throw new Error('not found');
      const json = await res.json();
      const val  = Object.values(json)[0];
      if (!val) throw new Error('not found');
      return bookFromBooksAPI(val, candidate);
    } catch (e) {
      clearTimeout(timer);
      if (e.message === 'not found') throw e;           // definitive miss — don't retry
      if (attempt < 3) { await sleep(attempt * 600); continue; }
      throw e;
    }
  }
}

// Fetch one ISBN from the search index with retries — throws if not found.
async function fetchISBNFromSearch(candidate) {
  const params = new URLSearchParams({ isbn: candidate, fields: SEARCH_FIELDS, limit: '1' });
  const url = `${SEARCH_BASE}?${params}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 503 || res.status === 429 || res.status === 500) {
        if (attempt < 3) { await sleep(attempt * 600); continue; }
        throw new Error('server error');
      }
      if (!res.ok) throw new Error('not found');
      const json = await res.json();
      const books = (json.docs || []).map(bookFromDoc).filter(Boolean);
      if (!books.length) throw new Error('not found');
      return books[0];
    } catch (e) {
      clearTimeout(timer);
      if (e.message === 'not found') throw e;
      if (attempt < 3) { await sleep(attempt * 600); continue; }
      throw e;
    }
  }
}

// Special-edition enrichment ──────────────────────────────────────────────────
// Matches edition qualifiers that appear in parentheses, after a colon/dash,
// or appended directly to the title. Handles patterns like:
//   "Games Gods Play (Deluxe Limited Edition)"
//   "Butcher & Blackbird: Collector's Edition"
//   "The Name of the Wind Tenth Anniversary Deluxe Edition"
const EDITION_WORD_RE = /\b(deluxe|limited|collector[\u2019']?s?|special|anniversary|illustrated|signed|exclusive|expanded|hardcover)\b/i;

// Returns a (possibly enriched) copy of book. If the title contains edition
// qualifiers AND the record is missing a cover or has very sparse categories,
// we search Open Library for the base title + author and merge in the
// cover, subjects, page count, and /works/ id from the best matching result.
// We always keep the original title, id, and ISBN so catalogue links stay correct.
async function enrichSpecialEdition(book) {
  const lc = book.title.toLowerCase();

  // Quick check — does the title contain any edition word plus "edition"?
  if (!EDITION_WORD_RE.test(lc) || !lc.includes('edition')) return book;

  // Only enrich if something useful is missing — avoids unnecessary API calls
  if (book.coverURL && book.categories.length > 5) return book;

  // Derive the base title by progressively stripping edition qualifiers.
  // We handle three common patterns:
  //   1. Parenthetical suffix:  "Title (Deluxe Limited Edition)"
  //   2. Colon/dash suffix:     "Title: Collector's Edition"
  //   3. Direct suffix:         "Title Deluxe Edition"
  // Shared qualifier group — matches words like "deluxe", "collector's", "limited", etc.
  // The \u2019 covers the curly apostrophe used in many book titles.
  const Q = "(?:(?:deluxe|limited|collector[\\u2019']?s?|special|anniversary|illustrated|signed|exclusive|expanded|hardcover)\\s+)+";
  let baseTitle = book.title
    // 1. Remove entire parenthetical that contains "edition": "(Deluxe Limited Edition)"
    .replace(/\s*\([^)]*edition[s]?\s*\)/gi, '')
    // 2. Remove colon/dash suffix where the suffix is just an edition qualifier:
    //    ": Collector's Edition"  or  "— Deluxe Edition"
    .replace(new RegExp('\\s*[:\\u2013\\u2014\\-]\\s*' + Q + 'edition[s]?\\s*$', 'gi'), '')
    // 3. Remove trailing edition phrase appended without punctuation:
    //    "A Court of Thorns and Roses Special Edition"
    .replace(new RegExp('\\s+' + Q + 'edition[s]?\\s*$', 'gi'), '')
    // 4. Clean up leftover punctuation/whitespace
    .replace(/[\s:,\-\u2013\u2014(]+$/, '')
    .trim();

  if (!baseTitle || baseTitle.toLowerCase() === book.title.trim().toLowerCase()) return book;

  const author = book.authors?.[0] ?? '';
  try {
    // Use q= (full-text) rather than title= so "Games Gods Play" matches
    // "The Games Gods Play" — title= does exact prefix matching and can miss
    // records where "The" is indexed inconsistently.
    const q = author ? `${baseTitle} ${author}` : baseTitle;
    const params = new URLSearchParams({ q, fields: SEARCH_FIELDS, limit: '5' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${SEARCH_BASE}?${params}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return book;

    const json  = await res.json();
    const found = (json.docs || []).map(bookFromDoc).filter(Boolean);

    // Only accept results where at least one author name overlaps
    const authorLC = author.toLowerCase();
    const sameAuthor = b => !author ||
      (b.authors || []).some(a =>
        a.toLowerCase().includes(authorLC) || authorLC.includes(a.toLowerCase()));

    const candidates = found.filter(sameAuthor);

    // Prefer: has cover + /works/ id > has cover > any match
    const best = candidates.find(b => b.coverURL && b.id?.startsWith('/works/'))
              ?? candidates.find(b => b.coverURL)
              ?? candidates[0];
    if (!best) return book;

    // Eagerly fetch the description from the best match's works endpoint.
    // This populates age-rating and romance-detection signals immediately —
    // without this, both run on near-empty subjects for deluxe/special editions.
    // Raced against 6 s so it never blocks the lookup on a slow network.
    const worksId = best.id?.startsWith('/works/') ? best.id
                  : (book.id?.startsWith('/works/') ? book.id : null);
    const description = worksId
      ? await Promise.race([fetchDescription(worksId), sleep(6000).then(() => null)])
      : null;

    // Merge categories: deduplicate and combine both records so nothing is lost.
    // The special-edition record may carry NYT tags; the main edition may carry
    // genre/subject tags. Union of both gives the best signal for age/romance.
    const mergedCategories = [
      ...new Set([...(book.categories || []), ...(best.categories || [])])
    ];

    return {
      ...book,
      coverURL:      book.coverURL  ?? best.coverURL,
      categories:    mergedCategories,
      pageCount:     book.pageCount ?? best.pageCount,
      description:   book.description ?? description,
      id:            book.id.startsWith('/works/') ? book.id : (best.id ?? book.id),
      // Store the works id used to fetch the description so the detail view
      // can re-fetch from the same richer endpoint (not the sparse deluxe record).
      descWorksId:   worksId,
    };
  } catch {
    return book; // enrichment is always best-effort
  }
}

// Returns the scanned ISBN plus plausible alternates to maximise lookup hits.
function buildISBNCandidates(isbn) {
  const candidates = [isbn];
  if (isbn.length === 12) {
    // UPC-A (12 digits) → EAN-13 by prepending '0'
    candidates.push('0' + isbn);
  }
  if (isbn.length === 13 && isbn.startsWith('978')) {
    // EAN-13 with 978 prefix → ISBN-10 (many older records are only under ISBN-10)
    const isbn10 = isbn13ToISBN10(isbn);
    if (isbn10) candidates.push(isbn10);
  }
  if (isbn.length === 13 && isbn.startsWith('0')) {
    // EAN-13 with leading 0 → 12-digit UPC-A form
    candidates.push(isbn.slice(1));
  }
  return candidates;
}

function isbn13ToISBN10(isbn13) {
  const nine = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(nine[i], 10) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return nine + (check === 10 ? 'X' : String(check));
}

async function searchByQuery(title, author) {
  const params = new URLSearchParams();
  if (title && author) { params.set('title', title); params.set('author', author); }
  else if (author)     { params.set('q', author); }
  else                 { params.set('q', title); }
  params.set('fields', SEARCH_FIELDS);
  params.set('limit', '10');

  const cacheKey = params.toString();
  if (queryCache[cacheKey]) return queryCache[cacheKey];

  // Author-only optimisation: try the specific author= index first — it hits a
  // dedicated Solr field and returns faster. Fall back to q= (full-text) only
  // if author= comes back empty, since some authors aren't indexed under author=.
  if (!title && author) {
    const authorParams = new URLSearchParams({ author, fields: SEARCH_FIELDS, limit: '10' });
    const authorKey = authorParams.toString();
    if (queryCache[authorKey]) return queryCache[authorKey];
    try {
      const res  = await fetchWithRetry(`${SEARCH_BASE}?${authorParams}`);
      const json = await res.json();
      const books = (json.docs || []).map(bookFromDoc).filter(Boolean);
      if (books.length) {
        queryCache[authorKey] = books;
        return books;
      }
    } catch (_) { /* fall through to q= */ }
  }

  const res  = await fetchWithRetry(`${SEARCH_BASE}?${params}`);
  const json = await res.json();
  let books = (json.docs || []).map(bookFromDoc).filter(Boolean);

  // If no results and the title uses "and" or "&", retry with the other form.
  // Open Library indexes some titles with "&" (e.g. "Butcher & Blackbird") even
  // when typed as "and", so a single retry resolves most of these mismatches.
  if (!books.length && title && !author) {
    const altTitle = /\band\b/i.test(title)
      ? title.replace(/\band\b/gi, '&')
      : title.includes('&') ? title.replace(/\s*&\s*/g, ' and ') : null;
    if (altTitle) {
      const altParams = new URLSearchParams({ q: altTitle, fields: SEARCH_FIELDS, limit: '10' });
      try {
        const altRes  = await fetchWithRetry(`${SEARCH_BASE}?${altParams}`);
        const altJson = await altRes.json();
        books = (altJson.docs || []).map(bookFromDoc).filter(Boolean);
      } catch (_) {}
    }
  }

  if (!books.length) throw new Error('No books found. Try a different search.');
  queryCache[cacheKey] = books;
  return books;
}

async function fetchDescription(workKey) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${WORKS_BASE}${workKey}.json`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const d = json.description;
    return typeof d === 'string' ? d : d?.value ?? null;
  } catch { return null; }
}

function bookFromBooksAPI(d, isbn) {
  return {
    id:            (d.works?.[0]?.key) ?? `/isbn/${isbn}`,
    title:         d.title || 'Unknown Title',
    authors:       (d.authors || []).map(a => a.name).filter(Boolean),
    description:   null,
    categories:    (d.subjects || []).slice(0, 30).map(s => s.name),
    maturityRating:'NOT_MATURE',
    // Books API uses 'number_of_pages' on most editions but 'pagination' on some
    // (e.g. "pagination": "592") — parse both so page count is never silently lost.
    pageCount:     d.number_of_pages ?? (d.pagination ? parseInt(d.pagination, 10) || null : null),
    publishedDate: d.publish_date ?? null,
    publisher:     d.publishers?.[0]?.name ?? null,
    coverURL:      d.cover?.medium ?? null,
  };
}

function bookFromDoc(doc) {
  if (!doc.key || !doc.title) return null;
  return {
    id:            doc.key,
    title:         doc.title,
    authors:       doc.author_name || [],
    description:   null,
    categories:    (doc.subject || []).slice(0, 30),
    maturityRating:'NOT_MATURE',
    pageCount:     doc.number_of_pages_median ?? null,
    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : null,
    publisher:     doc.publisher?.[0] ?? null,
    coverURL:      doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderPlaceholder();
  startScanner();
});
