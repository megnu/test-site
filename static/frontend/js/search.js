/*
 * Static Site Search
 * static/frontend/js/search.js
 * Runs on every page. If URL has ?s=... AND we're at site base, it mounts a live search UI.
 * If ?s=... on a subpage, redirect to site base with the same query.
 * If not in ?s=, it exposes a simple <form.site-search-widget> (if placed) that submits to ?s=.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
(function () {
  // Keep UI snippets in sync with backend: core/search.py → EXCERPT_WORDS = 100
  const EXCERPT_WORDS = 100;
  let EXCERPT_LIMIT = EXCERPT_WORDS; // updated after index payload loads

  const qs = new URLSearchParams(location.search);
  const s = (qs.get('s') || '').trim();
  // treat empty ?s= as “on the search page”
  const hasSParam = new URLSearchParams(location.search).has('s');

  // -------- Determine site base (preview vs export) --------
  function basePath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'sites' && parts[1]) {
      return `/${['sites', parts[1], ''].join('/')}`; // e.g. "/sites/example/"
    }
    return '/';
  }
  const BASE = basePath();

  // -------- Always: make any “widget” form submit to ?s= at BASE --------
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    if (!f.classList.contains('site-search-widget')) return;
    e.preventDefault();
    const input = f.querySelector('input[name="s"], input[type="search"]');
    const q = input ? (input.value || '').trim() : '';
    const url = new URL(BASE, location.origin);
    url.searchParams.set('s', q);
    location.assign(url.toString());
  });

  function hideWidgetsOnLivePage() {
    if (!hasSParam) return;
    document.querySelectorAll('.site-search-widget').forEach(el => {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    });
  }

  // -------- If ?s= is present but path is not BASE, redirect --------
  if (hasSParam && location.pathname !== BASE) {
    const url = new URL(BASE, location.origin);
    url.searchParams.set('s', s);
    location.replace(url.toString());
    return;
  }

  // If not searching, we’re done.
  if (!hasSParam) return;

  // -------- On live search page: harden SEO bits + tweak DOM --------
  (function hardenSEOMeta() {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex, follow');

    // Remove canonical and JSON-LD (avoid duplicate/irrelevant signals)
    document.querySelectorAll('link[rel="canonical"]').forEach(n => n.remove());
    document.querySelectorAll('script[type="application/ld+json"]').forEach(n => n.remove());

    // Remove OG URL specifically on the search page
    document.querySelectorAll('meta[property="og:url"]').forEach(n => n.remove());

    // Prefer the posts-index title provided by the template (when available)
        const originalSiteTitle =
      (document.body && document.body.getAttribute('data-posts-index-title')) ||
      (document.querySelector('.site-title') && document.querySelector('.site-title').textContent.trim()) ||
      (document.title || '').replace(/\s+/g, ' ').trim() ||
      'Site';

    const sepAttr = (document.body && document.body.getAttribute('data-title-sep')) || '';
    const SEP = (sepAttr && sepAttr.trim()) || '-';

    document.title = `Searching '${s}' ${SEP} ${originalSiteTitle}`;

    // Keep og:title in sync with <title>
    let ogTitle = document.querySelector('meta[property="og:title"]');
    if (!ogTitle) {
      ogTitle = document.createElement('meta');
      ogTitle.setAttribute('property', 'og:title');
      document.head.appendChild(ogTitle);
    }
    ogTitle.setAttribute('content', document.title);
  })();

  hideWidgetsOnLivePage();

  // -------- Clear <main> and mount search UI --------
  const main = document.querySelector('main');
  if (main) main.innerHTML = '';

  const wrap = document.createElement('section');
  wrap.className = 'search-wrap';
  wrap.innerHTML = `
    <form class="search-bar-row" role="search" aria-label="Live site search">
      <input type="search" class="search-input" placeholder="Search the site…" aria-label="Search the site" value="">
      <button type="submit" class="search-btn" aria-label="Run search">Search</button>
    </form>
    <div class="search-results" role="list" aria-live="polite"></div>
  `;
  if (main) main.appendChild(wrap);

  const form = wrap.querySelector('.search-bar-row');
  const input = wrap.querySelector('.search-input');
  const button = wrap.querySelector('.search-btn');
  const resultsEl = wrap.querySelector('.search-results');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      updateUrlAndSearch('');
    }
  });
  input.focus();

  function updateUrlAndSearch(q) {
    const url = new URL(location.href);
    // Always keep ?s=; blank string is valid and should still show the search UI
    url.searchParams.set('s', q || '');
    history.replaceState(null, '', url.toString());
    doSearch(q);
  }

  // Form submit (Enter key) or button click → update URL + search
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    updateUrlAndSearch((input.value || '').trim());
  });
  if (button) {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      updateUrlAndSearch((input.value || '').trim());
    });
  }

  // -------- Robust JSON loader --------
  const idxUrl = BASE.replace(/\/+$/, '/') + 'search-index.json';

  fetch(idxUrl)
    .then(async (r) => {
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 100)}`);
      return parsePossiblyWrappedJSON(txt);
    })
    .then(json => runSearch(json))
    .catch(err => {
      console.warn('[site-search] failed to load index', idxUrl, err);
      runSearch({ docs: [], limits: { excerpt_words: EXCERPT_WORDS } });
    });

  function parsePossiblyWrappedJSON(txt) {
    if (!txt) return [];
    // Strip UTF-8 BOM if present
    if (txt.charCodeAt(0) === 0xFEFF) {
      txt = txt.slice(1);
    }
    const trimmed = txt.trim();

    // If it already looks like JSON, parse directly
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return JSON.parse(trimmed); } catch (_) {}
    }

    // If we got HTML (e.g., error page), try to extract a JSON block
    const firstArr = trimmed.indexOf('[');
    const firstObj = trimmed.indexOf('{');
    const choose = (openIdx, closeChar) => {
      if (openIdx === -1) return '';
      const closeIdx = trimmed.lastIndexOf(closeChar);
      if (closeIdx === -1 || closeIdx <= openIdx) return '';
      return trimmed.slice(openIdx, closeIdx + 1);
    };
    const arrSlice = choose(firstArr, ']');
    const objSlice = choose(firstObj, '}');
    const slice = arrSlice || objSlice;

    if (slice) {
      try { return JSON.parse(slice); } catch (e) {
        console.warn('[site-search] JSON slice parse failed', e, { slice: slice.slice(0, 100) });
      }
    }

    console.warn('[site-search] response did not contain parseable JSON. First 100 chars:', trimmed.slice(0, 100));
    return [];
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function toPlainText(value) {
    const str = String(value || '');
    if (!str) return '';

    // Fast path when no tags are present
    if (!/[<>]/.test(str)) {
      return str.replace(/\s+/g, ' ').trim();
    }

    // Use DOM parsing to drop tags and normalize whitespace
    const div = document.createElement('div');
    div.innerHTML = str;
    const txt = (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
    return txt;
  }

  function normalizeText(s) {
    return toPlainText(s).toLowerCase();
  }

  function enforceWordLimit(s, n) {
    const parts = toPlainText(s).split(' ');
    return parts.slice(0, Math.max(0, n)).join(' ').trim();
  }

  function clampExcerpt(text, limit = EXCERPT_LIMIT) {
    const normalized = toPlainText(text);
    if (!normalized) return '';

    const parts = normalized.split(' ');
    const n = Math.max(0, limit);
    if (parts.length <= n) return normalized;

    const hasLeadingEllipsis = normalized.startsWith('…');
    const hasTrailingEllipsis = normalized.endsWith('…');
    const sliced = parts.slice(0, n).join(' ').trim();
    const prefix = hasLeadingEllipsis ? '… ' : '';
    const suffix = hasTrailingEllipsis ? '' : ' …';
    return (prefix + sliced + suffix).replace(/\s+/g, ' ').trim();
  }
  // Prefer excerpts where available (e.g., Home cards); otherwise use full text.
  // Re-centers around exact phrases/terms when possible, then trims to the word limit.
  function surroundExcerpt(fullText, terms, wordLimit = EXCERPT_LIMIT, phrases = []) {
    const phraseList = Array.isArray(phrases) ? phrases.filter(Boolean) : (phrases ? [phrases] : []);
    const text = toPlainText(fullText);
    if (!text) return '';

    const lower = text.toLowerCase();
    for (const phrase of phraseList) {
      const phraseLower = phrase.toLowerCase();
      const idxP = lower.indexOf(phraseLower);
      if (idxP !== -1) {
        const radiusChars = 480; // generous context window before word trimming
        const start = Math.max(0, idxP - Math.floor(radiusChars / 2));
        const end = Math.min(text.length, idxP + phrase.length + Math.floor(radiusChars / 2));
        return enforceWordLimit(
          (start > 0 ? '… ' : '') + text.slice(start, end).trim() + (end < text.length ? ' …' : ''),
          wordLimit
        );
      }
    }

    // Fallback around first term
    const t = (terms || []).filter(Boolean);
    if (t.length) {
      const re = new RegExp('(' + t.map(x => escapeRegExp(x)).join('|') + ')', 'i');
      const m = text.match(re);
      if (m && typeof m.index === 'number') {
        const idx = m.index;
        const radiusChars = 360;
        const start = Math.max(0, idx - Math.floor(radiusChars / 2));
        const end = Math.min(text.length, idx + Math.floor(radiusChars / 2));
        return enforceWordLimit(
          (start > 0 ? '… ' : '') + text.slice(start, end).trim() + (end < text.length ? ' …' : ''),
          wordLimit
        );
      }
    }

    // Final fallback: take start of text, then trim to word limit
    return enforceWordLimit(text, wordLimit);
  }

  // Highlight: exact phrases take priority, then individual terms (>=3 chars)
  function highlight(html, terms, phrases = []) {
    if (!html) return '';
    let out = String(html);

    const phraseList = Array.isArray(phrases) ? phrases.filter(p => p && p.trim().length > 0) : (phrases ? [phrases] : []);
    for (const phrase of phraseList) {
      const rePhrase = new RegExp(escapeRegExp(phrase), 'gi');
      out = out.replace(rePhrase, '<mark class="phrase">$&</mark>');
    }

    const t = (terms || []).filter(w => w.length >= 3);
    if (t.length) {
      const re = new RegExp('(' + t.map(x => escapeRegExp(x)).join('|') + ')', 'gi');
      // Avoid re-highlighting inside the phrase mark
      out = out.replace(re, (m) => {
        // If already inside a phrase mark near this occurrence, keep as-is
        return /<\/mark>\s*$/.test(out.slice(0, out.indexOf(m))) ? m : `<mark>${m}</mark>`;
      });
    }
    return out;
  }

  // Shared, debounced doSearch assigned later (after MiniSearch init)
  let doSearch = () => {};

  function renderResults(items, query = '', phrases = []) {
    if (!resultsEl) return;
    if (!items || !items.length) {
      resultsEl.innerHTML = `<div class="search-empty" role="status">No results yet. Try a different search.</div>`;
      return;
    }
    const terms = query.split(/\s+/).filter(Boolean).filter(w => w.length >= 3);
    const phraseList = Array.isArray(phrases) ? phrases : [phrases];
    resultsEl.innerHTML = items.map(r => {
      const date = r.date_display || '';
      const dateHtml = date ? `<div class="search-date">${date}</div>` : '';
      const typeHtml = r.kind ? `<span class="search-kind">${r.kind}</span>` : '';
      return `
        <a class="search-item" role="listitem" href="${r.url}">
          <div class="search-title-row">
            <div class="search-title">${highlight(r.title || '', terms, phraseList)}</div>
            ${typeHtml}
          </div>
          ${dateHtml}
          <div class="search-excerpt">${highlight((r.excerpt || ''), terms, phraseList)}</div>
        </a>
      `;
    }).join('');
  }

  function runSearch(raw) {
    if (!window.MiniSearch) {
      console.error('[site-search] MiniSearch is not loaded');
      return null;
    }

    // ---- Payload: { docs: [...], limits: { excerpt_words, ... }, ... }
    if (!raw || !Array.isArray(raw.docs)) {
      console.error('[site-search] invalid index payload: expected { docs: [...] }');
      renderResults([], '');
      return null;
    }
    EXCERPT_LIMIT = (raw.limits && Number(raw.limits.excerpt_words)) || EXCERPT_WORDS;
    const docs = raw.docs;

    // Ignore words shorter than 3 characters everywhere (index + queries)
    const processTerm = (term /*, fieldName */) => {
      if (!term) return null;
      const t = String(term).toLowerCase().trim();
      // strip surrounding punctuation
      const cleaned = t.replace(/^[\p{P}\p{Z}\s]+|[\p{P}\p{Z}\s]+$/gu, '');
      return cleaned.length >= 3 ? cleaned : null;
    };

    // Normalize backend → runtime fields (content/description → text/excerpt)
    const dataset = docs.map((d, i) => {
      const text = d.content || '';
      const excerpt = clampExcerpt(d.description || text, EXCERPT_LIMIT);
      const dateIso = d.date || '';
      const dateDisplay = d.date_display || (
        dateIso ? new Date(dateIso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : ''
      );
      return {
        id: d.id ?? i,
        title: d.title || '',
        text,
        excerpt,
        url: d.url || '',
        date: dateIso,
        date_display: dateDisplay,
        kind: d.kind || ''
      };
    });
      
    // Precompute a normalized blob per item for fast phrase scan
    const normCache = new Map();
    for (const d of dataset) {
      const blob = [d.title, d.excerpt, d.text].filter(Boolean).join(' ');
      normCache.set(d.id, normalizeText(blob));
    }

    const mini = new window.MiniSearch({
      fields: ['title', 'text', 'excerpt'],
      storeFields: ['title', 'text', 'excerpt', 'url', 'date', 'date_display', 'kind'],
      idField: 'id',
      processTerm, // <— omit < 3 char words from index & queries
      searchOptions: {
        fields: ['title', 'text', 'excerpt'],
        boost: { title: 3, text: 1 },
        prefix: true,
        fuzzy: 0.15
      }
    });

    mini.addAll(dataset);
    return mountUI(mini, dataset, normCache);
  }

  function mountUI(mini, dataset, normCache) {
    // Run a search with the given query; prioritize exact-phrase matches
    doSearch = (q) => {
      q = (q || '').trim();
      if (!q) { renderResults([]); return; }

      const { phrases, terms: rawTerms } = parseQuery(q);
      const terms = rawTerms.filter(w => w.length >= 3);
      const phraseFilters = phrases.map(p => normalizeText(p)).filter(Boolean);

      // 1) Exact-phrase pass (substring over normalized title+excerpt+text)
      const phraseHits = [];
      if (phraseFilters.length) {
        for (const item of dataset) {
          const norm = normCache.get(item.id) || '';
          if (phraseFilters.every(ph => norm.includes(ph))) {
            const totalLen = phraseFilters.reduce((acc, p) => acc + p.length, 0);
            phraseHits.push({
              id: item.id,
              // strong score to float to top; length factor favors longer phrases a bit
              _score: 1000 + Math.min(totalLen, 150),
            });
          }
        }
      }

      const searchString = [...phrases, ...rawTerms].join(' ').trim() || q;
      // 2) MiniSearch relevance pass
      const msHits = mini.search(searchString, {
        fields: ['title', 'text', 'excerpt'],
        boost: { title: 3, text: 1 },
        prefix: true,
        fuzzy: 0.15
      }).map(h => ({ id: h.id, _score: h.score }))
        .filter(h => {
          if (!phraseFilters.length) return true;
          const norm = normCache.get(h.id) || '';
          return phraseFilters.every(ph => norm.includes(ph));
        });

      // 3) Merge: phrase hits first, then minisearch (dedupe by id; keep best score ordering)
      const seen = new Set();
      const merged = [];

      phraseHits.sort((a, b) => b._score - a._score);
      for (const ph of phraseHits) {
        if (!seen.has(ph.id)) {
          seen.add(ph.id);
          merged.push(ph);
        }
      }
      for (const mh of msHits) {
        if (!seen.has(mh.id)) {
          seen.add(mh.id);
          merged.push(mh);
        }
      }

      // Enrich for rendering (prefer excerpt; center around phrase if present)
      const enriched = merged.map(h => {
        const item = dataset.find(d => d.id === h.id) || {};
        const normText = normalizeText(item.text || '');
        const normExcerpt = normalizeText(item.excerpt || '');
        const useFullText = (() => {
          if (!item.text) return false;
          if (phraseFilters.length) return phraseFilters.some(ph => normText.includes(ph));
          if (!terms.length) return false;
          const textHit = terms.some(t => normText.includes(t));
          const excerptHit = terms.some(t => normExcerpt.includes(t));
          return textHit && !excerptHit;
        })();
        const baseText = useFullText ? item.text : (item.excerpt || item.text || '');
        const around = clampExcerpt(surroundExcerpt(baseText, terms, EXCERPT_LIMIT, phrases), EXCERPT_LIMIT);
        return {
          url: item.url,
          title: item.title,
          date: item.date,
          date_display: item.date_display,
          kind: item.kind,
          excerpt: around,
          _score: h._score
        };
      });

      renderResults(enriched, q, phrases);
    };

    // Live input: pressing Enter is handled by form submit; here we do incremental search
    input.addEventListener('input', () => doSearch(input.value));

    // Seed from current ?s=
    input.value = s;
    doSearch(s);
    document.documentElement.classList.remove('search-preparing');
    return doSearch;
  }

  function parseQuery(raw) {
    const q = (raw || '').trim();
    const phrases = [];
    const re = /"([^"]+)"/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      if (m[1] && m[1].trim()) {
        phrases.push(m[1].trim());
      }
    }
    const remainder = q.replace(re, ' ');
    const terms = remainder.split(/\s+/).filter(Boolean);
    return { phrases, terms };
  }
})();
