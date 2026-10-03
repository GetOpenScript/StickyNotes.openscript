// ==UserScript==
// @name         Sticky Notes
// @version      1.0.0
// @description  Classic sticky notes on any webpage, pinned to the exact URL and synced to your own SurrealDB.
// @match        *://*/*
// @run-at       document_start
// ==/UserScript==

const { storage } = OpenScript; // `env` is provided by the OpenScript wrapper
const NS = env.SURREAL_NS || 'openscript', DB = env.SURREAL_DB || 'sticky_notes', TB = 'sticky_note';
const READY = !!(env.SURREAL_URL && env.SURREAL_USER && env.SURREAL_PASS);
const ENDPOINT = `${(env.SURREAL_URL || '').trim().replace(/^ws(s?):\/\//i, 'http$1://')
  .replace(/^(?![a-z]+:\/\/)/i, 'https://').replace(/\/(rpc|sql)?\/?$/i, '')}/rpc`;
const AUTH = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)))}`;
const SRC = `${ENDPOINT}|${NS}|${DB}`;
const FIELDS = ['url', 'title', 'x', 'y', 'w', 'h', 'text', 'color', 'collapsed'];
const NOTE = { w: 240, h: 200, minW: 170, minH: 110, maxW: 720, maxH: 900 };
const INDEX_TTL = 60e3;
const TRACKING = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|msclkid|yclid|mc_[ce]id|igshid|_hsenc|_hsmi)$/i;
const ICON = { x: 'M6 6l12 12M18 6 6 18', collapse: 'M6 12h12', expand: 'm6 9 6 6 6-6' };
const COLORS = {
  yellow: ['#fff7a8', '#fbe97a'], pink: ['#ffd8e4', '#ffbed2'], green: ['#dbf6c8', '#c2eba6'],
  blue: ['#d5eaff', '#b6d9ff'], purple: ['#e8ddfd', '#d5c3f8'], orange: ['#ffe1c0', '#ffc993'],
};
// Values are inlined as escaped SurrealQL literals instead of RPC variables: SurrealDB's JSON-RPC
// coerces strings that start like a record id, so a note reading "todo: buy milk" would be stored as todo:buy.
const lit = v => JSON.stringify(v, (k, x) => typeof x === 'string' ? x.toWellFormed() : x);
const Q = {
  schema: `DEFINE TABLE IF NOT EXISTS ${TB} SCHEMALESS;
    DEFINE FIELD IF NOT EXISTS created ON ${TB} TYPE datetime DEFAULT time::now() READONLY;
    DEFINE FIELD IF NOT EXISTS updated ON ${TB} TYPE datetime VALUE time::now();
    DEFINE INDEX IF NOT EXISTS ${TB}_url ON ${TB} FIELDS url;`,
  page: url => `SELECT *, record::id(id) AS id FROM ${TB} WHERE url = ${lit(url)} ORDER BY created`,
  pages: `array::distinct((SELECT VALUE url FROM ${TB}))`,
  all: `SELECT *, record::id(id) AS id FROM ${TB} ORDER BY updated DESC LIMIT 2000`,
  upsert: (id, data) => `UPSERT type::thing('${TB}', ${lit(id)}) MERGE ${lit(data)} RETURN NONE`,
  delete: id => `DELETE type::thing('${TB}', ${lit(id)})`,
};
const FONT = `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const CSS = `
  :host { all: initial; }
  @media print { :host { display: none !important; } }
  * { box-sizing: border-box; }
  ${Object.entries(COLORS).map(([c, [bg, bar]]) => `[data-color=${c}] { --bg: ${bg}; --bar: ${bar}; }`).join('\n')}
  .layer { position: absolute; left: 0; top: 0; z-index: 0; }
  .layer[hidden] { display: none; }
  .panel, .toasts { z-index: 1; }
  .note {
    position: absolute; left: 0; top: 0; display: flex; flex-direction: column; color: #2d2a1e;
    font: 14px/1.5 ${FONT}; -webkit-font-smoothing: antialiased; border-radius: 2px 2px 3px 3px;
    background: linear-gradient(175deg, var(--bg) 55%, color-mix(in srgb, var(--bg), #000 4%));
    box-shadow: 0 1px 1px rgb(0 0 0 / .08), 0 4px 10px -4px rgb(0 0 0 / .18), 0 18px 32px -16px rgb(0 0 0 / .32);
    transition: box-shadow .2s, rotate .2s, scale .2s;
  }
  .note.dragging { rotate: -1.2deg; scale: 1.02; box-shadow: 0 2px 4px rgb(0 0 0 / .1), 0 26px 44px -14px rgb(0 0 0 / .42); }
  .dragging, .dragging * { cursor: grabbing !important; }
  .bar {
    flex: none; display: flex; align-items: center; gap: 2px; height: 30px; padding: 0 4px 0 7px;
    background: var(--bar); border-radius: 2px 2px 0 0; cursor: grab; user-select: none; touch-action: none;
  }
  .collapsed .bar { border-radius: 2px; }
  .grip {
    flex: none; width: 12px; height: 16px; margin-right: 4px; opacity: .4;
    background: radial-gradient(circle, #000 1px, transparent 1.5px) 0 0 / 6px 5.33px;
  }
  .label {
    flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    font-size: 12.5px; font-weight: 500; color: rgb(0 0 0 / .6);
  }
  .err .label { color: #b42318; cursor: pointer; }
  .btn {
    all: unset; flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px;
    color: rgb(0 0 0 / .55); cursor: pointer; opacity: 0; transition: opacity .15s, background-color .15s, color .15s;
  }
  .note:hover .btn, .note:focus-within .btn, .collapsed .btn { opacity: 1; }
  .btn:hover { background: rgb(0 0 0 / .08); color: rgb(0 0 0 / .85); }
  .btn:focus-visible { opacity: 1; outline: 2px solid rgb(0 0 0 / .45); outline-offset: -2px; }
  .btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .dot { width: 13px; height: 13px; border-radius: 50%; background: var(--bg); box-shadow: inset 0 0 0 1.5px rgb(0 0 0 / .35); }
  .palette {
    position: absolute; top: 34px; right: 6px; z-index: 1; display: none; gap: 7px; padding: 8px;
    background: #fff; border-radius: 10px; box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 10px 24px -6px rgb(0 0 0 / .3);
  }
  .palette.open { display: flex; }
  .swatch {
    all: unset; width: 20px; height: 20px; border-radius: 50%; background: var(--bg); cursor: pointer;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18); transition: transform .12s;
  }
  .swatch:hover { transform: scale(1.15); }
  .swatch[aria-pressed=true] { box-shadow: inset 0 0 0 1px rgb(0 0 0 / .18), 0 0 0 2px #fff, 0 0 0 4px rgb(0 0 0 / .5); }
  textarea {
    all: unset; flex: 1; min-height: 0; display: block; padding: 10px 14px 18px; color: inherit; font: inherit;
    white-space: pre-wrap; overflow-wrap: anywhere; overflow-y: auto; cursor: text;
    scrollbar-width: thin; scrollbar-color: rgb(0 0 0 / .2) transparent;
  }
  textarea::placeholder { color: rgb(0 0 0 / .35); }
  .collapsed textarea, .collapsed .resize { display: none; }
  .resize {
    position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none;
    background: linear-gradient(135deg, transparent 50%, color-mix(in srgb, var(--bar), #000 10%) 50%);
    border-radius: 0 0 3px 0; opacity: .55; transition: opacity .15s;
  }
  .note:hover .resize { opacity: 1; }
  .pop { animation: pop .22s cubic-bezier(.2, .9, .3, 1.25); }
  @keyframes pop { from { opacity: 0; scale: .9; } }
  .flash { animation: flash .8s ease 2; }
  @keyframes flash { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--bar), transparent 25%), 0 18px 32px -16px rgb(0 0 0 / .32); } }
  .toasts {
    position: fixed; left: 50%; bottom: 24px; translate: -50% 0; display: flex; flex-direction: column;
    align-items: center; gap: 8px; pointer-events: none; font: 13.5px/1.4 ${FONT};
  }
  .toast {
    display: flex; align-items: center; gap: 14px; max-width: min(480px, calc(100vw - 32px)); padding: 10px 16px;
    color: #f5f5f4; background: #262522; border-radius: 10px; box-shadow: 0 12px 30px -8px rgb(0 0 0 / .45);
    pointer-events: auto; animation: rise .2s ease;
  }
  .toast:has(button) { padding-right: 8px; }
  .toast button { all: unset; padding: 4px 8px; margin: -4px 0; border-radius: 6px; color: #fde68a; font-weight: 600; cursor: pointer; }
  .toast button:hover { background: rgb(255 255 255 / .1); }
  @keyframes rise { from { opacity: 0; translate: 0 8px; } }
  .panel {
    --p-bg: #fff; --p-fg: #1c1b18; --p-muted: #77736a; --p-line: rgb(0 0 0 / .08); --p-hover: rgb(0 0 0 / .045); --p-input: #f5f4f1;
    position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(380px, calc(100vw - 24px)); display: flex;
    flex-direction: column; color: var(--p-fg); background: var(--p-bg); border-radius: 14px; overflow: hidden;
    box-shadow: 0 0 0 1px var(--p-line), 0 30px 60px -12px rgb(0 0 0 / .35); font: 13.5px/1.45 ${FONT}; animation: slide .2s ease;
  }
  @media (prefers-color-scheme: dark) {
    .panel { --p-bg: #1d1c1a; --p-fg: #ecebe8; --p-muted: #9a968d; --p-line: rgb(255 255 255 / .09); --p-hover: rgb(255 255 255 / .05); --p-input: #282724; }
  }
  @keyframes slide { from { opacity: 0; translate: 16px 0; } }
  .panel header { display: flex; align-items: center; gap: 8px; padding: 14px 10px 10px 18px; }
  .panel h2 { all: unset; flex: 1; font-size: 16px; font-weight: 650; }
  .count { color: var(--p-muted); font-variant-numeric: tabular-nums; }
  .panel .btn { opacity: 1; color: var(--p-muted); }
  .panel .btn:hover { background: var(--p-hover); color: var(--p-fg); }
  .search { all: unset; margin: 0 14px 8px; padding: 9px 12px; background: var(--p-input); border-radius: 9px; box-shadow: inset 0 0 0 1px var(--p-line); }
  .search:focus { box-shadow: inset 0 0 0 2px #e6bf2a; }
  .search::placeholder { color: var(--p-muted); }
  .list { flex: 1; overflow-y: auto; padding: 4px 8px 12px; scrollbar-width: thin; }
  .group + .group { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--p-line); }
  .page { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px 4px; color: inherit; text-decoration: none; }
  .page .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
  .page:hover .title { text-decoration: underline; }
  .host { flex: none; max-width: 45%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--p-muted); font-size: 12px; }
  .item { display: flex; align-items: flex-start; gap: 10px; padding: 7px 6px 7px 10px; border-radius: 8px; cursor: pointer; outline: none; }
  .item:hover, .item:focus-visible { background: var(--p-hover); }
  .chip {
    flex: none; width: 14px; height: 14px; margin-top: 3px; border-radius: 2px; box-shadow: 0 1px 2px rgb(0 0 0 / .2);
    background: linear-gradient(var(--bar, #fbe97a) 0 4px, var(--bg, #fff7a8) 4px);
  }
  .snippet {
    flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
    overflow: hidden; white-space: pre-line; overflow-wrap: anywhere;
  }
  .meta { flex: none; padding-top: 1px; color: var(--p-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .item .btn { width: 22px; height: 22px; margin: -1px 0; opacity: 0; }
  .item:hover .btn, .item:focus-within .btn { opacity: 1; }
  .empty { margin: 0; padding: 48px 24px; text-align: center; color: var(--p-muted); }
  .empty.err { color: #c2410c; }
  .panel footer {
    padding: 10px 18px; border-top: 1px solid var(--p-line); color: var(--p-muted); font-size: 12px;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

// ---------- helpers ----------
const $ = (tag, { data, ...props } = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  if (data) Object.assign(el.dataset, data);
  el.append(...kids);
  return el;
};
const icon = d => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};
const button = (className, title, kid, onclick) =>
  $('button', { className: `btn ${className}`, type: 'button', title, ariaLabel: title, onclick }, kid);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const viewW = () => document.documentElement.clientWidth;
const ago = t => {
  const s = (Date.now() - Date.parse(t)) / 1e3;
  return isNaN(s) ? '' : s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h`
    : s < 2592000 ? `${s / 86400 | 0}d` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
