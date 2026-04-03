'use strict';

// ── Theme colours for age rating badges ───────────────────────────────────────
const AGE_COLOURS = {
  'Kids':         '#4DB350',
  'Middle Grade': '#219CF2',
  'Young Adult':  '#9C8049',
  'Adult':        '#FF9900',
  'Mature (18+)': '#F54236',
};

// ── In-memory caches ──────────────────────────────────────────────────────────
const queryCache = {};
const isbnCache  = {};

// ── State ─────────────────────────────────────────────────────────────────────
let currentTab    = 'scan';
let searchPending = null;   // AbortController for in-flight search

// ── Custom error to distinguish deliberate throws from network failures ────────
class FetchError extends Error {
  constructor(msg) { super(msg); this.name = 'FetchError'; }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  clearSearch();
  currentTab = tab;
  document.querySelectorAll('.view:not(.modal)').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view-' + tab).classList.add('active');
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'scan') startScanner();
  else stopScanner();
}

// ── Scanner ───────────────────────────────────────────────────────────────────
// Uses Quagga2 for EAN/UPC decoding via canvas — works on iOS Safari and all
// mobile browsers. BarcodeDetector is NOT used (not available on iOS).

let quaggaRunning = false;
let lastScanned   = null;

function startScanner() {
  const fallback = document.getElementById('scan-fallback');
  const area     = document.getElementById('scanner-area');

  area.classList.remove('hidden');
  fallback.classList.add('hidden');
  stopScanner();

  if (!navigator.mediaDevices?.getUserMedia) {
    showScanFallback('Camera not supported in this browser.');
    return;
  }

  Quagga.init({
    inputStream: {
      type: 'LiveStream',
      target: document.getElementById('scanner-area'),
      constraints: {
        facingMode: 'environment',
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      // Quagga draws its own canvas overlay — we don't need it
      willReadFrequently: true,
    },
    decoder: {
      readers: ['ean_reader'],   // ISBN barcodes are always EAN-13; fewer decoders = faster, fewer misreads
    },
    locate: true,
    numOfWorkers: 0,   // Workers require SharedArrayBuffer which is blocked on iOS
  }, function(err) {
    if (err) {
      showScanFallback(err.message || 'Camera unavailable.');
      return;
    }
    quaggaRunning = true;
    Quagga.start();
  });

  Quagga.offDetected();  // remove any previous listener before adding new one
  Quagga.onDetected(function(result) {
    const code = result?.codeResult?.code;
    if (!code) return;
    let isbn = code.replace(/\D/g, '');
    if (!isbn) return;

    // Quagga's upc_reader fires on EAN-13 barcodes and strips the leading digit,
    // producing a 12-digit code that is wrong (e.g. reads 978... as 78...).
    // Validate the check digit and reject bad reads — keep scanning until we get
    // a valid EAN-13 (13 digits) or ISBN-10 (10 digits).
    if (!isValidISBNCode(isbn)) return;

    if (isbn !== lastScanned) {
      lastScanned = isbn;
      flashScanBox();
      handleScannedISBN(isbn);
    }
  });
}

// Returns true only for codes with a valid EAN-13 or ISBN-10 check digit.
// Rejects UPC misreads, truncated codes, and garbage digits from Quagga.
function isValidISBNCode(isbn) {
  if (isbn.length === 13) {
    // EAN-13 check digit: alternating ×1 and ×3 weights
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (sum % 10)) % 10 === parseInt(isbn[12]);
  }
  if (isbn.length === 10) {
    // ISBN-10 check digit: weights 10 down to 1
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(isbn[i]) * (10 - i);
    const check = isbn[9] === 'X' ? 10 : parseInt(isbn[9]);
    return (sum + check) % 11 === 0;
  }
  return false; // reject 11-digit, 12-digit UPC misreads, etc.
}

function showScanFallback(msg) {
  const fallback = document.getElementById('scan-fallback');
  const area     = document.getElementById('scanner-area');
  area.classList.add('hidden');
  fallback.classList.remove('hidden');
  const p = fallback.querySelector('p');
  if (p) p.textContent = msg;
}

let flashTimer = null;
function flashScanBox() {
  const box   = document.getElementById('scan-box');
  const flash = document.getElementById('scan-flash');
  if (box)   box.classList.add('detected');
  if (flash) flash.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (box)   box.classList.remove('detected');
    if (flash) flash.classList.remove('show');
  }, 800);
}

function stopScanner() {
  if (quaggaRunning) {
    try { Quagga.stop(); } catch (_) {}
    quaggaRunning = false;
  }
  lastScanned = null;
}

async function handleScannedISBN(isbn) {
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
    resultEl.classList.add('hidden');
    if (books.length > 0) openDetail(books[0]);
  } catch (_) {
    // Book not found — offer to search by title/author, pre-filling the ISBN
    resultEl.innerHTML = `
      <div class="scan-status-card">
        <p style="font-size:28px">📚</p>
        <p class="scan-status-title">Book not found</p>
        <p class="scan-status-sub">No match for this barcode in the catalogue. Try searching by title or author.</p>
        <div class="scan-status-actions">
          <button class="btn-primary" onclick="scanGoToSearch()">Search by title / author</button>
          <button class="read-more-btn" onclick="scanRetry()">Scan a different barcode</button>
        </div>
      </div>`;
    lastScanned = null;
  }
}

function scanGoToSearch() {
  document.getElementById('scan-result').classList.add('hidden');
  switchTab('search');
}

function scanRetry() {
  document.getElementById('scan-result').classList.add('hidden');
  startScanner();
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
  clearBtn.classList.toggle('hidden', !hasInput && document.getElementById('search-results').innerHTML === '');
}

