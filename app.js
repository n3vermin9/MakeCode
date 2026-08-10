/* ============================================================
   ПОИСК ТОВАРА И ГЕНЕРАТОР ШТРИХКОДОВ — application logic
   ============================================================ */

(function () {
  'use strict';

  // ---------- State ----------
  let DB = [];              // array of product records: {c,b,n,br,g,l:[{z,e,q}]}
  let byCode = new Map();   // code -> product
  let byBarcode = new Map();// barcode -> product
  let history = [];         // in-memory session history (max 8), newest first
  let currentProduct = null;
  let activeSuggestionIndex = -1;
  let currentSuggestions = [];

  // ---------- DOM refs ----------
  const el = (id) => document.getElementById(id);
  const searchInput = () => el('search-input');
  const suggestionsBox = () => el('suggestions');
  const clearBtn = () => el('clear-btn');
  const resultCard = () => el('result-card');
  const emptyState = () => el('empty-state');
  const historyList = () => el('history-list');
  const dbCountEl = () => el('db-count');
  const toast = () => el('toast');

  // ---------- Resilient multi-CDN script loading ----------
  // Any single CDN can be slow, blocked, or momentarily down. Instead of a single
  // <script src> that fails silently, each library is loaded on demand and tried
  // against several mirrors in sequence before giving up.

  const scriptLoadCache = new Map(); // key -> Promise

  function loadScriptFrom(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        s.remove();
        reject(new Error('timeout: ' + url));
      }, timeoutMs);
      s.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      s.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.remove();
        reject(new Error('failed to load: ' + url));
      };
      document.head.appendChild(s);
    });
  }

  // Loads the first working script among `urls`, verified by `checkFn` (returns
  // true once the expected global is present). Result is cached by `key` so a
  // library is only ever fetched once per page session.
  function ensureLibrary(key, urls, checkFn, timeoutMs) {
    if (checkFn()) return Promise.resolve();
    if (scriptLoadCache.has(key)) return scriptLoadCache.get(key);

    const attempt = (async () => {
      let lastErr = null;
      for (const url of urls) {
        if (checkFn()) return;
        try {
          await loadScriptFrom(url, timeoutMs || 7000);
          if (checkFn()) return;
          lastErr = new Error('script loaded but library not detected: ' + url);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('Не удалось загрузить библиотеку: ' + key);
    })();

    scriptLoadCache.set(key, attempt);
    return attempt;
  }

  function ensurePako() {
    return ensureLibrary(
      'pako',
      [
        'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js',
        'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
        'https://unpkg.com/pako@2.1.0/dist/pako.min.js'
      ],
      () => typeof window.pako !== 'undefined'
    );
  }

  function ensureJsBarcode() {
    return ensureLibrary(
      'jsbarcode',
      [
        'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.12.3/JsBarcode.all.min.js',
        'https://cdn.jsdelivr.net/npm/jsbarcode@3.12.3/dist/JsBarcode.all.min.js',
        'https://unpkg.com/jsbarcode@3.12.3/dist/JsBarcode.all.min.js'
      ],
      () => typeof window.JsBarcode !== 'undefined'
    );
  }

  // ---------- Utilities ----------

  function normalizeCode(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).trim();
    // strip float suffix like 123456.0 coming from Excel
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    return s;
  }

  function normalizeText(s) {
    return (s || '').toString().trim();
  }

  function foldCase(s) {
    return normalizeText(s).toLowerCase();
  }

  function isValidEAN13(code) {
    if (!/^\d{13}$/.test(code)) return false;
    const digits = code.split('').map(Number);
    const checksum = digits.slice(0, 12).reduce((sum, d, i) => {
      return sum + d * (i % 2 === 0 ? 1 : 3);
    }, 0);
    const check = (10 - (checksum % 10)) % 10;
    return check === digits[12];
  }

  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function escapeHtml(str) {
    return (str || '').toString().replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function showToast(message) {
    const t = toast();
    if (!t) return;
    t.textContent = message;
    t.classList.add('toast-visible');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      t.classList.remove('toast-visible');
    }, 2200);
  }

  // ---------- Data loading ----------

  function buildIndexes() {
    byCode = new Map();
    byBarcode = new Map();
    for (const p of DB) {
      byCode.set(p.c, p);
      if (p.b) byBarcode.set(p.b, p);
    }
    if (dbCountEl()) dbCountEl().textContent = DB.length.toLocaleString('ru-RU');
  }

  async function loadEmbeddedData() {
    try {
      await ensurePako();
      const compressed = Uint8Array.from(atob(window.__DATA_B64__), (c) => c.charCodeAt(0));
      const inflated = window.pako.ungzip(compressed, { to: 'string' });
      DB = JSON.parse(inflated);
    } catch (err) {
      console.error('Ошибка распаковки базы данных:', err);
      DB = [];
      showFatalError(
        'Не удалось загрузить библиотеку распаковки данных (pako). ' +
        'Проверьте подключение к интернету и обновите страницу.'
      );
    }
    buildIndexes();
  }

  function showFatalError(message) {
    const box = emptyState();
    if (!box) return;
    box.classList.add('visible');
    const titleEl = box.querySelector('.empty-title');
    const subEl = box.querySelector('.empty-sub');
    if (titleEl) titleEl.textContent = 'Ошибка загрузки';
    if (subEl) subEl.textContent = message;
  }

  // ---------- Search ----------

  function searchProducts(query, limit) {
    const q = foldCase(query);
    if (!q) return [];
    const results = [];
    const seen = new Set();

    // Exact code match first
    const exactCode = byCode.get(normalizeCode(query));
    if (exactCode) {
      results.push(exactCode);
      seen.add(exactCode.c);
    }
    // Exact barcode match
    const exactBarcode = byBarcode.get(normalizeCode(query));
    if (exactBarcode && !seen.has(exactBarcode.c)) {
      results.push(exactBarcode);
      seen.add(exactBarcode.c);
    }

    // Prefix code matches
    for (const p of DB) {
      if (results.length >= limit) break;
      if (seen.has(p.c)) continue;
      if (p.c.startsWith(query.trim())) {
        results.push(p);
        seen.add(p.c);
      }
    }

    // Barcode prefix matches
    for (const p of DB) {
      if (results.length >= limit) break;
      if (seen.has(p.c)) continue;
      if (p.b && p.b.startsWith(query.trim())) {
        results.push(p);
        seen.add(p.c);
      }
    }

    // Name substring matches
    for (const p of DB) {
      if (results.length >= limit) break;
      if (seen.has(p.c)) continue;
      if (foldCase(p.n).includes(q)) {
        results.push(p);
        seen.add(p.c);
      }
    }

    // Brand substring matches
    for (const p of DB) {
      if (results.length >= limit) break;
      if (seen.has(p.c)) continue;
      if (foldCase(p.br).includes(q)) {
        results.push(p);
        seen.add(p.c);
      }
    }

    return results.slice(0, limit);
  }

  function renderSuggestions(items) {
    const box = suggestionsBox();
    currentSuggestions = items;
    activeSuggestionIndex = -1;
    if (!items.length) {
      box.innerHTML = '';
      box.classList.remove('suggestions-open');
      return;
    }
    box.innerHTML = items.map((p, i) => `
      <button type="button" class="suggestion-item" data-index="${i}">
        <span class="suggestion-code">${escapeHtml(p.c)}</span>
        <span class="suggestion-name">${escapeHtml(p.n)}</span>
        <span class="suggestion-brand">${escapeHtml(p.br)}</span>
      </button>
    `).join('');
    box.classList.add('suggestions-open');
    box.querySelectorAll('.suggestion-item').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.index);
        chooseSuggestion(idx);
      });
    });
  }

  function closeSuggestions() {
    const box = suggestionsBox();
    if (box) {
      box.innerHTML = '';
      box.classList.remove('suggestions-open');
    }
    currentSuggestions = [];
    activeSuggestionIndex = -1;
  }

  function chooseSuggestion(idx) {
    const p = currentSuggestions[idx];
    if (!p) return;
    searchInput().value = p.c;
    renderProduct(p);
    pushHistory(p);
    closeSuggestions();
  }

  const handleInput = debounce(function () {
    const val = searchInput().value;
    toggleClearBtn();
    if (!val.trim()) {
      closeSuggestions();
      return;
    }
    const trimmed = val.trim();
    // A complete code or barcode match means there's nothing more to type —
    // select it immediately instead of waiting for a suggestion click.
    const exact = byCode.get(normalizeCode(trimmed)) || byBarcode.get(normalizeCode(trimmed));
    if (exact) {
      renderProduct(exact);
      pushHistory(exact);
      closeSuggestions();
      return;
    }
    const results = searchProducts(val, 10);
    renderSuggestions(results);
  }, 120);

  function toggleClearBtn() {
    const has = searchInput().value.trim().length > 0;
    clearBtn().classList.toggle('visible', has);
  }

  function selectProductByCode(code) {
    const p = byCode.get(normalizeCode(code)) || byBarcode.get(normalizeCode(code));
    if (p) {
      renderProduct(p);
      pushHistory(p);
    } else {
      showNotFound(code);
    }
  }

  function handleSearchSubmit() {
    const val = searchInput().value.trim();
    if (!val) return;
    if (currentSuggestions.length && activeSuggestionIndex >= 0) {
      chooseSuggestion(activeSuggestionIndex);
      return;
    }
    const results = searchProducts(val, 1);
    if (results.length) {
      renderProduct(results[0]);
      pushHistory(results[0]);
    } else {
      showNotFound(val);
    }
    closeSuggestions();
  }

  function showNotFound(query) {
    currentProduct = null;
    closeModal();
    resultCard().classList.remove('visible');
    emptyState().classList.add('visible');
    emptyState().querySelector('.empty-title').textContent = 'Ничего не найдено';
    emptyState().querySelector('.empty-sub').textContent =
      `По запросу «${query}» совпадений нет. Проверьте код или попробуйте часть названия.`;
  }

  function resetEmptyState() {
    emptyState().querySelector('.empty-title').textContent = 'Начните поиск';
    emptyState().querySelector('.empty-sub').textContent =
      'Введите код товара, штрихкод или часть названия — карточка появится здесь.';
  }

  // ---------- Rendering the result card ----------

  function renderProduct(p) {
    currentProduct = p;
    resetEmptyState();
    emptyState().classList.remove('visible');
    resultCard().classList.add('visible');

    el('res-name').textContent = p.n || '—';
    el('res-brand').textContent = p.br || '—';
    el('res-group').textContent = p.g || '';
    el('res-code').textContent = p.c || '—';
    el('res-barcode-value').textContent = p.b || '—';

    // Locations
    const locBox = el('res-locations');
    if (p.l && p.l.length) {
      locBox.innerHTML = p.l.map((loc) => `
        <div class="location-row">
          <span class="location-zone">${escapeHtml(loc.z || '—')}</span>
          <span class="location-cell">${escapeHtml(loc.e || '—')}</span>
          <span class="location-qty">${loc.q ?? 0} шт.</span>
        </div>
      `).join('');
    } else {
      locBox.innerHTML = '<div class="location-row location-empty">Расположение не указано</div>';
    }

    populateModalHeader(p);
    drawBarcode(p.b);
    // The whole point of typing/selecting a product is to get its barcode,
    // so open the modal immediately rather than waiting for another click.
    openModal();
    triggerScanAnimation();
  }

  // ---------- Modal (barcode result) ----------

  function modalOverlay() { return el('barcode-modal'); }

  function isModalOpen() {
    const m = modalOverlay();
    return !!m && m.classList.contains('modal-open');
  }

  function populateModalHeader(p) {
    el('modal-group').textContent = p.g || '';
    el('modal-product-name').textContent = p.n || '—';
    el('modal-code').textContent = p.c || '—';
    el('modal-brand').textContent = p.br || '—';
  }

  function showBarcodeModal() {
    if (!currentProduct) return;
    drawBarcode(currentProduct.b);
    openModal();
    triggerScanAnimation();
  }

  function openModal() {
    const m = modalOverlay();
    if (!m) return;
    m.classList.add('modal-open');
    document.body.classList.add('modal-lock');
  }

  function closeModal() {
    const m = modalOverlay();
    if (!m) return;
    m.classList.remove('modal-open');
    document.body.classList.remove('modal-lock');
  }

  async function drawBarcode(code) {
    const svg = el('barcode-svg');
    const fallbackNote = el('barcode-format-note');
    if (!code) {
      svg.innerHTML = '';
      fallbackNote.textContent = '';
      return;
    }

    fallbackNote.textContent = 'Загрузка библиотеки штрихкодов…';
    try {
      await ensureJsBarcode();
    } catch (err) {
      console.error('Не удалось загрузить JsBarcode:', err);
      svg.innerHTML = '';
      fallbackNote.textContent = 'Библиотека штрихкодов недоступна — проверьте подключение к интернету';
      return;
    }

    // The result card may have re-rendered for a different product while we
    // were waiting for the library; only draw if this is still the current one.
    if (!currentProduct || currentProduct.b !== code) return;

    const useEAN13 = isValidEAN13(code);
    try {
      window.JsBarcode(svg, code, {
        format: useEAN13 ? 'EAN13' : 'CODE128',
        lineColor: '#0e0f0a',
        width: 2.4,
        height: 72,
        fontSize: 18,
        margin: 8,
        background: 'transparent',
        font: 'JetBrains Mono, monospace'
      });
      fallbackNote.textContent = useEAN13
        ? 'Формат: EAN-13'
        : 'Формат: CODE128 (не соответствует контрольной сумме EAN-13)';
    } catch (err) {
      console.error('Ошибка генерации штрихкода:', err);
      try {
        window.JsBarcode(svg, code, {
          format: 'CODE128',
          lineColor: '#0e0f0a',
          width: 2.4,
          height: 72,
          fontSize: 18,
          margin: 8,
          background: 'transparent'
        });
        fallbackNote.textContent = 'Формат: CODE128 (аварийный режим)';
      } catch (err2) {
        svg.innerHTML = '';
        fallbackNote.textContent = 'Не удалось построить штрихкод для этого значения';
      }
    }
  }

  function triggerScanAnimation() {
    const beam = el('scan-beam');
    if (!beam) return;
    beam.classList.remove('scan-run');
    void beam.offsetWidth; // reflow to restart animation
    beam.classList.add('scan-run');
  }

  // ---------- History (in-memory, session-scoped only — no storage APIs) ----------

  function pushHistory(p) {
    history = history.filter((h) => h.c !== p.c);
    history.unshift(p);
    if (history.length > 8) history = history.slice(0, 8);
    renderHistory();
  }

  function renderHistory() {
    const box = historyList();
    if (!box) return;
    if (!history.length) {
      box.innerHTML = '<div class="history-empty">Здесь появятся последние просмотренные товары</div>';
      return;
    }
    box.innerHTML = history.map((p) => `
      <button type="button" class="history-item" data-code="${escapeHtml(p.c)}">
        <span class="history-code">${escapeHtml(p.c)}</span>
        <span class="history-name">${escapeHtml(p.n)}</span>
      </button>
    `).join('');
    box.querySelectorAll('.history-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        searchInput().value = btn.dataset.code;
        selectProductByCode(btn.dataset.code);
        closeSuggestions();
      });
    });
  }

  // ---------- Actions ----------

  function copyBarcode() {
    if (!currentProduct || !currentProduct.b) return;
    const text = currentProduct.b;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('Штрихкод скопирован: ' + text),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Штрихкод скопирован: ' + text);
    } catch (e) {
      showToast('Не удалось скопировать');
    }
    document.body.removeChild(ta);
  }

  async function printLabel() {
    if (!currentProduct) return;
    await drawBarcode(currentProduct.b);
    window.print();
  }

  function clearSearch() {
    searchInput().value = '';
    toggleClearBtn();
    closeSuggestions();
    searchInput().focus();
  }

  // ---------- Keyboard navigation for suggestions ----------

  function handleKeydown(e) {
    const box = suggestionsBox();
    const open = box && box.classList.contains('suggestions-open');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return;
      activeSuggestionIndex = Math.min(currentSuggestions.length - 1, activeSuggestionIndex + 1);
      highlightSuggestion();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return;
      activeSuggestionIndex = Math.max(0, activeSuggestionIndex - 1);
      highlightSuggestion();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSearchSubmit();
    } else if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeModal();
        return;
      }
      closeSuggestions();
    }
  }

  function highlightSuggestion() {
    const box = suggestionsBox();
    box.querySelectorAll('.suggestion-item').forEach((el2, i) => {
      el2.classList.toggle('suggestion-active', i === activeSuggestionIndex);
    });
    const activeEl = box.querySelector('.suggestion-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Init ----------

  async function init() {
    await loadEmbeddedData();
    resetEmptyState();
    renderHistory();
    toggleClearBtn();

    searchInput().addEventListener('input', handleInput);
    searchInput().addEventListener('keydown', handleKeydown);
    searchInput().addEventListener('focus', () => {
      if (searchInput().value.trim()) handleInput();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) closeSuggestions();
    });

    clearBtn().addEventListener('click', clearSearch);
    el('show-barcode-btn').addEventListener('click', showBarcodeModal);
    el('copy-btn').addEventListener('click', copyBarcode);
    el('print-btn').addEventListener('click', printLabel);

    el('modal-close-btn').addEventListener('click', closeModal);
    modalOverlay().addEventListener('click', (e) => {
      if (e.target === modalOverlay()) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isModalOpen()) closeModal();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