// Exact page URL, minus tracking params and in-page anchors (hash routes like #/inbox are kept).
const pageKey = () => {
  const u = new URL(location.href);
  [...u.searchParams.keys()].filter(k => TRACKING.test(k)).forEach(k => u.searchParams.delete(k));
  if (!/^#!?\//.test(u.hash)) u.hash = '';
  return u.href;
};
const domReady = new Promise(r => document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r());

// ---------- SurrealDB ----------
const query = async sql => {
  const res = await OpenScript.fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: AUTH, 'Surreal-NS': NS, 'Surreal-DB': DB,
    },
    body: JSON.stringify({ id: 1, method: 'query', params: [sql] }),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch {}
  const err = res.status === 401 ? 'SurrealDB rejected SURREAL_USER / SURREAL_PASS'
    : out?.error?.message || (!Array.isArray(out?.result) && (text.slice(0, 200) || `HTTP ${res.status}`))
    || out.result.find(r => r.status !== 'OK')?.result;
  if (err) throw new Error(err);
  return out.result.map(r => r.result);
};
let writes = Promise.resolve(), schema;
const write = fn => writes = writes.catch(() => {}).then(fn); // serialised so saves and deletes never race
const ensureSchema = () => schema ||= (async () => {
  if (await storage.get('schema') === SRC) return;
  await query(Q.schema);
  await storage.set('schema', SRC);
})().catch(e => { schema = null; throw e; });
const pick = d => Object.fromEntries(FIELDS.map(k => [k, d[k]]));
const upsert = d => write(async () => {
  await ensureSchema();
  await query(Q.upsert(d.id, pick(d)));
});
// Notes that failed to save are kept locally and replayed on the next page load, so closing a tab offline loses nothing.
const outbox = async (d, keep) => {
  const box = await storage.get('outbox') || {};
  if (keep) box[d.id] = { id: d.id, ...pick(d) };
  else delete box[d.id];
  await storage.set('outbox', box);
};
const replayOutbox = async () => {
  for (const d of Object.values(await storage.get('outbox') || {})) {
    await upsert(d);
    await outbox(d, false);
  }
};
// Cached list of URLs that have notes, so most page loads never touch the database.
const indexEdit = async (url, add) => {
  const idx = await storage.get('index');
  if (idx?.src !== SRC) return;
  const urls = idx.urls.filter(u => u !== url);
  await storage.set('index', { ...idx, urls: add ? [...urls, url] : urls });
};