function clearSearch() {
  if (searchPending) { searchPending.abort(); searchPending = null; }
  ['input-title','input-author','input-isbn'].forEach(id => {
    const el = document.getElementById(id);
    el.value = '';
    const cb = el.nextElementSibling;
    if (cb) cb.classList.add('hidden');
  });
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-btn').disabled = true;
  document.getElementById('clear-btn').classList.add('hidden');
  document.getElementById('search-label').textContent = 'Search Books';
  const icon = document.getElementById('search-icon');
  icon.style.display = '';
  document.getElementById('search-btn').disabled = true;
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
        <p style="font-style:italic;margin-top:16px">The wisps are searching…</p>
        <p style="font-size:12px;margin-top:4px">consulting the ancient tomes</p>
      </div>`;
  } else {
    document.getElementById('search-spinner')?.remove();
  }
}

function renderResults(books) {
  currentResults = books;
  const el = document.getElementById('search-results');
  if (!books.length) {
    el.innerHTML = `<div class="state-view">
      <p style="font-size:28px;margin-bottom:8px">📚</p>
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
}

function renderError(msg) {
  document.getElementById('search-results').innerHTML = `
    <div class="state-view">
      <p style="font-size:32px;margin-bottom:8px">⚠️</p>
      <h2 style="color:var(--gold)">${escHtml(msg)}</h2>
      <button class="btn-primary" style="margin-top:16px;max-width:160px" onclick="performSearch()">Try Again</button>
    </div>`;
}

function bookCardHTML(book, idx) {
  const age    = ageRating(book);
  const colour = AGE_COLOURS[age] || '#9B804A';
  const thumb  = book.coverURL
    ? `<img src="${escHtml(book.coverURL)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=thumb-placeholder>📖</span>'">`
    : `<span class="thumb-placeholder">📖</span>`;
  const romance = hasRomanticThemes(book)
    ? `<span class="badge badge-romance">♥ Romance</span>` : '';

  return `<div class="book-card" onclick="openBookByIndex(${idx})" role="button" tabindex="0"
    onkeydown="if(event.key==='Enter')openBookByIndex(${idx})">
    <div class="book-thumb">${thumb}</div>
    <div class="book-info">
      <div class="book-title">${escHtml(book.title)}</div>
      <div class="book-author">${escHtml(book.authors?.join(', ') || 'Unknown Author')}</div>
      <div class="book-badges">
        <span class="badge badge-age" style="--badge-color:${colour}">${escHtml(age)}</span>
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
  currentResults = currentResults.length ? currentResults : [book];
  const detail = document.getElementById('view-detail');
  document.getElementById('detail-content').innerHTML = detailHTML(book);
  detail.classList.remove('hidden');

  // Lazy-load description
  if (book.id && book.id.startsWith('/works/')) {
    fetchDescription(book.id).then(desc => {
      if (!desc) return;

      // Update description text
      const el = document.getElementById('detail-desc-text');
      if (el) {
        el.dataset.full = desc;
        el.textContent = desc.length > 400 ? desc.slice(0, 400) + '…' : desc;
        const section = document.getElementById('detail-desc-section');
        if (section) section.classList.remove('hidden');
        const btn = document.getElementById('detail-desc-toggle');
        if (btn && desc.length <= 400) btn.classList.add('hidden');
      }

      // Re-evaluate age/romance now that description is available.
      // Books with sparse subjects (e.g. Butcher & Blackbird) may only reveal
      // their rating and romantic themes through the description text.
      const bookWithDesc = Object.assign({}, book, { description: desc });
      const newAge     = ageRating(bookWithDesc);
      const newRomance = hasRomanticThemes(bookWithDesc);
      const oldAge     = ageRating(book);
      const oldRomance = hasRomanticThemes(book);
      if (newAge !== oldAge || newRomance !== oldRomance) {
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
    });
  }
}

function closeDetail() {
  document.getElementById('view-detail').classList.add('hidden');
  lastScanned = null;
  // If the user came from the scan tab, restart the camera so they can scan again
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
      <div id="detail-desc-section" class="${book.id?.startsWith('/works/') ? 'hidden' : 'hidden'}">
        <div class="section-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
          Description
        </div>
        <p class="detail-description" id="detail-desc-text"></p>
        <button class="read-more-btn" id="detail-desc-toggle"
          onclick="toggleDesc()">Read more</button>
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
function showInfo() {
  document.getElementById('info-content').innerHTML = infoHTML();
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
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
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

  // For each candidate, race Books API vs Search index simultaneously.
  // These are different endpoints so firing both at once doesn't risk rate-limiting.
  // We try each candidate in order (primary ISBN first, then variants) and stop
  // at the first hit — no parallel same-endpoint blasting that would trigger 429s.
  for (const candidate of candidates) {
    const book = await Promise.any([
      fetchISBNFromBooksAPI(candidate),
      fetchISBNFromSearch(candidate),
    ]).catch(() => null);

    if (book) {
      isbnCache[isbn] = isbnCache[candidate] = book;
      return [book];
    }
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
        currentResults = books;
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
  currentResults = books;
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
    pageCount:     d.number_of_pages ?? null,
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
  // Show placeholder in search results
  document.getElementById('search-results').innerHTML = `
    <div class="state-view">
      <div class="wisp-cluster">
        <div class="wisp-orb" style="--size:80px;--dur:3.2s;--gold:1"></div>
        <div class="wisp-orb" style="--size:42px;--dur:4.1s;--gold:0;left:52px;top:30px"></div>
      </div>
      <h2 style="margin-top:16px">Find Your Next Read</h2>
      <p>Search by title, author, ISBN,<br>or any combination</p>
      <p class="tagline">because reality is overrated</p>
    </div>`;

  // Start scanner on load
  startScanner();
});
