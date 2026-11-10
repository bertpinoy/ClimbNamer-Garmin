// Isolated-world content script: receives detected climbs from inject.js, asks the
// background worker for names, shows them in the ClimbNamer panel and as bands on
// Garmin Connect's elevation chart.
(() => {
  /**
   * @typedef {{ name: string, detail: string, source: string }} ClimbName
   * @typedef {{
   *   startDist: number, endDist: number, length: number, gain: number, grade: number,
   *   maxEle: number, minEle: number, start: number[], top: number[], points: number[][],
   *   auto?: ClimbName, error?: string
   * }} Climb
   * @typedef {{ courseId: string, name: string, totalDist: number, climbs: Climb[] }} CourseEntry
   * @typedef {{ start: number[], top: number[], name: string }} Override
   */

  /** @type {Map<string, CourseEntry>} courseId -> detected climbs */
  const byCourse = new Map();
  /** @type {CourseEntry|null} entry for the course that is open now */
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
   * Course ID of the open page (/app/course/123 or /modern/course/123), or null.
   * @returns {string|null}
   */
  function courseIdFromUrl() {
    const m = location.pathname.match(/\/course\/(\d+)/);
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
    if (ev.source !== window || !ev.data || !ev.data.__climbNamerGarmin || ev.data.type !== 'climbs') return;
    const p = ev.data.payload;
    /** @type {CourseEntry} */
    const entry = { courseId: p.courseId, name: p.name, totalDist: p.totalDist, climbs: p.climbs };
    // Keep names already found when the same course loads again.
    const prev = byCourse.get(p.courseId);
    if (prev) entry.climbs.forEach((c, i) => { const o = prev.climbs[i]; if (o && o.startDist === c.startDist && o.auto) c.auto = o.auto; });
    byCourse.set(p.courseId, entry);
    current = null;
    syncCurrent();
    requestNames(entry);
  });

  /**
   * Looks up names for the climbs of a course that don't have one yet.
   * @param {CourseEntry} entry
   * @returns {void}
   */
  function requestNames(entry) {
    const todo = entry.climbs.filter((c) => !c.auto);
    if (!todo.length) return;
    todo.forEach((c) => delete c.error);
    render();
    chrome.runtime.sendMessage(
      { type: 'nameClimbs', climbs: todo.map((c) => ({ start: c.start, top: c.top, maxEle: c.maxEle, points: c.points })) },
      (res) => {
        const fail = chrome.runtime.lastError?.message || (!res ? 'no response' : !res.ok ? res.error : null);
        todo.forEach((c, i) => {
          const r = fail ? { error: fail } : res.names[i];
          if (r && r.error) c.error = r.error;
          else c.auto = r;
        });
        render();
      }
    );
  }

  /**
   * Follows in-app navigation: shows the entry of the course that is open.
   * @returns {void}
   */
  function syncCurrent() {
    const id = courseIdFromUrl();
    const next = (id && byCourse.get(id)) || null;
    if (next !== current) {
      if (activeClimb) showOnMap(null);
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
      return `<li class="hhcn-row hhcn-${d.source}${c === activeClimb ? ' hhcn-active' : ''}" data-hhcn="open" data-i="${i}" title="Show this climb on the map and the elevation chart">
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
   * Highlights a climb on the chart and scrolls the chart into view.
   * @param {Climb} c
   * @returns {void}
   */
  function showClimb(c) {
    activeClimb = activeClimb === c ? null : c;
    renderPanel();
    drawBands();
    showOnMap(activeClimb);
    const svg = findChart()?.svg;
    if (svg && activeClimb) svg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * Asks the page script (inject.js) to zoom Garmin's map to a climb and draw it,
   * or to remove the highlight when c is null.
   * @param {Climb|null} c
   * @returns {void}
   */
  function showOnMap(c) {
    window.postMessage(
      { __climbNamerGarmin: true, type: 'showClimb', points: c ? c.points.map((p) => [p[0], p[1]]) : null },
      location.origin
    );
  }

  // ---------- bands on Garmin's elevation chart ----------
  /**
   * @typedef {{ svg: SVGSVGElement, x0: number, px0: number, perUnit: number, unitM: number, top: number, bottom: number }} Chart
   */

  /**
   * Position (svg x) and value of each x-axis tick. Garmin draws its own tick labels
   * inside transformed groups, so the tick line's x1 is used; the label's on-screen
   * centre is the fallback.
   * @param {SVGSVGElement} svg
   * @returns {Array<{ v: number, x: number }>}
   */
  function xTicks(svg) {
    const ctm = svg.getScreenCTM();
    const inv = ctm ? ctm.inverse() : null;
    return [...svg.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick')]
      .map((tick) => {
        const text = tick.querySelector('text');
        const v = parseFloat(((text && text.textContent) || '').replace(',', '.'));
        const line = tick.querySelector('line');
        /** @type {number} */
        let x = line ? parseFloat(line.getAttribute('x1') || '') : NaN;
        if (isNaN(x) && text && inv) {
          const r = text.getBoundingClientRect();
          x = new DOMPoint(r.left + r.width / 2, r.top).matrixTransform(inv).x;
        }
        return { v, x };
      })
      .filter((t) => !isNaN(t.v) && !isNaN(t.x));
  }

  /**
   * Finds Garmin's elevation chart (Recharts SVG) and its distance scale from the
   * x-axis ticks. Labels have no unit; km or miles is decided by comparing the last
   * tick with the course length.
   * @returns {Chart|null}
   */
  function findChart() {
    if (!current) return null;
    const svgs = /** @type {SVGSVGElement[]} */ ([...document.querySelectorAll('svg.recharts-surface')]);
    for (const svg of svgs) {
      if (!svg.querySelector('.recharts-area')) continue;
      const ticks = xTicks(svg);
      if (ticks.length < 2) continue;
      const a = ticks[0], b = ticks[ticks.length - 1];
      if (b.v <= a.v) continue;
      const totalKm = current.totalDist / 1000, totalMi = current.totalDist / 1609.344;
      const unitM = Math.abs(b.v - totalMi) < Math.abs(b.v - totalKm) ? 1609.344 : 1000;
      const grid = /** @type {SVGGraphicsElement|null} */ (svg.querySelector('.recharts-cartesian-grid'));
      const axis = /** @type {SVGGraphicsElement|null} */ (svg.querySelector('.recharts-xAxis .recharts-cartesian-axis-line'));
      const gb = grid ? grid.getBBox() : null;
      const top = gb ? gb.y : 0;
      const bottom = axis ? axis.getBBox().y : gb ? gb.y + gb.height : svg.getBBox().height;
      return { svg, x0: a.v, px0: a.x, perUnit: (b.x - a.x) / (b.v - a.v), unitM, top, bottom };
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
      const { svg, x0, px0, perUnit, unitM, top, bottom } = chart;
      /** @param {number} m @returns {number} */
      const xOf = (m) => px0 + (m / unitM - x0) * perUnit;
      let g = /** @type {SVGGElement|null} */ (svg.querySelector('g.cn-bands'));
      if (!g) {
        g = /** @type {SVGGElement} */ (document.createElementNS(SVG_NS, 'g'));
        g.setAttribute('class', 'cn-bands');
        g.setAttribute('pointer-events', 'none');
        // Behind the elevation area, so the profile stays visible on top:
        // insert before the svg's direct child that contains the area.
        /** @type {Node|null} */
        let before = svg.querySelector('.recharts-area');
        while (before && before.parentNode !== svg) before = before.parentNode;
        svg.insertBefore(g, before);
      }
      const key = current.climbs.map((c) => `${c.startDist}:${c === activeClimb ? 'a' : c === hoverClimb ? 'h' : ''}`).join('|') + `@${xOf(0).toFixed(1)},${perUnit.toFixed(3)},${top},${bottom}`;
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
        label.setAttribute('y', String(top + 12));
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