// ---------- state ----------
const notes = new Map();
let key = pageKey(), host, root, layer, toasts, panel, renderPanel, panelAll = [];
let hidden = false, z = 1, loadSeq = 0, warned = false, offButtons = [];

// ---------- UI shell ----------
const ui = () => {
  if (host) return;
  host = document.createElement('openscript-sticky-notes');
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647';
  root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  root.append(layer = $('div', { className: 'layer', hidden }), toasts = $('div', { className: 'toasts' }));
  // Keep our clicks, focus and selection from reaching page handlers (menus, focus traps, copy blockers).
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart',
    'touchmove', 'focusin', 'focusout', 'input', 'beforeinput', 'selectstart', 'dragstart']
    .forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
  root.addEventListener('pointerdown', e => notes.forEach(n =>
    n.palette.contains(e.target) || n.colorBtn.contains(e.target) || n.palette.classList.remove('open')), true);
  document.documentElement.append(host);
  new MutationObserver(() => host.isConnected || document.documentElement.append(host))
    .observe(document.documentElement, { childList: true });
};
const toast = (msg, action, fn, ms = 6000) => {
  ui();
  const t = $('div', { className: 'toast', role: 'status' }, $('span', { textContent: msg }));
  if (action) t.append($('button', { type: 'button', textContent: action, onclick: () => { t.remove(); fn(); } }));
  toasts.append(t);
  while (toasts.children.length > 3) toasts.firstChild.remove();
  setTimeout(() => t.remove(), ms);
};
const setupHint = () => toast('Sticky Notes needs SURREAL_URL, SURREAL_USER and SURREAL_PASS in OpenScript › Secrets. Reload the page after adding them.', null, null, 9000);
const setHidden = v => {
  hidden = v;
  if (layer) layer.hidden = v;
  syncButtons();
};
const syncButtons = () => {
  offButtons.forEach(off => off());
  if (!OpenScript.button) return;
  const c = notes.size, s = c > 1 ? 's' : '';
  offButtons = [
    OpenScript.button('Add sticky note', addNote),
    c && OpenScript.button(hidden ? `Show ${c} hidden note${s}` : `Hide note${s} on this page`, () => setHidden(!hidden)),
    OpenScript.button('All sticky notes', openPanel),
  ].filter(Boolean);
};

