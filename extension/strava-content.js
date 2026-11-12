// Isolated-world content script: receives detected climbs from inject.js, asks the
// background worker for names, shows them in the ClimbNamer panel and as bands on
// Strava's elevation chart. A click on a climb points out its top on Strava's map
// (using Strava's own chart hover marker; the map itself can't be drawn on).
(() => {
  /**
   * @typedef {{ name: string, detail: string, source: string }} ClimbName
   * @typedef {{
   *   startDist: number, endDist: number, topDist?: number, length: number, gain: number, grade: number,
   *   maxEle: number, minEle: number, start: number[], top: number[], points: number[][],
   *   auto?: ClimbName, error?: string
   * }} Climb
   * @typedef {{ routeId: string, name: string, totalDist: number, climbs: Climb[] }} RouteEntry
   * @typedef {{ start: number[], top: number[], name: string }} Override
   */

  /** @type {Map<string, RouteEntry>} routeId -> detected climbs */
  const byRoute = new Map();
  /** @type {RouteEntry|null} entry for the route that is open now */
  let current = null;
  /** @type {Override[]} */
  let overrides = [];
  /** @type {boolean} */
  let collapsed = false;
  /** @type {Climb|null} climb highlighted on the chart (clicked in the panel) */
  let activeClimb = null;
  /** @type {Climb|null} climb under the mouse in the panel */
  let hoverClimb = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------- helpers ----------
  /**
   * Distance in metres between two [lat, lon] points.
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number}
   */
  function hav(a, b) {
    const R = 6371000, r = (/** @type {number} */ d) => (d * Math.PI) / 180;
    const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 +
      Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /**
   * @param {number} m metres
   * @returns {string}
   */
  const km = (m) => (m / 1000).toFixed(1) + ' km';

  /**
   * HTML-escapes a value.
   * @param {unknown} s
   * @returns {string}
   */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Route ID of the open page (/routes/123), or null.
   * @returns {string|null}
   */
  function routeIdFromUrl() {
    const m = location.pathname.match(/\/routes\/(\d+)/);
    return m ? m[1] : null;
  }


  /**
   * @param {Climb} c
   * @returns {Override|undefined}
   */
  function findOverride(c) {
    return overrides.find((o) => hav(o.top, c.top) < 200 && hav(o.start, c.start) < 500);
  }

  /**
   * @param {Climb} c
   * @returns {ClimbName}
   */
  function displayName(c) {
    const o = findOverride(c);
    if (o) return { name: o.name, detail: c.auto?.name && c.auto.name !== o.name ? 'OSM: ' + c.auto.name : '', source: 'custom' };
    if (c.auto) return c.auto;
    if (c.error) return { name: 'Lookup failed', detail: c.error, source: 'error' };
    return { name: 'Looking up name…', detail: '', source: 'pending' };
  }

  // ---------- storage ----------
  chrome.storage.sync.get({ overrides: [], collapsed: false }, (v) => {
    overrides = v.overrides || [];
    collapsed = !!v.collapsed;
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.overrides) {
      overrides = changes.overrides.newValue || [];
      render();
    }
  });

  /**
   * Asks for a name and stores it as an override for this climb's location.
   * @param {Climb} c
   * @returns {void}
   */
  function rename(c) {
    const cur = displayName(c).name;
    const input = prompt('Name for this climb (leave empty to use the automatic name):', findOverride(c) ? cur : (c.auto?.name || ''));
    if (input === null) return;
    const name = input.trim();
    const rest = overrides.filter((o) => o !== findOverride(c));
    const next = name ? [...rest, { start: c.start, top: c.top, name }] : rest;
    chrome.storage.sync.set({ overrides: next });
  }

  // ---------- data in ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__climbNamerStrava || ev.data.type !== 'climbs') return;
    const p = ev.data.payload;
    /** @type {RouteEntry} */
    const entry = { routeId: p.routeId, name: p.name, totalDist: p.totalDist, climbs: p.climbs };
    // Keep names already found when the same route loads again.
    const prev = byRoute.get(p.routeId);
    if (prev) entry.climbs.forEach((c, i) => { const o = prev.climbs[i]; if (o && o.startDist === c.startDist && o.auto) c.auto = o.auto; });
    byRoute.set(p.routeId, entry);
    current = null;
    syncCurrent();
    requestNames(entry);
  });

  /**
   * Looks up names for the climbs of a route that don't have one yet, in two steps:
   * 1. localOnly: names from the cache and local summit data, shown immediately;
   * 2. a normal lookup (network) for the climbs that are still unnamed.
   * So a climb that needs a slow lookup doesn't hold back names that are known locally.
   * @param {RouteEntry} entry
   * @returns {void}
   */
  function requestNames(entry) {
    /** @type {Climb[]} */
    const todo = entry.climbs.filter((c) => !c.auto);
    if (!todo.length) return;
    todo.forEach((c) => delete c.error);
    render();

    /**
     * @param {Climb[]} climbs
     * @param {boolean} localOnly
     * @param {(res: { ok: boolean, names?: Array<ClimbName|{ error: string }|null>, error?: string }|undefined) => void} done
     * @returns {void}
     */
    const ask = (climbs, localOnly, done) => chrome.runtime.sendMessage(
      {
        type: 'nameClimbs',
        localOnly,
        climbs: climbs.map((c) => ({ start: c.start, top: c.top, maxEle: c.maxEle, points: c.points })),
      },
      done
    );

    ask(todo, true, (quick) => {
      if (!chrome.runtime.lastError && quick && quick.ok && quick.names) {
        const names = quick.names;
        todo.forEach((c, i) => {
          const r = names[i];
          if (r && !('error' in r)) c.auto = r;
        });
        render();
      }
      /** @type {Climb[]} */
      const rest = todo.filter((c) => !c.auto);
      if (!rest.length) return;
      ask(rest, false, (res) => {
        const fail = chrome.runtime.lastError?.message || (!res ? 'no response' : !res.ok ? res.error : null);
        rest.forEach((c, i) => {
          const r = fail ? { error: String(fail) } : res && res.names ? res.names[i] : null;
          if (r && 'error' in r) c.error = r.error;
          else if (r) c.auto = /** @type {ClimbName} */ (r);
        });
        render();
      });
    });
  }

  /**
   * Follows in-app navigation: shows the entry of the route that is open.
   * @returns {void}
   */
  function syncCurrent() {
    const id = routeIdFromUrl();
    const next = (id && byRoute.get(id)) || null;
    if (next !== current) {
      current = next;
      activeClimb = null;
      render();
    }
  }
  setInterval(syncCurrent, 600);

  // ---------- floating panel ----------
  /** @type {HTMLDivElement|null} */
  let panel = null;

  /**
   * Creates the panel once and wires its events.
   * @returns {HTMLDivElement}
   */
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'hhcn-panel';
    panel.dataset.site = 'strava'; // CSS: Strava has no map controls on the right
    panel.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      if (target.closest('a')) return; // the ↗ OpenStreetMap link
      const t = /** @type {HTMLElement|null} */ (target.closest('[data-hhcn]'));
      if (!t || !current) return;
      const act = t.dataset.hhcn;
      if (act === 'toggle') {
        collapsed = !collapsed;
        chrome.storage.sync.set({ collapsed });
        render();
      } else if (act === 'rename') {
        rename(current.climbs[Number(t.dataset.i)]);
      } else if (act === 'retry') {
        requestNames(current);
      } else if (act === 'open') {
        showClimb(current.climbs[Number(t.dataset.i)]);
      }
    });
    panel.addEventListener('mouseover', (e) => {
      const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.hhcn-row'));
      const c = row && current ? current.climbs[Number(row.dataset.i)] : null;
      if (c !== hoverClimb) { hoverClimb = c; drawBands(); }
    });
    panel.addEventListener('mouseleave', () => { hoverClimb = null; drawBands(); });
    document.body.appendChild(panel);
    return panel;
  }

  /** @type {Record<string, string>} small tag next to the name: where the name comes from */
  const SOURCE_LABEL = { summit: 'summit', road: 'road', place: 'place', custom: 'yours', none: '', pending: '', error: '' };
  /** @type {Record<string, string>} */
  const SOURCE_TITLE = {
    summit: 'Named summit or pass in OpenStreetMap',
    road: 'Name of the road the climb follows (OpenStreetMap)',
    place: 'Nearest village or town (OpenStreetMap)',
    custom: 'Your own name for this climb',
  };

  /** @returns {void} */
  function render() {
    renderPanel();
    drawBands();
  }

  /** @returns {void} */
  function renderPanel() {
    if (!current || !current.climbs.length) {
      if (panel) panel.style.display = 'none';
      return;
    }
    const el = ensurePanel();
    el.style.display = '';
    const rows = current.climbs.map((c, i) => {
      const d = displayName(c);
      const osm = `https://www.openstreetmap.org/?mlat=${c.top[0]}&mlon=${c.top[1]}#map=15/${c.top[0]}/${c.top[1]}`;
      return `<li class="hhcn-row hhcn-${d.source}${c === activeClimb ? ' hhcn-active' : ''}" data-hhcn="open" data-i="${i}" title="Show this climb on the elevation chart and its top on the map">
        <span class="hhcn-num">${i + 1}</span>
        <div class="hhcn-main">
          <div class="hhcn-name-row">
            <span class="hhcn-name" title="${esc(d.name)}">${esc(d.name)}</span>
            ${SOURCE_LABEL[d.source] ? `<span class="hhcn-src" title="${SOURCE_TITLE[d.source]}">${SOURCE_LABEL[d.source]}</span>` : ''}
          </div>
          ${d.detail ? `<div class="hhcn-detail" title="${esc(d.detail)}">${esc(d.detail)}</div>` : ''}
          <div class="hhcn-stats">${km(c.length)} · ${c.grade.toFixed(1)}% · +${c.gain} m · at ${km(c.startDist)}</div>
        </div>
        <div class="hhcn-actions">
          <button data-hhcn="rename" data-i="${i}" title="Rename this climb">✎</button>
          <a href="${osm}" target="_blank" rel="noopener" title="Show the top on OpenStreetMap">↗</a>
        </div>
      </li>`;
    }).join('');
    const anyError = current.climbs.some((c) => c.error && !c.auto);
    el.className = collapsed ? 'hhcn-collapsed' : '';
    el.innerHTML = `
      <button class="hhcn-head" data-hhcn="toggle" title="${collapsed ? 'Show' : 'Hide'} climb names">
        <span class="hhcn-head-title">Climb<b>Namer</b></span>
        <span class="hhcn-count" title="${current.climbs.length} climbs">${current.climbs.length}</span>
        <span class="hhcn-caret">${collapsed ? '▸' : '▾'}</span>
      </button>
      ${collapsed ? '' : `<ol class="hhcn-list">${rows}</ol>`}
      ${!collapsed && anyError ? '<button class="hhcn-retry" data-hhcn="retry">↻ Retry name lookup</button>' : ''}`;
  }

  /**
   * Selects (or deselects) a climb: highlighted in the panel and on the chart, and its
   * top pointed out on Strava's map.
   * @param {Climb} c
   * @returns {void}
   */
  function showClimb(c) {
    activeClimb = activeClimb === c ? null : c;
    renderPanel();
    drawBands();
    const chart = findChart();
    if (chart && activeClimb) chart.svg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Wait for the scroll, so the hover lands on the chart where it is now.
    const target = activeClimb;
    setTimeout(() => pointOnMap(target), target ? 450 : 0);
  }

  /**
   * Points out a climb's top on Strava's map by hovering Strava's own elevation chart
   * at that distance: Strava then shows its marker on the map and its tooltip on the
   * chart. With null, ends the hover.
   * @param {Climb|null} c
   * @returns {void}
   */
  function pointOnMap(c) {
    const chart = findChart();
    if (!chart) return;
    const hit = chart.hitbox;
    const ctm = chart.layer.getScreenCTM();
    const r = hit.getBoundingClientRect();
    /**
     * @param {string} type
     * @param {number} x
     * @returns {void}
     */
    const fire = (type, x) => {
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, view: window };
      hit.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
    };
    if (!c || !ctm) {
      ['pointerout', 'pointerleave', 'mouseout', 'mouseleave'].forEach((t) => fire(t, r.left - 5));
      return;
    }
    const x = new DOMPoint(chart.xOf(c.topDist ?? c.endDist), 0).matrixTransform(ctm).x;
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach((t) => fire(t, x));
  }

  // ---------- bands on Strava's elevation chart ----------
  /**
   * @typedef {{
   *   svg: SVGSVGElement, layer: SVGGElement, hitbox: SVGGraphicsElement,
   *   xOf: (m: number) => number, top: number, bottom: number, scaleKey: string
   * }} Chart
   */

  /**
   * Finds Strava's elevation chart and its distance scale. Coordinates are those of the
   * chart's own layer (the group that holds the hover hit area): the x-axis labels
   * ("2.0 km", "4.0 mi", …) are converted into it; the hit area gives top and bottom.
   * @returns {Chart|null}
   */
  function findChart() {
    if (!current) return null;
    const hits = /** @type {SVGGraphicsElement[]} */ ([...document.querySelectorAll('svg [class*="ElevationChart_hitbox"]')]);
    for (const hitbox of hits) {
      const svg = hitbox.ownerSVGElement;
      const layer = /** @type {SVGGElement} */ (hitbox.parentNode);
      const ctm = layer && layer.getScreenCTM ? layer.getScreenCTM() : null;
      if (!svg || !ctm) continue;
      const inv = ctm.inverse();
      /** @type {Array<{ m: number, x: number }>} */
      const ticks = [];
      for (const t of svg.querySelectorAll('text')) {
        const mt = (t.textContent || '').trim().match(/^([\d.,]+)\s*(km|mi)$/i);
        if (!mt) continue;
        const r = t.getBoundingClientRect();
        if (!r.width) continue;
        const unitM = mt[2].toLowerCase() === 'mi' ? 1609.344 : 1000;
        ticks.push({ m: parseFloat(mt[1].replace(',', '.')) * unitM, x: new DOMPoint(r.left + r.width / 2, r.top).matrixTransform(inv).x });
      }
      ticks.sort((p, q) => p.m - q.m);
      if (ticks.length < 2) continue;
      const a = ticks[0], b = ticks[ticks.length - 1];
      if (b.m <= a.m) continue;
      const perM = (b.x - a.x) / (b.m - a.m);
      const hb = hitbox.getBBox();
      return {
        svg, layer, hitbox,
        xOf: (m) => a.x + (m - a.m) * perM,
        top: hb.y, bottom: hb.y + hb.height,
        scaleKey: `${a.x.toFixed(1)},${perM.toFixed(5)},${hb.y},${hb.height}`,
      };
    }
    return null;
  }

  /** @type {boolean} */
  let drawing = false;

  /**
   * Draws (or updates) the orange climb bands on the elevation chart.
   * @returns {void}
   */
  function drawBands() {
    if (drawing) return;
    drawing = true;
    try {
      document.querySelectorAll('g.cn-bands').forEach((g) => {
        if (!current) g.remove();
      });
      const chart = findChart();
      if (!chart || !current) return;
      const { layer, xOf, top, bottom, scaleKey } = chart;
      let g = /** @type {SVGGElement|null} */ (layer.querySelector(':scope > g.cn-bands'));
      if (!g) {
        g = /** @type {SVGGElement} */ (document.createElementNS(SVG_NS, 'g'));
        g.setAttribute('class', 'cn-bands');
        g.setAttribute('pointer-events', 'none');
        // First in the chart's layer, so the elevation profile is drawn on top of the bands.
        layer.insertBefore(g, layer.firstChild);
      }
      const key = current.climbs.map((c) => `${c.startDist}:${c === activeClimb ? 'a' : c === hoverClimb ? 'h' : ''}`).join('|') + '@' + scaleKey;
      if (g.dataset.key === key) return;
      g.dataset.key = key;
      g.textContent = '';
      current.climbs.forEach((c, i) => {
        const x1 = xOf(c.startDist), x2 = xOf(c.endDist);
        const state = c === activeClimb ? 'active' : c === hoverClimb ? 'hover' : '';
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x1));
        rect.setAttribute('y', String(top));
        rect.setAttribute('width', String(Math.max(2, x2 - x1)));
        rect.setAttribute('height', String(Math.max(0, bottom - top)));
        rect.setAttribute('class', 'cn-band' + (state ? ' cn-band-' + state : ''));
        g.appendChild(rect);
        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('x', String((x1 + x2) / 2));
        label.setAttribute('y', String(top + 22));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('class', 'cn-band-label' + (state ? ' cn-band-label-' + state : ''));
        label.textContent = String(i + 1);
        g.appendChild(label);
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${i + 1}. ${displayName(c).name} — ${km(c.length)}, ${c.grade.toFixed(1)}%`;
        rect.appendChild(title);
      });
    } finally {
      drawing = false;
    }
  }

  // The chart re-renders (resize, zoom, navigation): redraw the bands when needed.
  /** @type {boolean} */
  let pending = false;
  new MutationObserver(() => {
    if (pending || drawing) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (current) drawBands();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
