// ==UserScript==
// @name         あいもげ総合カタログ あにまん風UI
// @namespace    https://nijiurachan.net/
// @version      2.0.0
// @author       official-aimg
// @license      MIT
// @homepageURL  https://github.com/nijiurachan/aimoge-animanch-theme
// @supportURL   https://github.com/nijiurachan/aimoge-animanch-theme/issues
// @updateURL    https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js
// @downloadURL  https://raw.githubusercontent.com/nijiurachan/aimoge-animanch-theme/main/aimoge-animanch-theme.user.js
// @description  あいもげ総合カタログとスレッドをあにまん掲示板風に表示します。
// @match        https://nijiurachan.net/mix
// @match        https://nijiurachan.net/mix/*
// @noframes
// @run-at       document-start
// @grant        GM_addStyle
// @grant        unsafeWindow
// @sandbox      raw
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 official-aimg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* catalog-sort-adapter:start */
function createAnimanchCatalogSortAdapter(pageWindow, options) {
  const API_ORIGIN = 'https://api.nijiurachan.net';
  const FETCH_LIMIT = 300;
  const DEFAULT_LIMIT = 100;
  const MAX_NATIVE_PAGE = 100000;
  const MAX_FETCH_PAGES = 40;
  const MAX_THREADS = FETCH_LIMIT * MAX_FETCH_PAGES;
  const MAX_PAGE_BYTES = 4 * 1024 * 1024;
  const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
  const MAX_CACHE_BYTES = 16 * 1024 * 1024;
  const MAX_ACTIVE_BYTES = 32 * 1024 * 1024;
  const MAX_CACHE_FAMILIES = 16;
  const MAX_ACTIVE_JOBS = 24;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const originalFetch = pageWindow.fetch;
  const snapshots = new Map();
  const jobs = new Set();
  let cacheBytes = 0;
  let activeBytes = 0;
  let epoch = 0;
  let mode = null;
  let disposed = false;
  let failed = null;

  if (typeof options?.isActive !== 'function' || typeof options.onError !== 'function') {
    throw new TypeError('Catalog sort requires isActive and onError');
  }

  function abortError() {
    const error = new pageWindow.DOMException('Catalog sort request cancelled', 'AbortError');
    error.catalogSortCancelled = true;
    return error;
  }

  function failure(message, code = 'CATALOG_INVALID') {
    const error = new Error(`Catalog sort: ${message}`);
    error.catalogSortCode = code;
    return error;
  }

  function isActive() {
    return !disposed && mode !== null && options.isActive();
  }

  function clearSnapshots() {
    snapshots.clear();
    cacheBytes = 0;
  }

  function invalidate() {
    epoch += 1;
    failed = null;
    clearSnapshots();
    for (const job of jobs) job.controller.abort();
  }

  function reportFailure(error, requestEpoch) {
    if (requestEpoch !== epoch || !isActive()) return abortError();
    if (failed) return failed;
    if (error?.catalogSortCancelled === true) return error;
    const known = typeof error?.catalogSortCode === 'string';
    const message = known ? error.message : 'Catalog sort: catalog request failed';
    const code = known ? error.catalogSortCode : 'CATALOG_NETWORK';
    // Native quota requests rethrow AbortError; other Errors would silently omit that board.
    failed = new pageWindow.DOMException(message, 'AbortError');
    for (const job of jobs) job.controller.abort();
    try { options.onError({ mode, message, code }); } catch { /* UI reporting cannot resume fetches. */ }
    return failed ?? abortError();
  }

  function descriptor(input, init) {
    const isRequest = input instanceof pageWindow.Request;
    const method = init?.method ?? (isRequest ? input.method : 'GET');
    if (String(method).toUpperCase() !== 'GET') return null;
    let url;
    try {
      url = new pageWindow.URL(isRequest ? input.url : String(input), pageWindow.location.href);
    } catch {
      return null;
    }
    if (url.origin !== API_ORIGIN || url.username || url.password) return null;
    const mixed = url.pathname === '/catalog-mix';
    if (!mixed && !/^\/catalog\/[^/]+$/.test(url.pathname)) return null;
    if (mixed && !url.searchParams.get('b')?.trim()) return null;
    if (url.searchParams.get('sort') !== 'bump') return null;
    const page = Number(url.searchParams.get('page') ?? 1);
    const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    if (!Number.isInteger(page) || page < 1 || page > MAX_NATIVE_PAGE ||
        !Number.isInteger(limit) || limit < 1 || limit > FETCH_LIMIT) {
      throw failure('invalid requested pagination');
    }
    const family = new pageWindow.URL(url.href);
    family.searchParams.delete('page');
    family.searchParams.delete('limit');
    family.searchParams.sort();
    return { url, family: family.href, page, limit, mixed, isRequest };
  }

  function assertCurrent(job) {
    if (job.controller.signal.aborted || job.epoch !== epoch || !isActive()) {
      throw abortError();
    }
  }

  function pruneSnapshots() {
    const now = Date.now();
    for (const [key, snapshot] of snapshots) {
      if (now - snapshot.completedAt > CACHE_TTL_MS) {
        snapshots.delete(key);
        cacheBytes -= snapshot.bytes;
      }
    }
  }

  function storeSnapshot(key, snapshot) {
    const previous = snapshots.get(key);
    if (previous) cacheBytes -= previous.bytes;
    snapshots.delete(key);
    while (snapshots.size >= MAX_CACHE_FAMILIES || cacheBytes + snapshot.bytes > MAX_CACHE_BYTES) {
      const oldestKey = snapshots.keys().next().value;
      const oldest = snapshots.get(oldestKey);
      snapshots.delete(oldestKey);
      cacheBytes -= oldest.bytes;
    }
    snapshots.set(key, snapshot);
    cacheBytes += snapshot.bytes;
  }

  function sanitizedHeaders(response) {
    const headers = new pageWindow.Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding',
      'content-range', 'etag', 'content-md5', 'digest', 'content-digest', 'repr-digest',
      'signature', 'signature-input', 'set-cookie', 'set-cookie2']) headers.delete(name);
    headers.set('content-type', 'application/json; charset=utf-8');
    return headers;
  }

  async function readCatalog(response, expectedPage, expectedLimit, mixed, job) {
    assertCurrent(job);
    if (!response.ok) throw failure(`catalog request failed (${response.status})`, 'CATALOG_HTTP');
    const clone = response.clone();
    const reader = clone.body?.getReader();
    if (!reader) throw failure('catalog body missing');
    const decoder = new pageWindow.TextDecoder();
    let text = '';
    let bytes = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    job.controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (true) {
        const chunk = await reader.read();
        assertCurrent(job);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        job.bytes += chunk.value.byteLength;
        activeBytes += chunk.value.byteLength;
        if (bytes > MAX_PAGE_BYTES || job.bytes > MAX_SNAPSHOT_BYTES ||
            activeBytes > MAX_ACTIVE_BYTES) {
          throw failure('catalog memory limit exceeded', 'CATALOG_LIMIT');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      cancelReader();
      throw error;
    } finally {
      job.controller.signal.removeEventListener('abort', cancelReader);
      reader.releaseLock();
    }
    let payload;
    try { payload = JSON.parse(text); } catch { throw failure('invalid catalog JSON'); }
    const pagination = payload?.pagination;
    if (payload?.sort !== 'bump' || !Array.isArray(payload.threads) ||
        payload.threads.length > expectedLimit || pagination?.page !== expectedPage ||
        pagination?.limit !== expectedLimit || typeof pagination?.hasNextPage !== 'boolean' ||
        (pagination.hasNextPage && payload.threads.length === 0)) {
      throw failure('invalid catalog pagination or schema');
    }
    for (const thread of payload.threads) {
      if (!thread || typeof thread.id !== 'string' || !thread.id ||
          !Number.isInteger(thread.replyCount) || thread.replyCount < 0 ||
          typeof thread.createdAt !== 'string' || !Number.isFinite(Date.parse(thread.createdAt)) ||
          (mixed && (typeof thread.b !== 'string' || !thread.b))) {
        throw failure('invalid catalog thread');
      }
    }
    return payload;
  }

  function shuffle(threads) {
    const words = new Uint32Array(1);
    for (let index = threads.length - 1; index > 0; index -= 1) {
      const span = index + 1;
      const ceiling = Math.floor(4294967296 / span) * span;
      do { pageWindow.crypto.getRandomValues(words); } while (words[0] >= ceiling);
      const other = words[0] % span;
      [threads[index], threads[other]] = [threads[other], threads[index]];
    }
  }

  async function collect(input, init, request, job) {
    // The original call keeps its exact arguments; additional GETs inherit its request options.
    const nativeResponse = await originalFetch.call(pageWindow, input, init);
    assertCurrent(job);
    const nativePayload = await readCatalog(nativeResponse, request.page, request.limit, request.mixed, job);
    const date = Date.parse(nativeResponse.headers.get('date') ?? '');
    const referenceNow = Number.isFinite(date) ? date : Date.now();
    const unique = new Map();
    let firstPayload;
    for (let page = 1; page <= MAX_FETCH_PAGES; page += 1) {
      assertCurrent(job);
      let payload;
      if (page === 1 && request.page === 1 && request.limit === FETCH_LIMIT) {
        payload = nativePayload;
      } else {
        const url = new pageWindow.URL(request.url.href);
        url.searchParams.set('page', String(page));
        url.searchParams.set('limit', String(FETCH_LIMIT));
        const nextInput = request.isRequest ? new pageWindow.Request(url.href, input) : url.href;
        const nextInit = { ...init, signal: job.controller.signal };
        const response = await originalFetch.call(pageWindow, nextInput, nextInit);
        assertCurrent(job);
        payload = await readCatalog(response, page, FETCH_LIMIT, request.mixed, job);
      }
      if (!firstPayload) firstPayload = payload;
      for (const thread of payload.threads) if (!unique.has(thread.id)) unique.set(thread.id, thread);
      if (unique.size > MAX_THREADS) throw failure('catalog thread limit exceeded', 'CATALOG_LIMIT');
      if (!payload.pagination.hasNextPage) {
        const threads = [...unique.values()];
        if (job.mode === 'kaso') {
          const momentum = (thread) => thread.replyCount /
            Math.max(Math.floor((referenceNow - Date.parse(thread.createdAt)) / 3600000), 1);
          threads.sort((a, b) => momentum(a) - momentum(b) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        } else {
          shuffle(threads);
        }
        assertCurrent(job);
        return { payload: firstPayload, threads, bytes: job.bytes, completedAt: Date.now(),
          headers: sanitizedHeaders(nativeResponse), status: nativeResponse.status,
          statusText: nativeResponse.statusText };
      }
    }
    throw failure(`catalog exceeds ${MAX_FETCH_PAGES} full pages`, 'CATALOG_LIMIT');
  }

  function responseFor(snapshot, request) {
    const offset = (request.page - 1) * request.limit;
    const payload = { ...snapshot.payload, sort: 'bump',
      threads: snapshot.threads.slice(offset, offset + request.limit),
      pagination: { page: request.page, limit: request.limit,
        hasNextPage: offset + request.limit < snapshot.threads.length } };
    return new pageWindow.Response(JSON.stringify(payload), {
      status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers,
    });
  }

  async function transformedFetch(input, init, request) {
    const signal = init?.signal ?? (request.isRequest ? input.signal : null);
    if (signal?.aborted) throw abortError();
    pruneSnapshots();
    const cached = snapshots.get(request.family);
    if (request.page !== 1) {
      if (cached) return responseFor(cached, request);
      throw failure('catalog snapshot unavailable; refresh the first page', 'CATALOG_SNAPSHOT');
    }
    // A new first page replaces that family's snapshot; no failed refresh can resurrect old data.
    if (cached) {
      snapshots.delete(request.family);
      cacheBytes -= cached.bytes;
    }
    for (const pending of jobs) {
      if (pending.family === request.family && request.page === 1) pending.controller.abort();
    }
    if (jobs.size >= MAX_ACTIVE_JOBS) {
      throw failure('too many concurrent catalog requests', 'CATALOG_LIMIT');
    }
    const job = { controller: new pageWindow.AbortController(), epoch, mode,
      family: request.family, bytes: 0 };
    const abort = () => job.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    jobs.add(job);
    let rejectCancellation;
    const cancelled = new Promise((resolve, reject) => { rejectCancellation = reject; });
    const onCancel = () => rejectCancellation(abortError());
    job.controller.signal.addEventListener('abort', onCancel, { once: true });
    try {
      const collection = collect(input, init, request, job).finally(() => {
        jobs.delete(job);
        activeBytes -= job.bytes;
      });
      const snapshot = await Promise.race([collection, cancelled]);
      assertCurrent(job);
      storeSnapshot(request.family, snapshot);
      return responseFor(snapshot, request);
    } finally {
      signal?.removeEventListener('abort', abort);
      job.controller.signal.removeEventListener('abort', onCancel);
    }
  }

  function wrappedFetch(input, init) {
    if (!isActive()) return originalFetch.call(pageWindow, input, init);
    const requestEpoch = epoch;
    let request;
    try { request = descriptor(input, init); } catch (error) {
      return Promise.reject(reportFailure(error, requestEpoch));
    }
    if (!request) return originalFetch.call(pageWindow, input, init);
    if (failed) return Promise.reject(failed);
    return transformedFetch(input, init, request)
      .catch((error) => { throw reportFailure(error, requestEpoch); });
  }

  pageWindow.fetch = wrappedFetch;
  return {
    setMode(nextMode) {
      if (nextMode !== null && nextMode !== 'kaso' && nextMode !== 'shuffle') {
        throw new TypeError('Unknown catalog sort mode');
      }
      mode = nextMode;
      invalidate();
    },
    getMode() { return mode; },
    invalidate,
    dispose() {
      disposed = true;
      mode = null;
      invalidate();
      if (pageWindow.fetch === wrappedFetch) pageWindow.fetch = originalFetch;
    },
  };
}
  /* catalog-sort-adapter:end */

  const ROOT_CLASS = 'aimoge-animanch-active';
  const SHELL_ID = 'aimoge-animanch-shell';
  const CATALOG_NAV_ID = 'aimoge-animanch-catalog-nav';
  const STYLE_ID = 'aimoge-animanch-style';
  const INIT_KEY = '__aimogeAnimanchThemeV2';
  const BOARD_MENU_ID = 'aimoge-animanch-board-menu';
  const NO_REPLY_TIMEOUT_MS = 4000;
  const POST_REPORT_TIMEOUT_MS = 4000;
  const POST_REPORT_DOUBLE_CLICK_MS = 800;
  const SORTS = [
    { value: 'bump', label: '更新順', nativeLabel: '更新順' },
    { value: 'new', label: '新着', nativeLabel: '新順' },
    { value: 'replies', label: '人気', nativeLabel: '多順' },
    { value: 'kaso', label: '過疎' },
    { value: 'shuffle', label: 'シャッフル' },
  ];
  const GOOD_THRESHOLDS = [2, 5, 11, 21, 31, 41, 101];
  const SORT_OPTION_BY_VALUE = new Map(
    SORTS.filter((sort) => sort.nativeLabel).map((sort) => [sort.value, sort.nativeLabel]),
  );
  SORT_OPTION_BY_VALUE.set('old', '古順');
  const VALID_NATIVE_SORTS = new Set(SORT_OPTION_BY_VALUE.keys());
  const VALID_SORTS = new Set([...VALID_NATIVE_SORTS, 'kaso', 'shuffle']);

  const isMixPath = () =>
    window.location.hostname === 'nijiurachan.net' &&
    (window.location.pathname === '/mix' ||
      window.location.pathname.startsWith('/mix/'));

  if (!isMixPath() || window[INIT_KEY]) return;
  window[INIT_KEY] = true;

  const css = `
:root.${ROOT_CLASS} {
  --aimoge-page-width: 1200px;
  --aimoge-columns-wide: 5;
  --aimoge-columns-narrow: 3;
  --aimoge-thumbnail-size: 70px;
  --aimoge-thumbnail-size-small: 50px;
  --aimoge-copy-lines: 4;
  --aimoge-copy-font-size: 12px;
  --aimoge-copy-line-height: 1.1;
  --aimoge-font-family: Meiryo, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Arial, sans-serif;
  --aimoge-blue: #104cd0;
  --aimoge-selected: #0d6efd;
  --aimoge-border: #ccc;
  --aimoge-muted: #555;
  --aimoge-count-bg: #555;
  --aimoge-report-bg: #104cd0;
  --aimoge-panel: rgba(255, 255, 255, 0.8);
  --aimoge-form-surface: #fff;
  --aimoge-copy: #444;
  --aimoge-bg: #edece8;
  --aimoge-page-gradient: linear-gradient(#edece8 1%, #fff 50%, #edece8 100%);
  --aimoge-good1-size: 16px;
  --aimoge-good2-size: 18px;
  --aimoge-good3-size: 18px;
  --aimoge-good4-size: 19px;
  --aimoge-good5-size: 19px;
  --aimoge-good6-size: 20px;
  --aimoge-good7-size: 22px;
  --aimoge-info-bg: #d1e7dd;
  --aimoge-info-border: #badbcc;
  --aimoge-info-fg: #0f5132;
  color-scheme: light;
}

:root.${ROOT_CLASS}:not(.light-mode) {
  --aimoge-blue: #5bf;
  --aimoge-border: #444;
  --aimoge-muted: #aaa;
  --aimoge-panel: rgba(17, 17, 17, 0.96);
  --aimoge-form-surface: #111;
  --aimoge-copy: #ddd;
  --aimoge-bg: #181818;
  --aimoge-page-gradient: linear-gradient(#181818 1%, #111 50%, #181818 100%);
  --aimoge-info-bg: #132e24;
  --aimoge-info-border: #285f42;
  --aimoge-info-fg: #a3cfbb;
  color-scheme: dark;
}

:root.light-mode.${ROOT_CLASS} {
  --color-background: #edece8;
  --color-foreground: #444;
  --color-primary: #104cd0;
  --color-primary-foreground: #fff;
  --color-secondary: #0d6efd;
  --color-secondary-foreground: #fff;
  --color-muted: #f2f1ed;
  --color-muted-foreground: #666;
  --color-accent: #104cd0;
  --color-accent-foreground: #fff;
  --color-border: #ccc;
  --color-card: rgba(255, 255, 255, 0.95);
  --color-card-foreground: #444;
}

:root.${ROOT_CLASS}:not(.light-mode) {
  --color-background: #181818;
  --color-foreground: #ddd;
  --color-primary: #5bf;
  --color-primary-foreground: #111;
  --color-secondary: #333;
  --color-secondary-foreground: #fff;
  --color-muted: #242424;
  --color-muted-foreground: #aaa;
  --color-accent: #5bf;
  --color-accent-foreground: #111;
  --color-border: #444;
  --color-card: #111;
  --color-card-foreground: #ddd;
}

:root.${ROOT_CLASS} body {
  min-height: 100vh;
  background: var(--aimoge-page-gradient);
  color: var(--aimoge-copy);
  font-family: var(--aimoge-font-family);
  font-size: 14px;
}

:root.${ROOT_CLASS} :is(button, input, textarea, select) {
  font-family: var(--aimoge-font-family);
}

:root.${ROOT_CLASS} #app-root,
:root.${ROOT_CLASS} #app-root > .min-h-screen,
:root.${ROOT_CLASS} #app-root .desktop-app {
  background: transparent;
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root .desktop-app {
  --desktop-paper: var(--aimoge-panel);
  --desktop-ink: var(--aimoge-copy);
  --desktop-link: var(--aimoge-blue);
  --desktop-card: var(--aimoge-panel);
}

:root.${ROOT_CLASS} #main-content,
:root.${ROOT_CLASS} .desktop-main,
:root.${ROOT_CLASS} .desktop-catalog-page,
:root.${ROOT_CLASS} .desktop-thread-page {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--aimoge-page-width);
  margin-inline: auto;
}

:root.${ROOT_CLASS} #app-root h1.catalog-page-title,
:root.${ROOT_CLASS} #app-root .desktop-catalog-page > h1.desktop-mode-title {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root aside[aria-label="お知らせ"],
:root.${ROOT_CLASS} #app-root .aimg-announce-root {
  box-sizing: border-box;
  width: 100%;
  margin: 0 0 10px;
  padding: 10px;
  border: 1px solid var(--aimoge-info-border);
  border-radius: 0;
  background: var(--aimoge-info-bg);
  color: var(--aimoge-info-fg);
}

:root.${ROOT_CLASS} #app-root .aimg-announce-root * {
  color: inherit !important;
}

:root.${ROOT_CLASS} .desktop-catalog-page,
:root.${ROOT_CLASS} .desktop-thread-page {
  background: var(--aimoge-panel);
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root > .min-h-screen #main-content {
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} #app-root .desktop-thread-page .desktop-mode-title {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root section[aria-label="スレッド本文"] > div > h1 {
  display: none !important;
}

:root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-heading {
  box-sizing: border-box;
  display: block;
  width: 100%;
  max-width: var(--aimoge-page-width);
  margin: 0 auto 8px;
  padding: 0.2em 0.3em;
  border: 0;
  background: var(--aimoge-panel);
  color: var(--aimoge-copy);
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
}

:root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-heading[hidden] {
  display: none !important;
}

/* 既存ヘッダーの機能・portalは残し、見えるヘッダーだけシェルへ置き換える。 */
:root.${ROOT_CLASS} #app-root .desktop-header,
:root.${ROOT_CLASS} #app-root .min-h-screen > header {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root nav.desktop-catalog-toolbar {
  box-sizing: border-box;
  display: flex !important;
  position: relative;
  width: 100%;
  min-height: 0;
  gap: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

:root.${ROOT_CLASS} #app-root nav.desktop-catalog-toolbar > :not(.desktop-catalog-toolbar-tag-filter) {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root nav.desktop-catalog-toolbar > .desktop-catalog-toolbar-tag-filter:not([hidden]) {
  display: block !important;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--aimoge-border);
  background: var(--aimoge-panel);
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root nav[aria-label="カタログメニュー"],
:root.${ROOT_CLASS} #app-root nav.fixed.bottom-0,
:root.${ROOT_CLASS} #app-root nav[aria-label="スレッドナビゲーション"] {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-fab,
:root.${ROOT_CLASS} #app-root .desktop-thread-reply-fab {
  display: none !important;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page a {
  color: var(--aimoge-blue);
}

:root.${ROOT_CLASS} #app-root .desktop-app .desktop-mode-title {
  margin: 8px 0;
  padding: 4px 0;
  border-bottom: 2px solid var(--aimoge-blue);
  background: transparent;
  color: var(--aimoge-blue);
  font-size: 16px;
  line-height: 1.3;
  text-align: left;
}

/* あにまん風の共通ヘッダー。 */
:root.${ROOT_CLASS} #${SHELL_ID} {
  position: relative;
  z-index: 30;
  width: 100%;
  color: var(--aimoge-copy);
  font-family: var(--aimoge-font-family);
}

:root.${ROOT_CLASS} #${SHELL_ID}[hidden],
:root.${ROOT_CLASS} #${SHELL_ID} [hidden] {
  display: none !important;
}

:root.${ROOT_CLASS} #${CATALOG_NAV_ID}[hidden],
:root.${ROOT_CLASS} #${CATALOG_NAV_ID} [hidden] {
  display: none !important;
}

:root.${ROOT_CLASS} .aimoge-header {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: var(--aimoge-page-width);
  min-height: 50px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-inline: auto;
  padding: 0;
  border-bottom: 1px solid var(--aimoge-border);
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} .aimoge-brand {
  flex: 0 0 auto;
  color: var(--aimoge-blue) !important;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.15;
  text-decoration: none;
  white-space: nowrap;
}

:root.${ROOT_CLASS} .aimoge-menu-toggle {
  display: none;
  min-width: 40px;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--aimoge-border);
  border-radius: 3px;
  background: var(--aimoge-panel);
  color: var(--aimoge-blue);
  font-size: 22px;
}

:root.${ROOT_CLASS} .aimoge-menu-icon {
  display: block;
  width: 18px;
  height: 14px;
  background:
    linear-gradient(currentColor 0 0) top / 100% 2px,
    linear-gradient(currentColor 0 0) center / 100% 2px,
    linear-gradient(currentColor 0 0) bottom / 100% 2px;
  background-repeat: no-repeat;
}

:root.${ROOT_CLASS} .aimoge-header-nav {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 0;
}

:root.${ROOT_CLASS} .aimoge-header-links {
  display: flex;
  flex: 1 1 0;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 0;
}

:root.${ROOT_CLASS} .aimoge-header-links a,
:root.${ROOT_CLASS} .aimoge-header-links button {
  display: inline-flex;
  min-height: 50px;
  align-items: center;
  padding: 0 15px;
  border: 0;
  background: transparent;
  color: var(--aimoge-copy);
  font: inherit;
  font-size: 14px;
  line-height: 50px;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

:root.${ROOT_CLASS} .aimoge-header-links :is(a, button):hover {
  text-decoration: underline;
}

:root.${ROOT_CLASS} .aimoge-search-form {
  display: flex;
  flex: 0 0 320px;
  min-width: 320px;
  height: 35px;
  align-items: center;
  gap: 0;
  border: 1px solid var(--aimoge-border);
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} .aimoge-search-form select {
  box-sizing: border-box;
  width: 78px;
  min-width: 78px;
  height: 33px;
  padding: 3px 5px;
  border: 0;
  border-right: 1px solid var(--aimoge-border);
  background: transparent;
  color: var(--aimoge-copy);
  font-size: 12px;
}

:root.${ROOT_CLASS} .aimoge-search-form input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 33px;
  padding: 4px 7px;
  border: 0;
  background: transparent;
  color: var(--aimoge-copy);
  font-size: 13px;
}

:root.${ROOT_CLASS} .aimoge-search-form button {
  width: 20%;
  min-width: 44px;
  height: 33px;
  border: 0;
  border-left: 1px solid var(--aimoge-border);
  background: #eee;
  color: #444;
  font-size: 18px;
  cursor: pointer;
}

:root.${ROOT_CLASS} .aimoge-theme-toggle {
  gap: 8px;
}

:root.${ROOT_CLASS} .aimoge-theme-switch {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 20px;
  border-radius: 10px;
  background: #aaa;
}

:root.${ROOT_CLASS} .aimoge-theme-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  content: "";
  transition: transform 120ms ease;
}

:root.${ROOT_CLASS} .aimoge-theme-toggle[aria-checked="true"] .aimoge-theme-switch {
  background: var(--aimoge-selected);
}

:root.${ROOT_CLASS} .aimoge-theme-toggle[aria-checked="true"] .aimoge-theme-switch::after {
  transform: translateX(18px);
}

:root.${ROOT_CLASS} .aimoge-thread-breadcrumbs {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  max-width: var(--aimoge-page-width);
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  margin: 0 auto 5px;
  padding: 0.2em 0.3em;
  line-height: 1.15;
  background: var(--aimoge-panel);
  color: var(--aimoge-muted);
  font-size: 14px;
}

:root.${ROOT_CLASS} .aimoge-thread-breadcrumbs :is(a, [data-board-crumb], [data-thread-tag], [data-thread-title]) {
  display: inline-block;
  padding: 0.2em 0.3em;
  border-radius: 5px;
  background: var(--aimoge-blue);
  color: #fff;
  opacity: 0.7;
  text-decoration: none;
}

:root.${ROOT_CLASS} .aimoge-thread-tag-list {
  display: contents;
}

:root.${ROOT_CLASS} .aimoge-thread-tag-list[hidden] {
  display: none;
}

:root.${ROOT_CLASS} .aimoge-thread-breadcrumbs a:hover {
  text-decoration: underline;
}

:root.${ROOT_CLASS} .aimoge-thread-breadcrumbs [aria-hidden="true"] {
  margin: 0 0.5em;
}

/* 5つの既存ソートと板入口を、6等分のタブとして表示する。 */
:root.${ROOT_CLASS} .aimoge-catalog-nav {
  position: relative;
  display: grid;
  width: 100%;
  max-width: var(--aimoge-page-width);
  grid-template-columns: repeat(6, minmax(0, 1fr));
  grid-column: 1 / -1;
  margin: 0 auto 10px;
  border-bottom: 1px solid var(--aimoge-border);
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} .aimoge-catalog-tab {
  box-sizing: border-box;
  display: flex;
  min-width: 0;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 2px;
  border: 0;
  border-right: 1px solid var(--aimoge-border);
  border-radius: 0;
  background: transparent;
  color: var(--aimoge-blue);
  font: inherit;
  font-size: 13px;
  line-height: 1.1;
  cursor: pointer;
}

:root.${ROOT_CLASS} .aimoge-catalog-tab[aria-pressed="true"] {
  background: var(--aimoge-selected);
  color: #fff;
  font-weight: 700;
}

:root.${ROOT_CLASS} .aimoge-tab-icon {
  display: inline-flex;
  flex: 0 0 26px;
  width: 26px;
  height: 30px;
  align-items: center;
  justify-content: center;
}

:root.${ROOT_CLASS} .aimoge-tab-icon svg {
  display: block;
  width: 20px;
  height: 20px;
}

:root.${ROOT_CLASS} .aimoge-board-caret {
  flex: 0 0 10px;
  width: 10px;
  height: 10px;
  margin-left: 2px;
}

:root.${ROOT_CLASS} .aimoge-sort-status {
  grid-column: 1 / -1;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #badbcc;
  background: #f8d7da;
  color: #842029;
  font-size: 13px;
}

:root.${ROOT_CLASS} .aimoge-board-popover {
  position: absolute;
  z-index: 40;
  top: calc(100% + 1px);
  right: 0;
  display: grid;
  width: min(260px, calc(100vw - 20px));
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--aimoge-border);
  background: var(--aimoge-panel);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
}

:root.${ROOT_CLASS} .aimoge-board-popover button {
  min-height: 36px;
  padding: 5px 8px;
  border: 1px solid var(--aimoge-border);
  border-radius: 2px;
  background: var(--aimoge-panel);
  color: var(--aimoge-blue);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

:root.${ROOT_CLASS} .aimoge-board-popover button:hover {
  background: var(--aimoge-selected);
  color: #fff;
}

/* カタログを隙間のない横画像・本文タイルへ揃える。 */
:root.${ROOT_CLASS} #app-root .desktop-catalog-grid-wrap {
  width: 100%;
  max-width: none;
  margin: 0;
  overflow: visible;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-grid {
  box-sizing: border-box;
  display: grid;
  width: 100% !important;
  min-width: 0 !important;
  grid-template-columns: repeat(var(--aimoge-columns-wide), minmax(0, 1fr)) !important;
  grid-auto-rows: auto;
  gap: 0;
  padding: 0;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-item {
  box-sizing: border-box;
  min-width: 0;
  overflow: visible;
  border: 0;
  border-right: 1px solid var(--aimoge-border);
  border-bottom: 1px solid var(--aimoge-border);
  border-radius: 0;
  background: var(--aimoge-panel);
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-item > a {
  box-sizing: border-box;
  display: grid !important;
  min-width: 0;
  grid-template-columns: var(--aimoge-thumbnail-size) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  align-items: start;
  gap: 0 4px;
  padding: 3px;
  color: var(--aimoge-copy);
  text-decoration: none;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-thumb {
  box-sizing: border-box;
  width: var(--aimoge-thumbnail-size) !important;
  min-width: var(--aimoge-thumbnail-size);
  height: var(--aimoge-thumbnail-size);
  max-height: var(--aimoge-thumbnail-size) !important;
  grid-column: 1;
  grid-row: 1 / span 2;
  margin: 0;
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-thumb img,
:root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell img {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-text,
:root.${ROOT_CLASS} #app-root .desktop-catalog-page .catalog-item-text {
  box-sizing: border-box;
  display: -webkit-box !important;
  min-width: 0;
  max-height: calc(var(--aimoge-copy-font-size) * var(--aimoge-copy-line-height) * var(--aimoge-copy-lines));
  overflow: hidden !important;
  color: var(--aimoge-copy);
  font-size: var(--aimoge-copy-font-size);
  font-weight: 400;
  line-height: var(--aimoge-copy-line-height);
  overflow-wrap: anywhere;
  white-space: normal !important;
  -webkit-box-orient: vertical !important;
  -webkit-line-clamp: var(--aimoge-copy-lines) !important;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-item > a > .desktop-catalog-text {
  grid-column: 2;
  grid-row: 1;
  margin: 0;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-count {
  grid-column: 2;
  grid-row: 2;
  justify-self: end;
  align-self: end;
  margin: 0;
  padding: 1px 5px;
  border-radius: 2px;
  background: var(--aimoge-count-bg);
  color: #fff;
  font-size: 11px;
  line-height: 1.2;
}

:root.${ROOT_CLASS} #app-root .desktop-catalog-footer {
  min-height: 0;
  padding: 0 3px 3px;
}

:root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--aimoge-page-width);
  grid-template-columns: repeat(var(--aimoge-columns-narrow), minmax(0, 1fr)) !important;
  gap: 0;
  margin-inline: auto;
  padding: 0;
}

:root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid > article[data-catalog-layout-key] {
  box-sizing: border-box;
  display: grid;
  min-width: 0;
  grid-template-columns: var(--aimoge-thumbnail-size) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  align-items: start;
  gap: 0 4px;
  padding: 3px;
  border: 0;
  border-right: 1px solid var(--aimoge-border);
  border-bottom: 1px solid var(--aimoge-border);
  border-radius: 0;
  background: var(--aimoge-panel);
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell {
  box-sizing: border-box;
  width: var(--aimoge-thumbnail-size) !important;
  min-width: var(--aimoge-thumbnail-size);
  height: var(--aimoge-thumbnail-size);
  max-height: var(--aimoge-thumbnail-size) !important;
  grid-column: 1;
  grid-row: 1 / span 2;
  margin: 0;
  overflow: hidden;
  background: var(--aimoge-panel);
}

:root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell > a,
:root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell > a > div {
  box-sizing: border-box;
  display: block;
  width: 100% !important;
  height: 100%;
  max-height: 100% !important;
}

:root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid > article[data-catalog-layout-key] > header {
  min-width: 0;
  grid-column: 2;
  grid-row: 1;
  margin: 0;
  padding: 0;
}

:root.${ROOT_CLASS} #app-root .catalog-item-text {
  box-sizing: border-box;
  display: -webkit-box !important;
  min-width: 0;
  max-height: calc(var(--aimoge-copy-font-size) * var(--aimoge-copy-line-height) * var(--aimoge-copy-lines));
  overflow: hidden !important;
  padding: 0;
  color: var(--aimoge-copy);
  font-size: var(--aimoge-copy-font-size);
  line-height: var(--aimoge-copy-line-height);
  overflow-wrap: anywhere;
  white-space: normal !important;
  -webkit-box-orient: vertical !important;
  -webkit-line-clamp: var(--aimoge-copy-lines) !important;
}

:root.${ROOT_CLASS} #app-root .catalog-item-tags-row {
  box-sizing: border-box;
  min-width: 0;
  grid-column: 2;
  grid-row: 2;
  margin: 0;
  padding: 0;
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} #app-root .catalog-item-tags-row .catalog-tags {
  flex-wrap: wrap;
}

/* OPタグはパンくずへ残し、スレッド本文上の元表示だけ隠す。 */
:root.${ROOT_CLASS} #app-root .desktop-thread-page .desktop-thread-op .thread-op-tags,
:root.${ROOT_CLASS} #app-root main#main-content > section[aria-label="スレッド本文"] > div.pb-14 > div#post-0.relative > ul.thread-op-tags[aria-label="タグ"] {
  display: none !important;
}

/* 仮想化リストはarticleの外寸を親へ正しく返し、本文面だけ中央幅にする。 */
:root.${ROOT_CLASS} #app-root .thread-post-article {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  max-width: var(--aimoge-page-width);
  margin: 0 auto;
  padding: 0 1% 3em;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--aimoge-copy);
  font-size: 14px;
}

:root.${ROOT_CLASS} #app-root .thread-post-article > header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 8px;
  padding: 0 0 4px;
  border-bottom: 1px solid var(--aimoge-blue);
  color: var(--aimoge-blue);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
}

:root.${ROOT_CLASS} #app-root .aimoge-post-report-slot {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  margin-left: 4px;
  vertical-align: middle;
}

:root.${ROOT_CLASS} #app-root .aimoge-post-report {
  box-sizing: border-box;
  display: inline-flex;
  min-width: 34px;
  min-height: 22px;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  border: 1px solid var(--aimoge-report-bg);
  border-radius: 2px;
  background: var(--aimoge-report-bg);
  color: #fff;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

:root.${ROOT_CLASS} #app-root .aimoge-post-report:hover {
  filter: brightness(0.92);
}

:root.${ROOT_CLASS} #app-root .aimoge-post-report:focus-visible {
  outline: 2px solid var(--aimoge-report-bg);
  outline-offset: 2px;
}

:root.${ROOT_CLASS} #app-root .thread-post-body {
  order: -1;
  width: 100%;
  margin-inline: auto;
  font-size: 16px;
  line-height: 1.45;
}

:root.${ROOT_CLASS} #app-root .thread-post-content {
  display: flex !important;
  align-items: stretch;
  flex-direction: column !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-attachments {
  order: 0;
  width: 100%;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="1"] .thread-post-body {
  font-size: var(--aimoge-good1-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="2"] .thread-post-body {
  font-size: var(--aimoge-good2-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="3"] .thread-post-body {
  color: #5555ff !important;
  font-size: var(--aimoge-good3-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="4"] .thread-post-body {
  color: #9966ff !important;
  font-size: var(--aimoge-good4-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="5"] .thread-post-body {
  color: #ff9466 !important;
  font-size: var(--aimoge-good5-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="6"] .thread-post-body {
  color: #ff6666 !important;
  font-size: var(--aimoge-good6-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root .thread-post-article[data-aimoge-good-level="7"] .thread-post-body {
  color: #ff6666 !important;
  font-size: var(--aimoge-good7-size) !important;
  font-weight: 700 !important;
}

:root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count] {
  padding: 4.8px 8px !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  color: #ff8800 !important;
  font-size: 0 !important;
}

:root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count]::before {
  content: "♡";
  color: #ff8800;
  font-size: 16px;
}

:root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count]:is(button[disabled], data)::before {
  content: "♥";
}

:root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count]::after {
  content: attr(data-aimoge-soudane-display);
  margin-inline-start: 0.25em;
  color: #ff8800;
  font-size: 12px;
}

:root.${ROOT_CLASS} #app-root .desktop-thread-scroll,
:root.${ROOT_CLASS} #app-root .desktop-thread-post-list,
:root.${ROOT_CLASS} #app-root section[aria-label="スレッド本文"] {
  box-sizing: border-box;
  width: 100%;
  max-width: var(--aimoge-page-width);
  margin-inline: auto;
}

:root.${ROOT_CLASS} #app-root [aria-label="返信フォーム"],
:root.${ROOT_CLASS} #app-root .desktop-floating-form {
  color: var(--aimoge-copy);
}

:root.${ROOT_CLASS} .desktop-floating-panel.desktop-thread-create-panel {
  --thread-create-panel-background: var(--aimoge-form-surface);
  --thread-create-heading-background: var(--aimoge-blue);
  --thread-create-label-background: var(--aimoge-form-surface);
  --thread-create-ink: var(--aimoge-copy);
  --thread-create-input-background: var(--aimoge-form-surface);
  --thread-create-input-border: var(--aimoge-border);
  --thread-create-accent: var(--aimoge-border);
  background: var(--aimoge-form-surface) !important;
  color: var(--aimoge-copy) !important;
}

:root.${ROOT_CLASS} .desktop-thread-create-panel .desktop-floating-label,
:root.${ROOT_CLASS} .desktop-thread-create-panel .desktop-thread-create-body textarea {
  background: var(--aimoge-form-surface) !important;
  color: var(--aimoge-copy) !important;
}

:root.${ROOT_CLASS} #app-root :is(textarea, input:not([type="checkbox"]):not([type="radio"]), select) {
  border-color: var(--aimoge-border);
}

/* 右下の操作ボタンは独自の外観にし、クリック処理は元のbuttonへ渡す。 */
:root.${ROOT_CLASS} .aimoge-quick-actions {
  position: fixed;
  z-index: 60;
  right: max(16px, calc((100vw - var(--aimoge-page-width)) / 2 + 16px));
  bottom: 16px;
  display: grid;
  gap: 7px;
}

:root.${ROOT_CLASS} .aimoge-quick-action {
  box-sizing: border-box;
  display: flex;
  width: 42px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--aimoge-border);
  border-radius: 3px;
  background: var(--aimoge-panel);
  color: var(--aimoge-muted);
  font: inherit;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.25);
}

:root.${ROOT_CLASS} .aimoge-quick-action:focus-visible,
:root.${ROOT_CLASS} .aimoge-catalog-tab:focus-visible,
:root.${ROOT_CLASS} .aimoge-menu-toggle:focus-visible {
  outline: 2px solid var(--aimoge-blue);
  outline-offset: 2px;
}

:root.${ROOT_CLASS} .aimoge-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 767.98px) {
  :root.${ROOT_CLASS} .aimoge-header {
    position: relative;
    height: 50px;
    min-height: 50px;
    flex-wrap: wrap;
    row-gap: 0;
    padding: 0 5px;
    border-bottom: 0;
  }

  :root.${ROOT_CLASS} .aimoge-header[data-menu-open="true"] {
    height: auto;
  }

  :root.${ROOT_CLASS} .aimoge-brand {
    box-sizing: border-box;
    flex: 0 0 200px;
    width: 200px;
    height: 50px;
    font-size: 28.5px;
    font-weight: 400;
    letter-spacing: -0.5px;
    line-height: 50px;
  }

  :root.${ROOT_CLASS} .aimoge-menu-toggle {
    display: inline-flex;
    box-sizing: border-box;
    width: 40.45px;
    min-width: 40.45px;
    height: 30.45px;
    min-height: 30.45px;
    margin-right: 10px;
    padding: 2.5px 7.5px;
    border-color: rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    background: #fff;
    color: #777;
    font-size: 0;
    line-height: 1;
  }

  :root.${ROOT_CLASS} .aimoge-header-nav {
    display: none;
    box-sizing: border-box;
    width: calc(100% + 10px);
    align-items: stretch;
    flex-direction: column;
    margin-inline: -5px;
    padding: 0;
    border-top: 1px solid var(--aimoge-border);
    background: var(--aimoge-panel);
  }

  :root.${ROOT_CLASS} .aimoge-header[data-menu-open="true"] .aimoge-header-nav {
    display: flex;
  }

  :root.${ROOT_CLASS} .aimoge-header-links {
    box-sizing: border-box;
    flex: 0 1 auto;
    width: 100%;
    align-items: stretch;
    flex-direction: column;
    gap: 0;
  }

  :root.${ROOT_CLASS} .aimoge-header-links :is(a, button) {
    box-sizing: border-box;
    display: flex;
    flex: 0 0 50px;
    width: 100%;
    min-height: 50px;
    padding: 0 15px;
    border: 0;
    line-height: 50px;
  }

  :root.${ROOT_CLASS} .aimoge-header-links .aimoge-theme-toggle {
    flex-basis: 51px;
    height: 51px;
    min-height: 51px;
  }

  :root.${ROOT_CLASS} .aimoge-search-form {
    box-sizing: border-box;
    flex: 0 0 auto;
    width: calc(100% - 20px);
    min-width: 0;
    height: 35px;
    margin: 10px;
    padding: 0;
    border: 0;
  }

  :root.${ROOT_CLASS} .aimoge-search-form select {
    border: 1px solid var(--aimoge-border);
  }

  /* スマートフォンのスレッド面を白いキャンバスにそろえる。 */
  :root.${ROOT_CLASS} #app-root > .min-h-screen:has(> main#main-content > section[aria-label="スレッド本文"]),
  :root.${ROOT_CLASS} #app-root > .min-h-screen:has(> main#main-content > section[aria-label="スレッド本文"]) > main#main-content {
    background: var(--aimoge-form-surface);
  }

  :root.${ROOT_CLASS} #${SHELL_ID}:has(.aimoge-thread-heading:not([hidden])) {
    display: flow-root;
    background: var(--aimoge-form-surface);
  }

  :root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-breadcrumbs:not([hidden]) {
    display: block;
    margin: 0 auto 14px;
    padding: 10px 7px 0;
    background: var(--aimoge-form-surface);
    font-size: 14px;
    line-height: 21px;
  }

  :root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-breadcrumbs :is(a, [data-board-crumb], [data-thread-tag], [data-thread-title]) {
    margin-bottom: 7px;
    padding: 2.8px 4.2px;
    line-height: 16.1px;
  }

  :root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-breadcrumbs [aria-hidden="true"] {
    line-height: 21px;
  }

  :root.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-heading {
    min-width: 0;
    width: calc(100% - 9px);
    margin: 0 0 9px 9px;
    padding: 0 9px;
    background: var(--aimoge-form-surface);
    font-size: 18px;
    line-height: 25.2px;
    overflow-wrap: anywhere;
  }

  :root.light-mode.${ROOT_CLASS} #${SHELL_ID} .aimoge-thread-heading,
  :root.light-mode.${ROOT_CLASS} #app-root .thread-post-article .thread-post-body {
    color: #212529;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article {
    padding: 0 0 42px;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article > header {
    display: block;
    margin: 0 0 6px;
    padding: 3.6px 0 3.6px 2.4px;
    border: 0;
    border-bottom: 1px solid var(--aimoge-blue);
    font-size: 12px;
    line-height: 18px;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article > header > p.flex {
    display: contents;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article > header > p.flex :is(time, .post-no) {
    margin-right: 3.6px;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article > header > button[aria-label="メニュー"] {
    display: inline-flex;
    float: right;
    align-items: center;
    vertical-align: middle;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article .reply-number-in-thread {
    box-sizing: border-box;
    display: inline-block;
    width: 30px;
    margin-right: 3.6px;
    padding: 3.6px 1.2px;
    border: 1px solid var(--aimoge-border);
    border-radius: 0;
    background: var(--aimoge-form-surface);
    color: var(--aimoge-blue);
    line-height: 18px;
    text-align: center;
    vertical-align: middle;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article .reply-number-in-thread::before {
    content: "»";
  }

  :root.${ROOT_CLASS} #app-root .aimoge-post-report-slot {
    display: inline-block;
    margin: 3.9px 0 0 6.5px;
    vertical-align: middle;
  }

  :root.${ROOT_CLASS} #app-root .aimoge-post-report {
    display: inline-block;
    min-width: 0;
    min-height: 0;
    padding: 3.9px 1.3px;
    border: 1px solid transparent;
    border-radius: 0;
    font-size: 13px;
    line-height: 13px;
    vertical-align: middle;
  }

  :root.light-mode.${ROOT_CLASS} #app-root .aimoge-post-report {
    background: #0541a2;
    opacity: 0.5;
  }

  :root.light-mode.${ROOT_CLASS} #app-root .aimoge-post-report:hover {
    background: #104cd0;
    filter: none;
    opacity: 1;
  }

  :root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count] {
    display: inline-block;
    padding: 4.2px 7px !important;
    line-height: 14px !important;
    vertical-align: middle;
  }

  :root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count]::before {
    font-size: 14px;
    font-weight: 400;
    line-height: 14px;
  }

  :root.${ROOT_CLASS} #app-root [data-aimoge-soudane-count]::after {
    font-size: 12px;
    font-weight: 400;
    line-height: 14px;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article .thread-post-body {
    box-sizing: border-box;
    padding-inline: 0.3em;
    line-height: 1.5 !important;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article .thread-post-attachments figure {
    margin: 10px 0 0;
    padding: 0 4.2px;
  }

  :root.${ROOT_CLASS} #app-root .thread-post-article .thread-post-attachments img {
    box-sizing: border-box;
    padding: 3px;
    border: 1px solid var(--aimoge-border);
    border-radius: 0;
  }

  :root.${ROOT_CLASS} .aimoge-quick-actions {
    display: flex;
    align-items: center;
    flex-direction: row;
  }

  :root.${ROOT_CLASS} .aimoge-quick-action {
    width: 40px;
    height: 40px;
  }

  :root.${ROOT_CLASS} [role="dialog"]:has(section[aria-label="返信フォーム"]) {
    background: var(--aimoge-form-surface) !important;
  }

  :root.${ROOT_CLASS} #app-root .desktop-catalog-page .desktop-catalog-grid {
    grid-template-columns: repeat(var(--aimoge-columns-narrow), minmax(0, 1fr)) !important;
  }

  :root.${ROOT_CLASS} .aimoge-catalog-tab {
    min-height: 40px;
    font-size: 11px;
  }

  :root.${ROOT_CLASS} .aimoge-quick-actions {
    right: 10px;
    bottom: max(10px, env(safe-area-inset-bottom));
    gap: 5px;
  }

  :root.${ROOT_CLASS} .aimoge-quick-action {
    width: 40px;
    height: 40px;
    font-size: 18px;
  }
}

@media (max-width: 575.8px) {
  :root.${ROOT_CLASS} {
    --aimoge-thumbnail-size: var(--aimoge-thumbnail-size-small);
  }

  :root.${ROOT_CLASS} .aimoge-menu-toggle {
    flex: 0 0 40.45px;
  }

  :root.${ROOT_CLASS} .aimoge-catalog-nav {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border-bottom: 0;
    background: transparent;
  }

  :root.${ROOT_CLASS} .aimoge-catalog-tab {
    min-height: 43px;
    gap: 0;
    padding: 5px 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    font-size: 14px;
    font-weight: 400;
    line-height: 21px;
    white-space: nowrap;
  }

  :root.${ROOT_CLASS} .aimoge-catalog-tab[data-sort="shuffle"],
  :root.${ROOT_CLASS} .aimoge-catalog-tab[data-action="board-toggle"] {
    grid-column: span 2;
  }

  :root.${ROOT_CLASS} .aimoge-catalog-tab[aria-pressed="true"] {
    border-radius: 2.5px;
    font-weight: 400;
  }

  :root.${ROOT_CLASS} .aimoge-tab-icon {
    display: inline-flex;
    flex: 0 0 26px;
    width: 26px;
    height: 30px;
    align-items: center;
    justify-content: center;
  }

  :root.${ROOT_CLASS} .aimoge-tab-icon svg {
    display: block;
    width: 20px;
    height: 20px;
  }

  :root.${ROOT_CLASS} .aimoge-board-caret {
    flex: 0 0 10px;
    width: 10px;
    height: 10px;
    margin-left: 2px;
  }

  :root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid {
    grid-auto-flow: row !important;
    grid-auto-rows: 51px;
    align-items: stretch;
  }

  :root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid > article[data-catalog-layout-key] {
    height: 51px;
    grid-template-columns: 50px minmax(0, 1fr);
    grid-template-rows: 50px;
    align-items: stretch;
    gap: 0;
    padding: 0;
    border: 0;
    border-right: 1px solid var(--aimoge-border);
    border-bottom: 1px solid var(--aimoge-border);
    border-radius: 2.5px;
    overflow: hidden;
  }

  :root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell {
    position: relative;
    grid-row: 1;
    margin: 0;
  }

  :root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell img {
    object-fit: fill;
  }

  :root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell .catalog-configured-thumb > data {
    box-sizing: border-box;
    position: absolute;
    z-index: 10;
    right: auto;
    bottom: 0;
    left: 0;
    display: flex;
    width: 50px;
    min-height: 16px;
    align-items: center;
    justify-content: center;
    gap: 2px;
    margin: 0;
    padding: 2px 3px;
    border: 0;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
    font-size: 10px;
    font-weight: 400;
    line-height: 11px;
    text-align: center;
  }

  :root.${ROOT_CLASS} #app-root .catalog-thumbnail-shell .catalog-configured-thumb > data::before {
    content: "";
    display: block;
    flex: 0 0 8px;
    width: 8px;
    height: 7px;
    background: currentColor;
    clip-path: polygon(0 0, 100% 0, 100% 75%, 40% 75%, 15% 100%, 20% 75%, 0 75%);
  }

  :root.${ROOT_CLASS} #app-root section[aria-label="スレッドカタログ"].grid > article[data-catalog-layout-key] > header {
    height: 50px;
    grid-row: 1;
  }

  :root.${ROOT_CLASS} #app-root .catalog-item-text {
    height: 50px;
    max-height: 50px;
    overflow: hidden !important;
    padding: 2.2px 1.1px;
    font-size: 11px;
    line-height: 12.1px;
  }

  :root.${ROOT_CLASS} #app-root .catalog-item-tags-row,
  :root.${ROOT_CLASS} #app-root .desktop-catalog-footer {
    display: none !important;
  }
}
`;

  let shell;
  let catalogNav;
  let catalogSortAdapter;
  let nativeSortBridgeDepth = 0;
  let observer;
  let pendingAction = null;
  let pendingNoReply = null;
  let pendingNoReplies = [];
  let pendingNoReplyTimer = null;
  let pendingNoReplyPollTimer = null;
  let pendingPostReport = null;
  let pendingPostReportTimer = null;
  let pendingPostReportPollTimer = null;
  let lastPostReportActivation = null;
  let pendingSettingsNavigation = false;
  let scheduled = false;
  let previousRoutePath = null;
  let previousBoardSelection = null;
  let previousPageKind = null;

  const appRoot = () => document.getElementById('app-root');
  const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const isInsideOwnedUI = (node) => {
    if (!(node instanceof Node)) return false;
    const reportSlot = node instanceof Element
      ? node.closest('[data-aimoge-post-report-slot]')
      : node.parentElement?.closest('[data-aimoge-post-report-slot]');
    return node === shell || shell?.contains(node) || node === catalogNav ||
      catalogNav?.contains(node) || Boolean(reportSlot);
  };

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    if (typeof GM_addStyle === 'function') {
      const style = GM_addStyle(css);
      if (style && !style.id) style.id = STYLE_ID;
      if (style) return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).append(style);
  }

  function createShell() {
    const element = document.createElement('div');
    element.id = SHELL_ID;
    element.innerHTML = `
      <header class="aimoge-header" data-menu-open="false">
        <a class="aimoge-brand" href="/mix/">総合＠あいもげ</a>
        <button class="aimoge-menu-toggle" type="button" data-action="menu-toggle"
          aria-label="メニュー" aria-expanded="false" aria-controls="aimoge-theme-menu"><span class="aimoge-menu-icon" aria-hidden="true"></span></button>
        <nav id="aimoge-theme-menu" class="aimoge-header-nav" aria-label="サイトメニュー">
          <div class="aimoge-header-links">
            <a href="#" data-action="source-link" data-native-label="利用規約" hidden>利用規約</a>
            <a href="/mix/announcements" data-action="source-link" data-native-label="告知">告知</a>
            <button type="button" data-action="settings">個人設定</button>
            <a href="#" data-action="source-link" data-native-label="Wiki" hidden>Wiki</a>
            <a href="#" data-action="source-link" data-native-label="API" hidden>API</a>
            <button class="aimoge-theme-toggle" type="button" data-action="theme-toggle"
              role="switch" aria-label="ダークモード" aria-checked="false">
              <span class="aimoge-theme-switch" aria-hidden="true"></span><span>ダークモード</span>
            </button>
          </div>
          <form class="aimoge-search-form" data-action="search-submit" role="search">
            <label class="aimoge-visually-hidden" for="aimoge-theme-search">投稿検索</label>
            <select id="aimoge-theme-search-scope" aria-label="投稿検索の検索モード">
              <option value="all">全文</option><option value="op">スレ文</option>
            </select>
            <input id="aimoge-theme-search" name="q" type="search" placeholder="投稿検索" autocomplete="off">
            <button type="submit" aria-label="検索">⌕</button>
          </form>
        </nav>
      </header>
      <nav class="aimoge-thread-breadcrumbs" aria-label="パンくずリスト" hidden>
        <a href="/mix/">総合</a><span aria-hidden="true">»</span>
        <span data-board-crumb>板</span><span aria-hidden="true" data-board-tag-separator hidden>»</span>
        <span class="aimoge-thread-tag-list" data-thread-tags hidden></span>
        <span aria-hidden="true">»</span>
        <span data-thread-title>スレッド</span>
      </nav>
      <h1 class="aimoge-thread-heading" hidden>スレッド</h1>
      <div class="aimoge-quick-actions" aria-label="ページ操作">
        <button class="aimoge-quick-action" type="button" data-action="top" aria-label="上へ" title="上へ">↑</button>
        <button class="aimoge-quick-action" type="button" data-action="refresh" aria-label="更新" title="更新">↻</button>
        <button class="aimoge-quick-action" type="button" data-action="auto" aria-label="自動更新を有効にする" title="自動更新を有効にする" aria-pressed="false">↻</button>
        <button class="aimoge-quick-action" type="button" data-action="post" aria-label="投稿フォーム" title="投稿フォーム">✎</button>
        <button class="aimoge-quick-action" type="button" data-action="settings" aria-label="設定" title="設定">⚙</button>
      </div>`;
    element.hidden = true;
    element.addEventListener('click', handleShellClick);
    element.addEventListener('submit', handleShellSubmit);
    element.addEventListener('change', handleShellChange);
    return element;
  }

  function createCatalogNav() {
    const element = document.createElement('nav');
    element.id = CATALOG_NAV_ID;
    element.className = 'aimoge-catalog-nav';
    element.setAttribute('aria-label', 'カタログ並び順');
    element.hidden = true;
    element.innerHTML = `
      <button class="aimoge-catalog-tab" type="button" data-action="sort" data-sort="bump" aria-pressed="false"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="refresh-arrow" viewBox="0 0 24 24" focusable="false"><path d="M5.5 8A8 8 0 0 1 19 6l1.5 2M20.5 8V3.5M20.5 8H16M18.5 16A8 8 0 0 1 5 18l-1.5-2M3.5 16v4.5M3.5 16H8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg></span><span class="aimoge-tab-label">更新順</span></button>
      <button class="aimoge-catalog-tab" type="button" data-action="sort" data-sort="new" aria-pressed="false"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="clock" viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg></span><span class="aimoge-tab-label">新着</span></button>
      <button class="aimoge-catalog-tab" type="button" data-action="sort" data-sort="replies" aria-pressed="false"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="bar-chart" viewBox="0 0 24 24" focusable="false"><path d="M4 20h16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6"/><rect x="6" y="12" width="3" height="8" rx="0.6" fill="currentColor"/><rect x="10.5" y="8" width="3" height="12" rx="0.6" fill="currentColor"/><rect x="15" y="4" width="3" height="16" rx="0.6" fill="currentColor"/></svg></span><span class="aimoge-tab-label">人気</span></button>
      <button class="aimoge-catalog-tab" type="button" data-action="sort" data-sort="kaso" aria-pressed="false"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="speaker" viewBox="0 0 24 24" focusable="false"><path d="M3 9v6h4l6 4V5L7 9H3Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8"/></svg></span><span class="aimoge-tab-label">過疎</span></button>
      <button class="aimoge-catalog-tab" type="button" data-action="sort" data-sort="shuffle" aria-pressed="false"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="shuffle-arrows" viewBox="0 0 24 24" focusable="false"><path d="M4 7h2c4.8 0 6.8 10 11.5 10H20m0 0-3-3m3 3-3 3M4 17h2c1.7 0 2.8-1.3 3.8-3M14 10c1-1.6 1.9-3 3.5-3H20m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg></span><span class="aimoge-tab-label">シャッフル</span></button>
      <button class="aimoge-catalog-tab" type="button" data-action="board-toggle" aria-expanded="false" aria-controls="${BOARD_MENU_ID}"><span class="aimoge-tab-icon" aria-hidden="true"><svg data-icon="folder" viewBox="0 0 24 24" focusable="false"><path d="M3 6h7l2 2h9v10H3V6Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.8"/><path d="M3.5 10h17" stroke="currentColor" stroke-width="1.5"/></svg></span><span class="aimoge-tab-label">板</span><svg class="aimoge-board-caret" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg></button>
      <div id="${BOARD_MENU_ID}" class="aimoge-board-popover" hidden>
        <button type="button" data-action="board-filter">表示する板を選択</button>
        <button type="button" data-action="sort" data-sort="old">並び順: 古い順</button>
      </div>`;
    const status = document.createElement('p');
    status.className = 'aimoge-sort-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    element.append(status);
    element.addEventListener('click', handleShellClick);
    return element;
  }

  function ensureShell() {
    const existing = document.getElementById(SHELL_ID);
    if (existing) {
      shell = existing;
      return shell;
    }
    const root = appRoot();
    if (!root?.parentElement) return null;
    shell = createShell();
    root.parentElement.insertBefore(shell, root);
    return shell;
  }

  function ensureCatalogNav() {
    const existing = document.getElementById(CATALOG_NAV_ID);
    if (existing instanceof HTMLElement) catalogNav = existing;
    if (!catalogNav) catalogNav = createCatalogNav();
    return catalogNav;
  }

  function placeCatalogNav() {
    const nav = ensureCatalogNav();
    const root = appRoot();
    const isDesktopCatalog = Boolean(root?.querySelector('.desktop-catalog-page'));
    const grid = isDesktopCatalog
      ? root?.querySelector('.desktop-catalog-page .desktop-catalog-grid')
      : root?.querySelector('section[aria-label="スレッドカタログ"].grid');
    if (!isMixPath() || !isCatalogScreen() || !grid?.parentElement) {
      nav.remove();
      nav.hidden = true;
      return;
    }
    if (grid.previousElementSibling !== nav) grid.parentElement.insertBefore(nav, grid);
    nav.hidden = false;
  }

  function findNativeLink(label) {
    const root = appRoot();
    if (!root) return null;
    const links = Array.from(
      root.querySelectorAll(
        '.desktop-header-utilities a.desktop-header-link, .desktop-header-links a.desktop-header-link, .min-h-screen > header nav[aria-label="サイトメニュー"] a',
      ),
    );
    return (
      links.find((link) => {
        const text = normalizeText(link.textContent);
        return (
          text === label ||
          text.startsWith(`${label} `) ||
          text.startsWith(`${label}NEW`)
        );
      }) || null
    );
  }

  function findNativeSettingsLink() {
    const root = appRoot();
    if (!root) return null;
    const preferred = root.querySelectorAll(
      '.desktop-catalog-toolbar-secondary a.desktop-catalog-toolbar-link, .desktop-thread-toolbar a.desktop-catalog-toolbar-link',
    );
    for (const link of preferred) {
      if (normalizeText(link.textContent).includes('設定')) return link;
    }
    return root.querySelector(
      '.min-h-screen > header a[aria-label="設定"], .min-h-screen > header a[href*="/settings"]',
    );
  }

  function findNativeMobileMenuButton() {
    return appRoot()?.querySelector(
      '.min-h-screen > header button[aria-label="メニュー"], .min-h-screen > header button[aria-label="設定"]',
    ) || null;
  }

  function findNativeButton(selector, exactText) {
    const root = appRoot();
    if (!root) return null;
    if (selector) {
      const selected = root.querySelector(selector);
      if (selected instanceof HTMLButtonElement) return selected;
    }
    if (!exactText) return null;
    return (
      Array.from(root.querySelectorAll('button')).find(
        (button) => normalizeText(button.textContent) === exactText,
      ) || null
    );
  }

  function findNativeFilterButton() {
    const root = appRoot();
    const desktop = root?.querySelector(
      'nav.desktop-catalog-toolbar > button.desktop-catalog-toolbar-action[aria-controls]',
    );
    if (desktop instanceof HTMLButtonElement) return desktop;
    const mobileNav = root?.querySelector('nav[aria-label="カタログメニュー"]');
    if (!mobileNav) return null;
    return (
      Array.from(mobileNav.querySelectorAll('button')).find((button) =>
        normalizeText(button.textContent).includes('フィルタ'),
      ) || null
    );
  }

  function findNativeSortButton() {
    const root = appRoot();
    if (!root) return null;
    const mobileNav = root.querySelector('nav[aria-label="カタログメニュー"]');
    const mobileButton = Array.from(mobileNav?.querySelectorAll('button') || []).find(
      (button) => normalizeText(button.textContent).includes('ソート'),
    );
    if (mobileButton) return mobileButton;
    const toolbar = root.querySelector('.desktop-catalog-toolbar');
    return (
      Array.from(toolbar?.querySelectorAll('button') || []).find((button) =>
        normalizeText(button.textContent).includes('ソート'),
      ) || null
    );
  }

  function findNativeSearchButton() {
    const root = appRoot();
    if (!root) return null;
    const explicit = root.querySelector(
      'button[aria-label="検索"], button[aria-label="検索を開く"]',
    );
    if (explicit instanceof HTMLButtonElement) return explicit;
    const threadToolbar = root.querySelector('.desktop-thread-toolbar');
    return (
      Array.from(threadToolbar?.querySelectorAll('button') || []).find(
        (button) => normalizeText(button.textContent) === '検索',
      ) || null
    );
  }

  function findNativeAction(name) {
    const root = appRoot();
    if (!root) return null;
    if (name === 'top') {
      return root.querySelector(
        'button[aria-label="ページ上部へ移動"], button[aria-label="ページ上部へ"], button[aria-label="スレッド上部へ移動"], button[aria-label="上へ"]',
      );
    }
    if (name === 'auto') {
      return root.querySelector(
        'nav[aria-label="スレッドナビゲーション"] .desktop-auto-reload input[role="switch"]',
      );
    }
    if (name === 'refresh') {
      if (isThreadScreen()) return null;
      return (
        root.querySelector('.desktop-catalog-toolbar-refresh') ||
        root.querySelector('button[aria-label="更新"]') ||
        Array.from(root.querySelectorAll('nav[aria-label="カタログメニュー"] button')).find(
          (button) => normalizeText(button.textContent).includes('更新'),
        ) ||
        null
      );
    }
    if (name === 'post') {
      return (
        root.querySelector('.desktop-catalog-fab, .desktop-thread-reply-fab') ||
        root.querySelector('button[aria-label="新規スレッド"], button[aria-label="返信"]')
      );
    }
    if (name === 'settings') {
      return findNativeSettingsLink() || findNativeMobileMenuButton();
    }
    return null;
  }

  function copyNativeLinkProperties() {
    if (!shell) return;
    shell.querySelectorAll('[data-action="source-link"][data-native-label]').forEach((link) => {
      const label = link.dataset.nativeLabel;
      const nativeLink = findNativeLink(label);
      const fallback = {
        '利用規約': { href: '/mix/board_rules.html#aimg' },
        告知: { href: '/mix/announcements' },
        Wiki: {
          href: 'https://wiki.nijiurachan.net/',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        API: { href: '/mix/api-docs' },
      }[label];
      if (!nativeLink && !fallback) {
        link.hidden = true;
        return;
      }
      const href = nativeLink?.getAttribute('href') || fallback?.href;
      if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
      else if (!href && link.hasAttribute('href')) link.removeAttribute('href');
      const target = nativeLink?.target || fallback?.target;
      const rel = nativeLink?.rel || fallback?.rel;
      if (target && link.target !== target) link.target = target;
      if (rel && link.rel !== rel) link.rel = rel;
      link.hidden = false;
    });
  }

  function syncSearchScope() {
    const shellSelect = shell?.querySelector('#aimoge-theme-search-scope');
    const nativeSelect = findCatalogSearchForm()?.querySelector(
      'select[aria-label="投稿検索の検索モード"]',
    );
    if (!(shellSelect instanceof HTMLSelectElement) || !(nativeSelect instanceof HTMLSelectElement)) return;
    const nativeOptions = Array.from(nativeSelect.options);
    const optionKey = nativeOptions
      .map((option) => `${option.value}\u0000${option.textContent}`)
      .join('\u0001');
    if (shellSelect.dataset.optionKey !== optionKey) {
      shellSelect.replaceChildren(
        ...nativeOptions.map((option) => {
          const copy = document.createElement('option');
          copy.value = option.value;
          copy.textContent = option.textContent;
          return copy;
        }),
      );
      shellSelect.dataset.optionKey = optionKey;
    }
    if (shellSelect.value !== nativeSelect.value) shellSelect.value = nativeSelect.value;
  }

  function updateThemeSwitch() {
    const button = shell?.querySelector('.aimoge-theme-toggle');
    if (!(button instanceof HTMLButtonElement)) return;
    const isDark = !document.documentElement.classList.contains('light-mode');
    button.setAttribute('aria-checked', String(isDark));
  }

  function updateThreadBreadcrumbs() {
    if (!shell) return;
    const breadcrumb = shell.querySelector('.aimoge-thread-breadcrumbs');
    const title = shell.querySelector('[data-thread-title]');
    const heading = shell.querySelector('.aimoge-thread-heading');
    const board = shell.querySelector('[data-board-crumb]');
    const tagList = shell.querySelector('[data-thread-tags]');
    const boardTagSeparator = shell.querySelector('[data-board-tag-separator]');
    if (!breadcrumb || !title) return;
    const thread = isThreadScreen();
    breadcrumb.hidden = !thread;
    if (heading) heading.hidden = !thread;
    if (!thread) {
      tagList?.replaceChildren();
      if (tagList) tagList.hidden = true;
      if (boardTagSeparator) boardTagSeparator.hidden = true;
      if (board) board.textContent = '板';
      title.textContent = 'スレッド';
      if (heading) heading.textContent = 'スレッド';
      return;
    }
    const app = appRoot();
    const nativeTitle =
      app?.querySelector('.desktop-thread-page .desktop-mode-title, .desktop-thread-page h1') ??
      app?.querySelector('section[aria-label="スレッド本文"] h1');
    const boardName = readThreadBoardName();
    const threadTitle = readPureThreadTitle(nativeTitle?.textContent || '', boardName);
    title.textContent = threadTitle || 'スレッド';
    if (heading) heading.textContent = threadTitle || 'スレッド';
    if (board) board.textContent = boardName || '板';
    if (tagList instanceof HTMLElement) {
      const tags = readNativeThreadTags();
      const children = [];
      tags.forEach((tag, index) => {
        if (index > 0) {
          const separator = document.createElement('span');
          separator.setAttribute('aria-hidden', 'true');
          separator.textContent = '»';
          children.push(separator);
        }
        const label = document.createElement('span');
        label.dataset.threadTag = '';
        label.textContent = tag;
        children.push(label);
      });
      tagList.replaceChildren(...children);
      tagList.hidden = tags.length === 0;
      if (boardTagSeparator) boardTagSeparator.hidden = tags.length === 0;
    }
  }

  function readNativeThreadTags() {
    const root = appRoot();
    if (!root) return [];
    const tagGroups = [
      Array.from(root.querySelectorAll(
        'section[aria-label="スレッド先頭投稿"] > #post-0 > .thread-op-tags[aria-label="タグ"] > li',
      )),
      Array.from(root.querySelectorAll(
        'main#main-content > section[aria-label="スレッド本文"] > div.pb-14 > div#post-0.relative > ul.thread-op-tags[aria-label="タグ"] > li',
      )),
    ];
    const tagItems = tagGroups.find((group) =>
      group.some((item) => item.getClientRects().length > 0),
    ) || tagGroups.find((group) => group.length > 0) || [];
    return Array.from(tagItems)
      .map((item) => ({
        item,
        name: normalizeText(item.textContent || ''),
      }))
      .filter(({ name }) => name.length > 0)
      .filter(
        ({ item, name }) =>
          item.getAttribute('data-r18') !== 'true' &&
          name.normalize('NFKC').trim().toLocaleUpperCase('en-US') !== 'R18',
      )
      .map(({ name }) => name);
  }

  function readPureThreadTitle(value, boardName) {
    let title = normalizeText(value);
    if (!boardName) return title;
    const separators = [' · ', ' ・ ', ' - ', ' — ', ' – ', ' | '];
    const suffixes = [
      ...separators.map((separator) => `${separator}${boardName}@あいもげ`),
      ...separators.map((separator) => `${separator}${boardName}`),
    ];
    const suffix = suffixes.find((candidate) => title.endsWith(candidate));
    if (suffix) title = title.slice(0, -suffix.length).trim();
    return title;
  }

  function stripSiteSuffix(value) {
    return normalizeText(value).replace(/\s*[@＠]\s*あいもげ$/, '').trim();
  }

  function readThreadBoardName() {
    const threadPath = /^\/mix\/([^/]+)\/thread\//.exec(window.location.pathname);
    let slug = null;
    if (threadPath?.[1]) {
      try {
        slug = decodeURIComponent(threadPath[1]);
      } catch {
        slug = null;
      }
    }
    try {
      const serialized = document.getElementById('aimg-runtime-config')?.textContent;
      const runtime = serialized ? JSON.parse(serialized) : null;
      const configured = slug ? runtime?.mix?.boardNames?.[slug] : null;
      if (typeof configured === 'string' && configured.trim()) {
        return stripSiteSuffix(configured);
      }
    } catch {
      // 壊れた任意設定は無視し、表示中のnative headerへ縮退する。
    }
    const nativeHeader = appRoot()?.querySelector(
      '.desktop-header-title, .min-h-screen > header a[href="/mix/"], .min-h-screen > header [data-board-name]',
    );
    const visibleName = stripSiteSuffix(nativeHeader?.textContent || '');
    return visibleName || null;
  }

  function readSequenceNumber(button) {
    if (!(button instanceof HTMLElement)) return null;
    const raw = button.getAttribute('value') || normalizeText(button.textContent);
    const match = raw.match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  function readNativePostNumber(article) {
    const button = article.querySelector(':scope > header button.post-no');
    const match = normalizeText(button?.textContent).match(/\bNo\.?\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
  }

  function dialogTitleMatches(dialog, expectedTitle) {
    const ariaTitle = normalizeText(dialog.getAttribute('aria-label'));
    const labelledBy = normalizeText(
      (dialog.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' '),
    );
    const headingTitle = Array.from(
      dialog.querySelectorAll('h1, h2, h3, [role="heading"]'),
    ).map((heading) => normalizeText(heading.textContent));
    return ariaTitle === expectedTitle || labelledBy === expectedTitle ||
      headingTitle.includes(expectedTitle);
  }

  function findNoActionDialog(postNumber) {
    const expectedTitle = `No${postNumber}へのアクション`;
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (dialog) => dialogTitleMatches(dialog, expectedTitle),
    ) || null;
  }

  function clearPendingPostReport() {
    if (pendingPostReportTimer !== null) {
      window.clearTimeout(pendingPostReportTimer);
      pendingPostReportTimer = null;
    }
    if (pendingPostReportPollTimer !== null) {
      window.clearTimeout(pendingPostReportPollTimer);
      pendingPostReportPollTimer = null;
    }
    pendingPostReport = null;
  }

  function schedulePostReportPoll() {
    if (pendingPostReportPollTimer !== null) return;
    pendingPostReportPollTimer = window.setTimeout(() => {
      pendingPostReportPollTimer = null;
      processPendingPostReport();
    }, 50);
  }

  function processPendingPostReport() {
    const pending = pendingPostReport;
    if (!pending) return;
    if (
      Date.now() >= pending.expiresAt ||
      !isMixPath() ||
      !isThreadScreen() ||
      window.location.pathname !== pending.pathname ||
      !pending.article.isConnected ||
      readPostKey(pending.article) !== pending.postKey ||
      readSequenceNumber(
        pending.article.querySelector(':scope > header .reply-number-in-thread'),
      ) !== pending.sequence ||
      readNativePostNumber(pending.article) !== pending.postNumber ||
      pending.article.querySelector(':scope > header button[aria-label="メニュー"]') !==
        pending.menuButton
    ) {
      clearPendingPostReport();
      return;
    }

    if (!pending.menuRequested) {
      pending.menuRequested = true;
      pending.menuButton.click();
    }

    const expectedTitle = `No${pending.postNumber}へのアクション`;
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
      (candidate) => !pending.dialogsBefore.has(candidate) &&
        dialogTitleMatches(candidate, expectedTitle),
    );
    if (dialog) {
      const delButton = Array.from(
        dialog.querySelectorAll('button, [role="menuitem"]'),
      ).find((candidate) => {
        const labels = [
          normalizeText(candidate.getAttribute('aria-label')),
          normalizeText(candidate.textContent),
        ];
        return labels.some((label) => /^del(?: \(\d+\))?$/.test(label));
      });
      if (delButton) {
        if (
          !(delButton instanceof HTMLButtonElement && delButton.disabled) &&
          delButton.getAttribute('aria-disabled') !== 'true'
        ) delButton.click();
        clearPendingPostReport();
        return;
      }
    }
    schedulePostReportPoll();
  }

  function beginPostReport(reportButton) {
    if (!isMixPath() || !isThreadScreen()) return false;
    const article = reportButton.closest('.thread-post-article');
    const header = article?.querySelector(':scope > header');
    if (!(article instanceof HTMLElement) || !header?.contains(reportButton)) return false;
    const sequence = readSequenceNumber(
      article.querySelector(':scope > header .reply-number-in-thread'),
    );
    const postNumber = readNativePostNumber(article);
    const menuButton = article.querySelector(
      ':scope > header button[aria-label="メニュー"]',
    );
    const postKey = readPostKey(article);
    if (
      sequence === null ||
      postNumber === null ||
      !(menuButton instanceof HTMLButtonElement) ||
      !postKey
    ) return false;

    if (pendingPostReport) return true;
    if (pendingNoReply || pendingNoReplies.length > 0) return true;
    const now = Date.now();
    if (
      lastPostReportActivation?.postKey === postKey &&
      now - lastPostReportActivation.at < POST_REPORT_DOUBLE_CLICK_MS
    ) return true;
    lastPostReportActivation = { postKey, at: now };
    pendingPostReport = {
      article,
      dialogsBefore: new Set(document.querySelectorAll('[role="dialog"]')),
      expiresAt: now + POST_REPORT_TIMEOUT_MS,
      menuButton,
      menuRequested: false,
      pathname: window.location.pathname,
      postKey,
      postNumber,
      sequence,
    };
    pendingPostReportTimer = window.setTimeout(
      clearPendingPostReport,
      POST_REPORT_TIMEOUT_MS,
    );
    processPendingPostReport();
    return true;
  }

  function handlePostReportClickCapture(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button[data-action="post-report"]');
    if (!(button instanceof HTMLButtonElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    beginPostReport(button);
  }

  function findReplyTextarea() {
    return document.querySelector(
      '#app-root .desktop-reply-panel form.desktop-thread-create-form textarea, ' +
      '.desktop-reply-panel form.desktop-thread-create-form textarea, ' +
      '#app-root :is(section, form)[aria-label="返信フォーム"] textarea, ' +
      '[role="dialog"] :is(section, form)[aria-label="返信フォーム"] textarea',
    );
  }

  function finishCurrentNoReply() {
    if (pendingNoReplyTimer !== null) {
      window.clearTimeout(pendingNoReplyTimer);
      pendingNoReplyTimer = null;
    }
    if (pendingNoReplyPollTimer !== null) {
      window.clearTimeout(pendingNoReplyPollTimer);
      pendingNoReplyPollTimer = null;
    }
    pendingNoReply = null;
    queueMicrotask(processPendingNoReply);
  }

  function clearPendingNoReply() {
    if (pendingNoReplyTimer !== null) {
      window.clearTimeout(pendingNoReplyTimer);
      pendingNoReplyTimer = null;
    }
    if (pendingNoReplyPollTimer !== null) {
      window.clearTimeout(pendingNoReplyPollTimer);
      pendingNoReplyPollTimer = null;
    }
    pendingNoReply = null;
    pendingNoReplies = [];
  }

  function scheduleNoReplyPoll() {
    if (pendingNoReplyPollTimer !== null) return;
    pendingNoReplyPollTimer = window.setTimeout(() => {
      pendingNoReplyPollTimer = null;
      processPendingNoReply();
    }, 50);
  }

  function selectNoReplyAction(dialog) {
    const button = Array.from(dialog.querySelectorAll('button')).find(
      (candidate) => normalizeText(candidate.textContent) === 'No返信' ||
        normalizeText(candidate.getAttribute('aria-label')) === 'No返信',
    );
    if (!button || !pendingNoReply) return false;
    const textarea = findReplyTextarea();
    pendingNoReply.replyTextarea = textarea;
    pendingNoReply.valueBefore = textarea instanceof HTMLTextAreaElement ? textarea.value : null;
    pendingNoReply.dialogsBefore = new Set(document.querySelectorAll('[role="dialog"]'));
    pendingNoReply.phase = 'quote-placement';
    button.click();
    processPendingNoReply();
    return true;
  }

  function processPendingNoReply() {
    if (!pendingNoReply) {
      pendingNoReply = pendingNoReplies.shift() || null;
      if (!pendingNoReply) return;
      pendingNoReplyTimer = window.setTimeout(finishCurrentNoReply, NO_REPLY_TIMEOUT_MS);
    }
    const pending = pendingNoReply;
    if (
      Date.now() >= pending.expiresAt ||
      !isMixPath() ||
      !isThreadScreen() ||
      window.location.pathname !== pending.pathname ||
      !pending.article.isConnected ||
      readPostKey(pending.article) !== pending.postKey ||
      readSequenceNumber(
        pending.article.querySelector(':scope > header .reply-number-in-thread'),
      ) !== pending.sequence ||
      readNativePostNumber(pending.article) !== pending.postNumber
    ) {
      finishCurrentNoReply();
      return;
    }
    if (pending.phase === 'menu') {
      const dialog = findNoActionDialog(pending.postNumber);
      if (dialog) selectNoReplyAction(dialog);
      else {
        if (!pending.menuRequested) {
          const postNumberButton = pending.article.querySelector(
            ':scope > header button.post-no',
          );
          if (postNumberButton instanceof HTMLButtonElement) {
            pending.menuRequested = true;
            postNumberButton.click();
          }
        }
        scheduleNoReplyPoll();
      }
      return;
    }
    if (pending.phase === 'quote-placement') {
      const quoteDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (dialog) => !pending.dialogsBefore?.has(dialog) &&
          dialogTitleMatches(dialog, '引用文の挿入位置'),
      );
      if (quoteDialog) {
        const appendButton = Array.from(quoteDialog.querySelectorAll('button')).find(
          (button) => normalizeText(button.textContent) === '末尾に追加' ||
            normalizeText(button.getAttribute('aria-label')) === '末尾に追加',
        );
        if (appendButton) {
          pending.phase = 'waiting-input';
          pending.quoteDialogHandled = true;
          appendButton.click();
        }
        scheduleNoReplyPoll();
        return;
      }
    }
    if (pending.phase === 'waiting-input' && !pending.quoteDialogHandled) {
      const quoteDialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
        (dialog) => !pending.dialogsBefore?.has(dialog) &&
          dialogTitleMatches(dialog, '引用文の挿入位置'),
      );
      if (quoteDialog) {
        const appendButton = Array.from(quoteDialog.querySelectorAll('button')).find(
          (button) => normalizeText(button.textContent) === '末尾に追加' ||
            normalizeText(button.getAttribute('aria-label')) === '末尾に追加',
        );
        if (appendButton) {
          pending.quoteDialogHandled = true;
          appendButton.click();
        }
      }
    }
    if (pending.phase === 'quote-placement' || pending.phase === 'waiting-input') {
      const textarea = findReplyTextarea() || pending.replyTextarea;
      if (textarea instanceof HTMLTextAreaElement) {
        const expectedQuote = `>No.${pending.postNumber}\n`;
        if (pending.valueBefore === null
          ? textarea.value.endsWith(expectedQuote)
          : textarea.value !== pending.valueBefore && textarea.value.endsWith(expectedQuote)) {
          textarea.focus();
          textarea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          finishCurrentNoReply();
          return;
        }
      }
      scheduleNoReplyPoll();
    }
  }

  function beginNoReplyFromSequence(sequenceButton) {
    if (!isMixPath() || !isThreadScreen()) return false;
    if (pendingPostReport) return true;
    const article = sequenceButton.closest('.thread-post-article');
    const metadata = article?.querySelector(':scope > header');
    if (!(article instanceof HTMLElement) || !metadata?.contains(sequenceButton)) return false;
    const sequence = readSequenceNumber(sequenceButton);
    const postNumber = readNativePostNumber(article);
    const postNumberButton = article.querySelector(':scope > header button.post-no');
    const postKey = readPostKey(article);
    if (
      sequence === null ||
      postNumber === null ||
      !(postNumberButton instanceof HTMLButtonElement) ||
      !postKey
    ) return false;

    pendingNoReplies.push({
      article,
      pathname: window.location.pathname,
      postKey,
      postNumber,
      sequence,
      expiresAt: Date.now() + NO_REPLY_TIMEOUT_MS,
      phase: 'menu',
    });
    processPendingNoReply();
    return true;
  }

  function handleSequenceClickCapture(event) {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button.reply-number-in-thread');
    if (!(button instanceof HTMLButtonElement)) return;
    if (!beginNoReplyFromSequence(button)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function handleSequenceKeydownCapture(event) {
    if (
      (event.key !== 'Enter' && event.key !== ' ') ||
      event.repeat ||
      !(event.target instanceof Element)
    ) return;
    const button = event.target.closest('button.reply-number-in-thread');
    if (!(button instanceof HTMLButtonElement)) return;
    if (!beginNoReplyFromSequence(button)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function readNativeSort() {
    const root = appRoot();
    const select = root?.querySelector('select[aria-label="表示順"]');
    if (select instanceof HTMLSelectElement && VALID_NATIVE_SORTS.has(select.value)) {
      return select.value;
    }
    const sortPanel = document.querySelector('[aria-label="カタログ表示設定"]');
    if (sortPanel) {
      for (const selected of sortPanel.querySelectorAll('button[aria-pressed="true"]')) {
        const label = normalizeText(selected.textContent);
        for (const [value, nativeLabel] of SORT_OPTION_BY_VALUE) {
          if (label === nativeLabel) return value;
        }
      }
    }
    try {
      const serialized = window.localStorage.getItem('nijiurachan-catalog-settings');
      const persisted = serialized ? JSON.parse(serialized) : null;
      const value = persisted?.state?.currentSort;
      return typeof value === 'string' && VALID_NATIVE_SORTS.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  function readCurrentSort() {
    return catalogSortAdapter?.getMode() || readNativeSort();
  }

  function readBoardSelectionSignature() {
    const settings = appRoot()?.querySelector('[aria-label="統合カタログの板設定"]');
    if (!settings) return null;
    return Array.from(settings.querySelectorAll('input[type="checkbox"]'))
      .map((input) => {
        const name = input.getAttribute('aria-label') || input.name || input.value;
        return `${name}:${input.checked ? '1' : '0'}`;
      })
      .sort()
      .join('|');
  }

  function handleNativeBoardSelectionChange(event) {
    const target = event.target;
    if (!(target instanceof Element) ||
        !target.closest('#app-root [aria-label="統合カタログの板設定"]')) return;
    catalogSortAdapter?.invalidate();
    clearSortStatus();
    const selection = readBoardSelectionSignature();
    if (selection !== null) previousBoardSelection = selection;
  }

  function syncSortAdapterContext(pageKind) {
    const path = window.location.pathname;
    const boardSelection = readBoardSelectionSignature();
    if (previousRoutePath !== null && path !== previousRoutePath) {
      catalogSortAdapter?.invalidate();
      clearSortStatus();
      if (pendingAction?.type === 'sort') pendingAction = null;
    }
    if (previousPageKind === 'catalog' && pageKind !== 'catalog') {
      catalogSortAdapter?.invalidate();
      clearSortStatus();
    }
    if (boardSelection !== null) {
      if (previousBoardSelection !== null && boardSelection !== previousBoardSelection) {
        catalogSortAdapter?.invalidate();
        clearSortStatus();
      }
      previousBoardSelection = boardSelection;
    }
    previousRoutePath = path;
    previousPageKind = pageKind;
  }

  function clearSortStatus() {
    const status = catalogNav?.querySelector('.aimoge-sort-status');
    if (status) {
      status.hidden = true;
      status.textContent = '';
    }
  }

  function reportSortError({ code }) {
    const status = catalogNav?.querySelector('.aimoge-sort-status');
    if (!(status instanceof HTMLElement)) return;
    const message = code === 'CATALOG_LIMIT'
      ? '取得できる範囲を超えました。板を減らして再試行してください。'
      : code === 'CATALOG_SNAPSHOT'
        ? '並び順の一覧が失効しました。先頭から更新してください。'
        : 'カタログの取得に失敗しました。更新して再試行してください。';
    status.textContent = message;
    status.hidden = false;
  }

  function updateCurrentSort() {
    if (!catalogNav) return;
    const currentSort = readCurrentSort();
    catalogNav.querySelectorAll('[data-action="sort"][data-sort]').forEach((button) => {
      const selected = currentSort === button.dataset.sort;
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function isThreadScreen() {
    const root = appRoot();
    return Boolean(
      root?.querySelector('.desktop-thread-page, section[aria-label="スレッド本文"]'),
    );
  }

  function isCatalogScreen() {
    const root = appRoot();
    return Boolean(
      !isThreadScreen() &&
        root?.querySelector(
          '.desktop-catalog-page, section[aria-label="スレッドカタログ"]',
        ),
    );
  }

  function updateQuickActions() {
    if (!shell) return;
    const thread = isThreadScreen();
    shell.querySelectorAll('.aimoge-quick-action').forEach((button) => {
      const action = button.dataset.action;
      const native = findNativeAction(action);
      button.hidden = !native ||
        (action === 'refresh' && thread) ||
        (action === 'auto' && !thread) ||
        (action === 'settings' && !thread);
      if (action === 'post') {
        const label = thread ? '返信フォーム' : '投稿フォーム';
        button.setAttribute('aria-label', label);
        button.title = label;
      }
      if (action === 'auto' && native instanceof HTMLInputElement) {
        const enabled = native.checked;
        const label = enabled ? '自動更新を停止' : '自動更新を有効にする';
        button.setAttribute('aria-pressed', String(enabled));
        button.setAttribute('aria-label', label);
        button.title = label;
        button.textContent = enabled ? '⏸' : '↻';
      }
    });
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function withNativeSortBridge(action) {
    nativeSortBridgeDepth += 1;
    try {
      return action();
    } finally {
      nativeSortBridgeDepth -= 1;
    }
  }

  function clearCustomSortMode() {
    if (!catalogSortAdapter?.getMode()) return;
    catalogSortAdapter.setMode(null);
    clearSortStatus();
  }

  function handleNativeSortChange(event) {
    if (nativeSortBridgeDepth > 0) return;
    const target = event.target;
    if (!(target instanceof Element) ||
        !target.matches('#app-root select[aria-label="表示順"]')) return;
    clearCustomSortMode();
    updateCurrentSort();
  }

  function nativeSortValueForLabel(label) {
    const normalized = normalizeText(label);
    for (const [value, nativeLabel] of SORT_OPTION_BY_VALUE) {
      if (normalized === nativeLabel) return value;
    }
    return null;
  }

  function handleNativeMobileSortClick(event) {
    if (nativeSortBridgeDepth > 0 || !(event.target instanceof Element)) return;
    const button = event.target.closest('[aria-label="カタログ表示設定"] button');
    if (!(button instanceof HTMLButtonElement) || button.disabled ||
        nativeSortValueForLabel(button.textContent) === null) return;
    clearCustomSortMode();
    window.setTimeout(updateCurrentSort, 0);
  }

  function handleNativeAutoReloadChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target !== findNativeAction('auto')) return;
    updateQuickActions();
  }

  function scheduleNativeRefresh(expectedMode) {
    let attempts = 0;
    const tryRefresh = () => {
      if (
        !isMixPath() ||
        !isCatalogScreen() ||
        catalogSortAdapter?.getMode() !== expectedMode
      ) return;
      const refresh = findNativeAction('refresh');
      if (refresh instanceof HTMLButtonElement && !refresh.disabled) {
        refresh.click();
        return;
      }
      attempts += 1;
      if (attempts < 50) window.setTimeout(tryRefresh, 40);
    };
    window.setTimeout(tryRefresh, 0);
  }

  function chooseNativeSort(value, customMode = null) {
    const root = appRoot();
    const nativeSortBefore = readNativeSort();
    const refreshIfUnchanged = customMode !== null &&
      value === 'bump' && nativeSortBefore === 'bump';
    const select = root?.querySelector('select[aria-label="表示順"]');
    if (select instanceof HTMLSelectElement) {
      const option = Array.from(select.options).find((item) => item.value === value);
      if (option) {
        withNativeSortBridge(() => setNativeValue(select, value));
        updateCurrentSort();
        if (refreshIfUnchanged) scheduleNativeRefresh(customMode);
        return true;
      }
    }
    const label = SORT_OPTION_BY_VALUE.get(value);
    if (!label) return false;
    const panel = document.querySelector('[aria-label="カタログ表示設定"]');
    const optionButton = Array.from(panel?.querySelectorAll('button') || []).find(
      (button) => normalizeText(button.textContent) === label,
    );
    if (optionButton) {
      pendingAction = null;
      withNativeSortBridge(() => optionButton.click());
      updateCurrentSort();
      if (refreshIfUnchanged) scheduleNativeRefresh(customMode);
      return true;
    }
    pendingAction = {
      type: 'sort', value, customMode,
      refreshIfUnchanged,
    };
    findNativeSortButton()?.click();
    return true;
  }

  function chooseSort(value) {
    if (value === 'kaso' || value === 'shuffle') {
      if (!catalogSortAdapter || !isCatalogScreen()) return false;
      const nativeSortBefore = readNativeSort();
      catalogSortAdapter.setMode(value);
      clearSortStatus();
      updateCurrentSort();
      return chooseNativeSort('bump', value) || nativeSortBefore === 'bump';
    }
    if (!VALID_NATIVE_SORTS.has(value)) return false;
    const previousMode = catalogSortAdapter?.getMode() ?? null;
    const nativeSortBefore = readNativeSort();
    catalogSortAdapter?.setMode(null);
    clearSortStatus();
    const selected = chooseNativeSort(value);
    if (previousMode && value === 'bump' && nativeSortBefore === 'bump') {
      scheduleNativeRefresh(null);
    }
    return selected;
  }

  function findCatalogSearchForm() {
    const root = appRoot();
    return root?.querySelector('search[aria-label="投稿検索"] form') || null;
  }

  function dispatchInputValue(input, value) {
    setNativeValue(input, value);
  }

  function applySearch(query) {
    const form = findCatalogSearchForm();
    const catalogInput = form?.querySelector('input[aria-label="投稿検索"]');
    if (form && catalogInput instanceof HTMLInputElement) {
      const scope = shell?.querySelector('#aimoge-theme-search-scope');
      const nativeScope = form.querySelector(
        'select[aria-label="投稿検索の検索モード"]',
      );
      pendingAction = null;
      if (
        scope instanceof HTMLSelectElement &&
        nativeScope instanceof HTMLSelectElement &&
        nativeScope.value !== scope.value
      ) {
        setNativeValue(nativeScope, scope.value);
      }
      dispatchInputValue(catalogInput, query);
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    }
    const threadInput = document.querySelector(
      '#app-root input[type="search"]:not(#aimoge-theme-search), body > [role="dialog"] input[type="search"]',
    );
    if (threadInput instanceof HTMLInputElement) {
      pendingAction = null;
      dispatchInputValue(threadInput, query);
      return true;
    }
    return false;
  }

  function requestSearch(query) {
    pendingAction = { type: 'search', query };
    if (applySearch(query)) return;
    findNativeSearchButton()?.click();
  }

  function setTheme(theme) {
    const select = document.querySelector(
      '#app-root select[aria-label="テーマ切替"], body > [role="dialog"] select[aria-label="テーマ切替"]',
    );
    if (!(select instanceof HTMLSelectElement)) return false;
    if (!Array.from(select.options).some((option) => option.value === theme)) return false;
    pendingAction = null;
    setNativeValue(select, theme);
    return true;
  }

  function openNativeSettings() {
    const mobileMenuButton = findNativeMobileMenuButton();
    const themeSelect = document.querySelector(
      '#app-root select[aria-label="テーマ切替"], body > [role="dialog"] select[aria-label="テーマ切替"]',
    );
    if (mobileMenuButton instanceof HTMLButtonElement &&
        !(themeSelect instanceof HTMLSelectElement)) {
      pendingSettingsNavigation = true;
      mobileMenuButton.click();
      return true;
    }
    const settingsLink = findNativeSettingsLink();
    if (settingsLink) {
      settingsLink.click();
      return true;
    }
    return false;
  }

  function toggleTheme() {
    const target = document.documentElement.classList.contains('light-mode')
      ? 'dark'
      : 'light';
    if (setTheme(target)) return;
    pendingAction = { type: 'theme', theme: target };
    openNativeSettings();
  }

  function openNativeFilter() {
    const button = findNativeFilterButton();
    if (button instanceof HTMLButtonElement) {
      button.click();
      return true;
    }
    return false;
  }

  function runNativeAction(name) {
    const action = findNativeAction(name);
    if (name === 'settings') return openNativeSettings();
    if (action instanceof HTMLElement) {
      action.click();
      if (name === 'auto') updateQuickActions();
      return true;
    }
    return false;
  }

  function activateSourceLink(link) {
    const native = findNativeLink(link.dataset.nativeLabel);
    native?.click();
  }

  function dispatchAction(action, element) {
    if (action === 'menu-toggle') {
      const header = shell?.querySelector('.aimoge-header');
      const button = shell?.querySelector('.aimoge-menu-toggle');
      const isOpen = header?.dataset.menuOpen === 'true';
      if (header) header.dataset.menuOpen = String(!isOpen);
      button?.setAttribute('aria-expanded', String(!isOpen));
      return;
    }
    if (action === 'source-link') {
      activateSourceLink(element);
      return;
    }
    if (action === 'settings') {
      openNativeSettings();
      return;
    }
    if (action === 'theme-toggle') {
      toggleTheme();
      return;
    }
    if (action === 'board-toggle') {
      const menu = catalogNav?.querySelector(`#${BOARD_MENU_ID}`);
      const button = catalogNav?.querySelector('[data-action="board-toggle"]');
      const isOpen = menu ? !menu.hidden : false;
      if (menu) menu.hidden = isOpen;
      button?.setAttribute('aria-expanded', String(!isOpen));
      return;
    }
    if (action === 'board-filter') {
      const menu = catalogNav?.querySelector(`#${BOARD_MENU_ID}`);
      if (menu) menu.hidden = true;
      catalogNav?.querySelector('[data-action="board-toggle"]')?.setAttribute('aria-expanded', 'false');
      openNativeFilter();
      return;
    }
    if (action === 'sort') {
      chooseSort(element.dataset.sort);
      return;
    }
    if (action === 'search') {
      const input = shell?.querySelector('#aimoge-theme-search');
      requestSearch(input instanceof HTMLInputElement ? input.value : '');
      return;
    }
    if (action === 'top' || action === 'refresh' || action === 'post' || action === 'auto') {
      runNativeAction(action);
    }
  }

  function handleShellClick(event) {
    const target = event.target instanceof Element
      ? event.target.closest('[data-action]')
      : null;
    if (
      !(target instanceof HTMLElement) ||
      (!shell?.contains(target) && !catalogNav?.contains(target))
    ) return;
    const action = target.dataset.action;
    if (action === 'source-link') {
      const native = findNativeLink(target.dataset.nativeLabel);
      if (native) event.preventDefault();
    }
    dispatchAction(action, target);
  }

  function handleShellSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.aimoge-search-form')) return;
    event.preventDefault();
    const input = form.querySelector('input[type="search"]');
    requestSearch(input instanceof HTMLInputElement ? input.value : '');
  }

  function handleShellChange(event) {
    const select = event.target;
    if (
      !(select instanceof HTMLSelectElement) ||
      select.id !== 'aimoge-theme-search-scope'
    ) return;
    const nativeSelect = findCatalogSearchForm()?.querySelector(
      'select[aria-label="投稿検索の検索モード"]',
    );
    if (nativeSelect instanceof HTMLSelectElement) {
      setNativeValue(nativeSelect, select.value);
    }
  }

  function findPostSoudane(article) {
    const metadata = article.querySelector(':scope > header');
    if (!metadata) return null;
    for (const candidate of metadata.querySelectorAll('button, data')) {
      const text = normalizeText(candidate.textContent);
      if (candidate instanceof HTMLButtonElement) {
        const match = text.match(/^そうだね\s*x\s*(\d+)$/);
        if (match) return { element: candidate, count: Number(match[1]) };
        if (candidate.getAttribute('aria-label') === 'そうだね') {
          return { element: candidate, count: 0 };
        }
      }
      if (candidate instanceof HTMLDataElement && /^そうだね\s*x\s*\d+$/.test(text)) {
        const value = Number(candidate.getAttribute('value'));
        if (Number.isFinite(value) && value >= 0) {
          return { element: candidate, count: Math.floor(value) };
        }
      }
    }
    return null;
  }

  function getGoodLevel(count) {
    if (!Number.isFinite(count) || count < GOOD_THRESHOLDS[0]) return 0;
    for (let index = GOOD_THRESHOLDS.length - 1; index >= 0; index -= 1) {
      if (count >= GOOD_THRESHOLDS[index]) return index + 1;
    }
    return 0;
  }

  function readPostKey(article) {
    const number = article.querySelector('.reply-number-in-thread');
    if (!number) return '';
    const value = number.getAttribute('value') || normalizeText(number.textContent);
    return /^\d+$/.test(value) ? `${window.location.pathname}:${value}` : '';
  }

  function updatePostReportButton(article, postKey) {
    const header = article.querySelector(':scope > header');
    const menuButton = header?.querySelector('button[aria-label="メニュー"]');
    let slots = Array.from(header?.querySelectorAll('[data-aimoge-post-report-slot]') || []);
    const slot = slots.shift();
    slots.forEach((duplicate) => duplicate.remove());
    const postNumber = readNativePostNumber(article);
    if (
      !postKey ||
      !isMixPath() ||
      !isThreadScreen() ||
      !header ||
      !(menuButton instanceof HTMLButtonElement) ||
      postNumber === null
    ) {
      slot?.remove();
      return;
    }

    let reportSlot = slot;
    let reportButton = reportSlot?.querySelector('button[data-action="post-report"]');
    if (!reportSlot || !reportButton) {
      reportSlot?.remove();
      reportSlot = document.createElement('span');
      reportSlot.className = 'aimoge-post-report-slot';
      reportSlot.setAttribute('data-aimoge-post-report-slot', '');
      reportButton = document.createElement('button');
      reportButton.type = 'button';
      reportButton.className = 'aimoge-post-report';
      reportButton.dataset.action = 'post-report';
      reportButton.textContent = '報告';
      reportSlot.append(reportButton);
    }
    reportButton.setAttribute('aria-label', `No.${postNumber}を報告`);
    reportButton.title = `No.${postNumber}を報告`;
    reportButton.dataset.postKey = postKey;
    if (reportSlot.parentElement !== menuButton.parentElement ||
      reportSlot.previousElementSibling !== menuButton) {
      menuButton.insertAdjacentElement('afterend', reportSlot);
    }
  }

  function decorateThreadPosts() {
    const root = appRoot();
    if (!root) return;
    root.querySelectorAll('.thread-post-article').forEach((article) => {
      const key = readPostKey(article);
      if (key) article.setAttribute('data-aimoge-post-key', key);
      else article.removeAttribute('data-aimoge-post-key');
      updatePostReportButton(article, key);

      const source = findPostSoudane(article);
      article.querySelectorAll('[data-aimoge-soudane-count]').forEach((node) => {
        if (node !== source?.element) {
          node.removeAttribute('data-aimoge-soudane-count');
          node.removeAttribute('data-aimoge-soudane-display');
        }
      });
      if (!source) {
        article.removeAttribute('data-aimoge-good-level');
        return;
      }
      source.element.setAttribute('data-aimoge-soudane-count', String(source.count));
      source.element.setAttribute(
        'data-aimoge-soudane-display',
        source.count === 0 ? '+' : String(source.count),
      );
      const level = getGoodLevel(source.count);
      if (level > 0) article.setAttribute('data-aimoge-good-level', String(level));
      else article.removeAttribute('data-aimoge-good-level');
    });
  }

  function applyPendingAction() {
    if (!pendingAction) return;
    if (pendingAction.type === 'theme') {
      setTheme(pendingAction.theme);
      return;
    }
    if (pendingAction.type === 'sort') {
      const action = pendingAction;
      const panel = document.querySelector('[aria-label="カタログ表示設定"]');
      const label = SORT_OPTION_BY_VALUE.get(action.value);
      const button = Array.from(panel?.querySelectorAll('button') || []).find(
        (candidate) => normalizeText(candidate.textContent) === label,
      );
      if (button) {
        pendingAction = null;
        withNativeSortBridge(() => button.click());
        updateCurrentSort();
        if (action.refreshIfUnchanged && action.customMode !== null) {
          scheduleNativeRefresh(action.customMode);
        }
      }
      return;
    }
    if (pendingAction.type === 'search') applySearch(pendingAction.query);
  }

  function syncPageModel() {
    if (!shell) return;
    const active = isMixPath();
    const thread = active && isThreadScreen();
    if (
      pendingNoReply &&
      (!thread || window.location.pathname !== pendingNoReply.pathname)
    ) clearPendingNoReply();
    if (
      pendingPostReport &&
      (!thread || window.location.pathname !== pendingPostReport.pathname)
    ) clearPendingPostReport();
    shell.hidden = !active;
    placeCatalogNav();
    const pageKind = isThreadScreen()
      ? 'thread'
      : isCatalogScreen()
        ? 'catalog'
        : 'other';
    shell.dataset.page = pageKind;
    syncSortAdapterContext(pageKind);
    copyNativeLinkProperties();
    syncSearchScope();
    updateThemeSwitch();
    updateThreadBreadcrumbs();
    updateCurrentSort();
    updateQuickActions();
    decorateThreadPosts();
    processPendingNoReply();
    processPendingPostReport();

    if (pendingSettingsNavigation) {
      const settingsLink = findNativeSettingsLink();
      if (settingsLink) {
        pendingSettingsNavigation = false;
        settingsLink.click();
      }
    }
    applyPendingAction();
  }

  function updateScope() {
    document.documentElement.classList.toggle(ROOT_CLASS, isMixPath());
  }

  function reconcile() {
    updateScope();
    ensureShell();
    ensureCatalogNav();
    syncPageModel();
  }

  function scheduleReconcile(records) {
    const relevant = records.some((record) => {
      if (isInsideOwnedUI(record.target)) return false;
      if (record.type === 'childList' && record.addedNodes.length + record.removedNodes.length > 0) {
        const removedOwnedNode = [...record.removedNodes].some((node) => isInsideOwnedUI(node));
        const addedOnlyOwnedNodes =
          record.removedNodes.length === 0 &&
          [...record.addedNodes].every((node) => isInsideOwnedUI(node));
        if (!removedOwnedNode && addedOnlyOwnedNodes) return false;
      }
      return true;
    });
    if (!relevant || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconcile();
    });
  }

  function start() {
    if (!document.documentElement) return;
    installStyle();
    reconcile();
    if (!observer && typeof MutationObserver === 'function') {
      observer = new MutationObserver(scheduleReconcile);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'value', 'aria-expanded', 'aria-current', 'href'],
        characterData: true,
      });
    }
  }

  function handleGlobalKeydown(event) {
    if (event.key !== 'Escape' || !shell) return;
    const header = shell.querySelector('.aimoge-header');
    const menuToggle = shell.querySelector('.aimoge-menu-toggle');
    const boardMenu = catalogNav?.querySelector(`#${BOARD_MENU_ID}`);
    if (boardMenu && !boardMenu.hidden) {
      boardMenu.hidden = true;
      catalogNav?.querySelector('[data-action="board-toggle"]')?.setAttribute('aria-expanded', 'false');
    }
    if (header?.dataset.menuOpen === 'true') {
      header.dataset.menuOpen = 'false';
      menuToggle?.setAttribute('aria-expanded', 'false');
    }
  }

  if (document.documentElement) {
    catalogSortAdapter = createAnimanchCatalogSortAdapter(pageWindow, {
      isActive: () => isMixPath() && isCatalogScreen(),
      onError: reportSortError,
    });
    start();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      catalogSortAdapter = createAnimanchCatalogSortAdapter(pageWindow, {
        isActive: () => isMixPath() && isCatalogScreen(),
        onError: reportSortError,
      });
      start();
    }, { once: true });
  }
  window.addEventListener('popstate', reconcile);
  window.addEventListener('hashchange', reconcile);
  document.addEventListener('change', handleNativeBoardSelectionChange, true);
  document.addEventListener('change', handleNativeSortChange, true);
  document.addEventListener('change', handleNativeAutoReloadChange, true);
  document.addEventListener('click', handleNativeMobileSortClick, true);
  document.addEventListener('click', handlePostReportClickCapture, true);
  document.addEventListener('click', handleSequenceClickCapture, true);
  document.addEventListener('keydown', handleSequenceKeydownCapture, true);
  document.addEventListener('keydown', handleGlobalKeydown);
})();