// ---------- notes ----------
// x is the offset from the page's centre line, so notes stay beside centred content at any window width.
const pos = n => ({
  x: clamp(Math.round(viewW() / 2 + n.data.x), 0, Math.max(0, viewW() - n.data.w)),
  y: Math.max(0, n.data.y),
});
const place = n => {
  const { x, y } = pos(n);
  Object.assign(n.el.style, {
    transform: `translate(${x}px, ${y}px)`, width: `${n.data.w}px`, height: n.data.collapsed ? '' : `${n.data.h}px`,
  });
};
const paint = n => {
  const { data: d, el } = n, text = d.text || '';
  el.dataset.color = COLORS[d.color] ? d.color : 'yellow';
  el.classList.toggle('collapsed', !!d.collapsed);
  el.classList.toggle('err', !!n.err);
  n.label.textContent = n.err ? 'Not saved · retry' : d.collapsed ? text.trim().split('\n')[0] || 'Empty note' : '';
  n.label.title = n.err || '';
  n.minBtn.title = n.minBtn.ariaLabel = d.collapsed ? 'Expand' : 'Collapse';
  n.minBtn.replaceChildren(icon(d.collapsed ? ICON.expand : ICON.collapse));
  [...n.palette.children].forEach(s => s.ariaPressed = s.dataset.color === el.dataset.color);
  if (root.activeElement !== n.ta && n.ta.value !== text) n.ta.value = text;
};
const front = n => n.el.style.zIndex = ++z;
const status = (n, err) => {
  n.err = err?.message;
  paint(n);
};
const persist = n => {
  clearTimeout(n.timer);
  n.timer = 0;
  if (n.gone) return;
  if (n.data.url === key) n.data.title = document.title;
  upsert(n.data).then(() => {
    n.data.updated = new Date().toISOString();
    if (n.boxed) n.boxed = false, outbox(n.data, false);
    status(n);
  }, e => {
    n.boxed = true;
    outbox(n.data, true);
    status(n, e);
    n.timer ||= setTimeout(() => persist(n), 15e3);
  });
};
const save = (n, delay = 0) => {
  n.touched = Date.now();
  clearTimeout(n.timer);
  n.timer = setTimeout(() => persist(n), delay);
};
const flush = () => notes.forEach(n => n.timer && persist(n));
const collapse = n => {
  n.data.collapsed = !n.data.collapsed;
  paint(n);
  place(n);
  save(n);
};

