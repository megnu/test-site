/*
 * static/frontend/js/search_init.js
 * Minimal bootstrap:
 *  - Makes any <form class="site-search-widget"> submit to BASE?s=...
 *  - If the URL has ?s=, ensures we’re on BASE and lazy-loads MiniSearch + search.js
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
(function () {
  // -------- figure out site BASE (/sites/<name>/ in preview, "/" in export) --------
  function basePath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'sites' && parts[1]) {
      return `/${['sites', parts[1], ''].join('/')}`; // "/sites/<site>/"
    }
    return '/';
  }
  const BASE = basePath();

  // Current query (if any)
  const qs = new URLSearchParams(location.search);
  const s  = (qs.get('s') || '').trim();
  const hasSParam = new URLSearchParams(location.search).has('s');

  // -------- make the “widget” form submit to BASE?s= --------
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    if (!f.classList.contains('site-search-widget')) return;
    e.preventDefault();
    const input = f.querySelector('input[name="s"], input[type="search"]');
    const q = input ? (input.value || '').trim() : '';
    const url = new URL(BASE, location.origin);
    // Always keep ?s=; blank string is valid and should mount the search UI
    url.searchParams.set('s', q || '');
    location.assign(url.toString());
  });

  // -------- if we have ?s= but we’re not at BASE, redirect to BASE --------
  if (hasSParam && location.pathname !== BASE) {
    const url = new URL(BASE, location.origin);
    url.searchParams.set('s', s); // may be ''
    location.replace(url.toString());
    return;
  }

  // Helper: load a script once
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      // already present?
      if ([...document.scripts].some(sc => (sc.src || '').endsWith(src))) {
        resolve();
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      el.defer = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Failed to load ' + src));
      document.body.appendChild(el);
    });
  }

  // If there’s no ?s= at all, do nothing more (don’t load the runtime)
  if (!hasSParam) return;

  // -------- we’re on the live search page: lazy-load MiniSearch + the runtime --------
  const JS_BASE = BASE.replace(/\/+$/, '/') + 'static/frontend/js/';

  // Load in order: minisearch -> search.js (the full UI/runtime)
  loadScript(JS_BASE + 'minisearch.min.js')
    .then(() => loadScript(JS_BASE + 'search.js'))
    .catch(err => {
      console.error('[search_init] failed to lazy-load search runtime:', err);
      // Graceful fallback: leave page as-is (the search.js won’t mount)
      document.documentElement.classList.remove('search-preparing');
    });
})();