const drag = (e, n, mode) => {
  if (e.button || e.target.closest('button')) return;
  e.preventDefault();
  front(n);
  const { el, data: d } = n, o = { ...d, ...pos(n) }, sx = e.clientX + scrollX, sy = e.clientY + scrollY;
  const ac = new AbortController(), opts = { capture: true, signal: ac.signal };
  let last = e, active = false, raf;
  const apply = () => {
    const dx = last.clientX + scrollX - sx, dy = last.clientY + scrollY - sy, vw = viewW();
    if (mode === 'move') {
      d.x = Math.round(clamp(o.x + dx, 0, Math.max(0, vw - d.w)) - vw / 2);
      d.y = Math.round(Math.max(0, o.y + dy));
    } else {
      d.w = Math.round(clamp(o.w + dx, NOTE.minW, NOTE.maxW));
      d.h = Math.round(clamp(o.h + dy, NOTE.minH, NOTE.maxH));
    }
    place(n);
  };
  const tick = () => { // follows wheel scrolling and auto-scrolls near the viewport edges
    const v = mode === 'move' && (last.clientY < 32 ? -14 : last.clientY > innerHeight - 32 ? 14 : 0);
    if (v) scrollBy(0, v);
    apply();
    raf = requestAnimationFrame(tick);
  };
  const end = () => {
    ac.abort();
    cancelAnimationFrame(raf);
    el.classList.remove('dragging', 'resizing');
    if (active) apply(), save(n);
  };
  addEventListener('pointermove', ev => {
    last = ev;
    if (active || Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
    active = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add(mode === 'move' ? 'dragging' : 'resizing');
    n.palette.classList.remove('open');
    tick();
  }, opts);
  addEventListener('pointerup', end, opts);
  addEventListener('pointercancel', end, opts);
};

const mount = (data, fresh) => {
  ui();
  const n = { id: data.id, touched: 0, timer: 0 };
  n.data = { text: '', color: 'yellow', collapsed: false, x: -NOTE.w / 2, y: 0, w: NOTE.w, h: NOTE.h, ...data };
  const ta = $('textarea', {
    value: n.data.text, placeholder: 'Write a note…', ariaLabel: 'Sticky note',
    oninput: () => { n.data.text = ta.value; save(n, 700); },
    onblur: () => n.timer && persist(n),
  });
  const palette = $('div', { className: 'palette', role: 'group', ariaLabel: 'Note colour' },
    ...Object.keys(COLORS).map(c => $('button', {
      className: 'swatch', type: 'button', title: c[0].toUpperCase() + c.slice(1), data: { color: c },
      onclick: () => { n.data.color = c; palette.classList.remove('open'); paint(n); save(n); },
    })));
  const label = $('span', { className: 'label', onclick: () => n.err && persist(n) });
  const colorBtn = button('color', 'Colour', $('span', { className: 'dot' }), () => palette.classList.toggle('open'));
  const minBtn = button('min', 'Collapse', '', () => collapse(n));
  const bar = $('div', {
    className: 'bar', title: 'Drag to move · double-click to collapse',
    onpointerdown: e => drag(e, n, 'move'), ondblclick: e => e.target.closest('button') || collapse(n),
  }, $('span', { className: 'grip' }), label, colorBtn, minBtn,
  button('del', 'Delete note', icon(ICON.x), () => destroy(n.data)));
  n.el = $('div', { className: `note${fresh ? ' pop' : ''}`, onpointerdown: () => front(n) }, bar, palette, ta,
    $('div', { className: 'resize', title: 'Resize', onpointerdown: e => drag(e, n, 'size') }));
  Object.assign(n, { ta, label, palette, colorBtn, minBtn });
  notes.set(n.id, n);
  layer.append(n.el);
  paint(n);
  place(n);
  front(n);
  syncButtons();
  return n;
};
const unmount = n => {
  n.el.remove();
  notes.delete(n.id);
  syncButtons();
};
const reveal = n => {
  setHidden(false);
  scrollTo({ top: Math.max(0, pos(n).y - innerHeight / 3), behavior: 'smooth' });
  front(n);
  n.el.classList.remove('flash');
  void n.el.offsetWidth;
  n.el.classList.add('flash');
};

const addNote = async () => {
  if (!READY) return setupHint();
  await domReady;
  setHidden(false);
  let x = -NOTE.w / 2, y = Math.round(scrollY + innerHeight * .2);
  while ([...notes.values()].some(n => Math.abs(n.data.x - x) < 16 && Math.abs(n.data.y - y) < 16)) x += 28, y += 28;
  const n = mount({
    id: crypto.randomUUID().replaceAll('-', ''), url: key, title: document.title,
    x, y, w: NOTE.w, h: NOTE.h, text: '', color: 'yellow', collapsed: false,
  }, true);
  save(n);
  indexEdit(key, true);
  n.ta.focus({ preventScroll: true });
};
const destroy = d => {
  const n = notes.get(d.id);
  if (n) {
    n.gone = true;
    clearTimeout(n.timer);
    unmount(n);
    if (n.boxed) outbox(d, false);
  }
  panelAll = panelAll.filter(x => x.id !== d.id);
  renderPanel?.();
  write(() => query(Q.delete(d.id))).catch(e => toast(`Couldn't delete the note: ${e.message}`));
  if (!(d.url === key ? notes.size : panelAll.some(x => x.url === d.url))) indexEdit(d.url, false);
  toast('Note deleted', 'Undo', () => restore(d));
};
const restore = d => {
  indexEdit(d.url, true);
  if (renderPanel) panelAll.unshift(d), renderPanel();
  if (d.url !== key) return upsert(d).catch(e => toast(`Couldn't restore the note: ${e.message}`));
  setHidden(false);
  save(mount(d, true));
};

// ---------- loading & sync ----------
const reconcile = (list, since) => {
  const ids = new Set(list.map(d => d.id));
  for (const d of list) {
    const n = notes.get(d.id);
    if (!n) mount(d);
    else if (n.touched < since && !n.timer && root.activeElement !== n.ta && !n.el.matches('.dragging, .resizing')) {
      n.data = { ...n.data, ...d };
      paint(n);
      place(n);
    }
  }
  notes.forEach(n => ids.has(n.id) || n.touched >= since || n.timer || unmount(n));
  if (list.length) focusRequest();
};
const load = async () => {
  if (!READY) return;
  const seq = ++loadSeq, url = key, since = Date.now();
  await replayOutbox().catch(e => console.warn('[Sticky Notes] outbox replay failed', e));
  const idx = await storage.get('index').catch(() => null), known = idx?.src === SRC ? idx : null;
  const fresh = known && since - known.at < INDEX_TTL;
  if (fresh && !known.urls.includes(url)) return;
  try {
    const [list = [], urls] = await query(fresh ? Q.page(url) : `${Q.page(url)}; ${Q.pages}`);
    if (urls) await storage.set('index', { src: SRC, at: since, urls });
    await domReady;
    if (seq === loadSeq && url === key) reconcile(list, since);
  } catch (e) {
    console.warn('[Sticky Notes]', e);
    if (!warned && known?.urls.includes(url)) warned = true, toast(`Couldn't load sticky notes: ${e.message}`);
  }
};
// Set by "All sticky notes" before opening another page, so that page scrolls to the chosen note.
const focusRequest = async () => {
  const f = await storage.get('focus');
  if (f?.url !== key || Date.now() - f.at > 30e3) return;
  await storage.delete('focus');
  const n = notes.get(f.id), go = () => reveal(n);
  if (n) document.hidden ? document.addEventListener('visibilitychange', go, { once: true }) : go();
};

// ---------- all notes panel ----------
const closePanel = () => {
  panel?.remove();
  panel = renderPanel = null;
  panelAll = [];
};
const go = d => {
  if (d.url === key) {
    closePanel();
    const n = notes.get(d.id);
    return n ? reveal(n) : load();
  }
  if (!/^https?:\/\//.test(d.url)) return;
  window.open(d.url, '_blank', 'noopener');
  storage.set('focus', { url: d.url, id: d.id, at: Date.now() });
};
const group = (url, ds) => {
  const here = url === key, u = URL.parse(url);
  return $('section', { className: 'group' },
    $('a', {
      className: 'page', href: /^https?:/.test(url) ? url : '', target: '_blank', rel: 'noopener', title: url,
      onclick: e => here && (e.preventDefault(), closePanel()),
    }, $('span', { className: 'title', textContent: ds.find(d => d.title)?.title || (u ? u.host + u.pathname : url) }),
    $('span', { className: 'host', textContent: here ? 'This page' : u?.hostname.replace(/^www\./, '') || '' })),
    ...ds.map(d => $('div', { className: 'item', tabIndex: 0, role: 'button', onclick: () => go(d) },
      $('span', { className: 'chip', data: { color: d.color } }),
      $('span', { className: 'snippet', textContent: d.text?.trim() || 'Empty note' }),
      $('span', { className: 'meta', textContent: ago(d.updated), title: d.updated ? new Date(d.updated).toLocaleString() : '' }),
      button('del', 'Delete note', icon(ICON.x), e => { e.stopPropagation(); destroy(d); }))));
};
const openPanel = async () => {
  if (!READY) return setupHint();
  await domReady;
  ui();
  closePanel();
  const search = $('input', { className: 'search', type: 'search', placeholder: 'Search notes and pages', ariaLabel: 'Search notes' });
  const count = $('span', { className: 'count' });
  const list = $('div', { className: 'list' }, $('p', { className: 'empty', textContent: 'Loading…' }));
  const me = panel = $('aside', { className: 'panel', role: 'dialog', ariaLabel: 'All sticky notes' },
    $('header', {}, $('h2', { textContent: 'Sticky notes' }), count, button('close', 'Close', icon(ICON.x), closePanel)),
    search, list, $('footer', { textContent: `${ENDPOINT.replace(/^\w+:\/\/|\/rpc$/g, '')} · ${NS}/${DB}` }));
  root.append(panel);
  search.focus();
  search.oninput = () => renderPanel?.();
  let all;
  try {
    [all] = await query(Q.all);
  } catch (e) {
    if (panel === me) list.replaceChildren($('p', { className: 'empty err', textContent: `Couldn't load notes: ${e.message}` }));
    return;
  }
  if (all.length < 2000) storage.set('index', { src: SRC, at: Date.now(), urls: [...new Set(all.map(d => d.url))] });
  if (panel !== me) return;
  panelAll = all;
  (renderPanel = () => {
    const q = search.value.trim().toLowerCase();
    const hits = panelAll.filter(d => !q || `${d.text}\n${d.title}\n${d.url}`.toLowerCase().includes(q));
    const groups = [...Map.groupBy(hits, d => d.url)].sort(([a], [b]) => (b === key) - (a === key));
    count.textContent = hits.length || '';
    list.replaceChildren(...groups.map(([url, ds]) => group(url, ds)));
    if (!groups.length) list.append($('p', {
      className: 'empty', textContent: q ? 'No matching notes.' : 'No sticky notes yet. Use “Add sticky note” in the OpenScript popup.',
    }));
  })();
};

// ---------- wiring ----------
// Registered at document_start so it runs before any page listener: typing in a note never
// triggers site shortcuts, and copy/paste blockers can't interfere.
['keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste'].forEach(t => addEventListener(t, e => {
  if (!host || !e.composedPath().includes(host)) return;
  e.stopImmediatePropagation();
  if (t !== 'keydown' || e.isComposing) return;
  const el = root.activeElement;
  if (e.key === 'Escape') {
    notes.forEach(n => n.palette.classList.remove('open'));
    panel ? closePanel() : el?.blur();
  } else if (e.key === 'Enter' && el?.matches('.item')) el.click();
}, true));
addEventListener('pointerdown', e => {
  if (!host || e.composedPath().includes(host)) return;
  closePanel();
  notes.forEach(n => n.palette.classList.remove('open'));
}, true);
globalThis.navigation?.addEventListener('currententrychange', () => {
  const k = pageKey();
  if (k === key) return;
  flush();
  closePanel();
  notes.forEach(unmount);
  key = k;
  load();
});
document.addEventListener('visibilitychange', () => document.hidden ? flush() : load());
addEventListener('pagehide', flush);
new ResizeObserver(() => notes.forEach(place)).observe(document.documentElement); // window resizes, scrollbars, side panels
syncButtons();
load();
