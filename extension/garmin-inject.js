// Runs in the page's own JS world (MAIN), after climbs.js. Observes the course data
// Garmin Connect itself loads and forwards the detected climbs to the content script.
// It never changes requests or responses.
(() => {
  if (window.__cnGarminHooked) return;
  window.__cnGarminHooked = true;

  const COURSE = /\/course-service\/course\/(\d+)(?:\?|$)/;
  const FEATURES = /\/course-service\/course\/(\d+)\/onroute-features/;
  /** @type {Map<string, any>} courseId -> course JSON */
  const courses = new Map();
  /** @type {Map<string, any>} courseId -> onroute-features JSON */
  const features = new Map();

  /**
   * Detects the climbs of a course and sends them to the content script.
   * @param {string} id course ID
   * @returns {void}
   */
  function publish(id) {
    const course = courses.get(id);
    if (!course) return;
    try {
      const r = self.HHClimbs.fromCourse(course, features.get(id));
      if (!r) return;
      window.postMessage(
        { __climbNamerGarmin: true, type: 'climbs', payload: { ...r, courseId: id, name: course.courseName || '' } },
        location.origin
      );
    } catch (e) {
      console.warn('[ClimbNamer]', e);
    }
  }

  /**
   * @param {string} url request URL
   * @param {any} json response body
   * @returns {void}
   */
  function handle(url, json) {
    /** @type {RegExpMatchArray|null} */
    let m;
    if ((m = url.match(FEATURES))) {
      features.set(m[1], json);
      if (courses.has(m[1]) && json && (json.climbs || json.climbSections)) publish(m[1]);
    } else if ((m = url.match(COURSE)) && json && Array.isArray(json.geoPoints)) {
      courses.set(m[1], json);
      publish(m[1]);
    }
  }

  /** @param {string} url @returns {boolean} */
  const watched = (url) => COURSE.test(url) || FEATURES.test(url);

  // ---------- climbs on Garmin's map ----------
  // Garmin Connect's course map is a Leaflet map rendered by React. It isn't exposed
  // on window, so it's found through the React tree of the map container.

  /** @type {string} map pane for the climb lines: above Garmin's course line panes (z 430–450) */
  const PANE = 'climbNamerPane';
  /** @type {string} map pane for the numbered badges: above the lines, below Garmin's markers (610) */
  const BADGE_PANE = 'climbNamerBadgePane';

  /**
   * @typedef {{ climbs: Array<{ points: number[][] }>|null, active: number, zoom: boolean }} MapRequest
   */

  /** @type {MapRequest|null} the latest request from the panel, redrawn when the map is rebuilt */
  let request = null;
  /** @type {any} the Leaflet layer group with the climbs */
  let layer = null;
  /** @type {any} the map the layer was drawn on */
  let drawnOn = null;

  /**
   * @param {any} x
   * @returns {boolean} true when x looks like a Leaflet map
   */
  const isLeafletMap = (x) => !!x && typeof x === 'object' && typeof x.flyToBounds === 'function' && typeof x.getContainer === 'function';

  /**
   * Finds the Leaflet map of the course page, or null.
   * @returns {any}
   */
  function findMap() {
    const container = document.querySelector('.leaflet-container');
    if (!container) return null;
    const fiberKey = Object.keys(container).find((k) => k.startsWith('__reactFiber$'));
    /** @type {any} */
    let fiber = fiberKey ? /** @type {any} */ (container)[fiberKey] : null;
    for (let i = 0; fiber && i < 80; i++, fiber = fiber.return) {
      for (const o of [fiber.memoizedProps, fiber.stateNode]) {
        if (!o || typeof o !== 'object') continue;
        for (const v of Object.values(o)) {
          if (isLeafletMap(v)) return v;
          if (v && typeof v === 'object' && isLeafletMap(/** @type {any} */ (v).current)) return /** @type {any} */ (v).current;
        }
      }
      /** @type {any} */
      let hook = fiber.memoizedState;
      for (let j = 0; hook && typeof hook === 'object' && j < 40; j++, hook = hook.next) {
        const s = hook.memoizedState;
        for (const x of [s, s && s.current, s && s.map]) if (isLeafletMap(x)) return x;
      }
    }
    return null;
  }

  /**
   * Creates a map pane once.
   * @param {any} map
   * @param {string} name
   * @param {string} zIndex
   * @returns {void}
   */
  function ensurePane(map, name, zIndex) {
    if (map.getPane(name)) return;
    const pane = map.createPane(name);
    pane.style.zIndex = zIndex;
    pane.style.pointerEvents = 'none';
  }

  /**
   * Removes the climbs from the map.
   * @returns {void}
   */
  function clearLayer() {
    if (layer) {
      try { layer.remove(); } catch (e) {}
    }
    layer = null;
    drawnOn = null;
  }

  /**
   * Draws all climbs of the course on Garmin's map (the active one stronger, on top)
   * and zooms to the active climb when asked.
   * @param {boolean} zoom
   * @returns {void}
   */
  function draw(zoom) {
    clearLayer();
    const map = findMap();
    const L = /** @type {any} */ (window).L;
    if (!map || !request || !request.climbs || !request.climbs.length || !L || typeof L.polyline !== 'function') return;
    ensurePane(map, PANE, '455');
    ensurePane(map, BADGE_PANE, '456');
    /** @type {object} */
    const line = { pane: PANE, interactive: false, lineCap: 'round', lineJoin: 'round' };
    /** @type {any[]} */
    const layers = [];
    // Inactive climbs first, the active one last so it's drawn on top.
    const order = request.climbs.map((_, i) => i).sort((a, b) => (a === request.active ? 1 : 0) - (b === request.active ? 1 : 0));
    for (const i of order) {
      const pts = request.climbs[i].points;
      if (!pts || pts.length < 2) continue;
      const active = i === request.active;
      const latlngs = pts.map((p) => [p[0], p[1]]);
      layers.push(L.polyline(latlngs, { ...line, color: '#0c1220', weight: active ? 11 : 8, opacity: active ? 0.6 : 0.35 }));
      layers.push(L.polyline(latlngs, { ...line, color: '#ff6b1a', weight: active ? 7 : 5, opacity: active ? 1 : 0.85 }));
      // Numbered badge at the top of the climb (highest point), like the panel and chart.
      let top = pts[pts.length - 1];
      for (const p of pts) if (p.length > 2 && top.length > 2 && p[2] > top[2]) top = p;
      if (typeof L.marker === 'function' && typeof L.divIcon === 'function') {
        layers.push(L.marker([top[0], top[1]], {
          pane: BADGE_PANE,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: 'cn-map-badge' + (active ? ' cn-map-badge-active' : ''), html: '<span>' + (i + 1) + '</span>', iconSize: active ? [24, 24] : [20, 20] }),
        }));
      }
    }
    layer = L.layerGroup(layers).addTo(map);
    drawnOn = map;
    const a = request.active >= 0 ? request.climbs[request.active] : null;
    if (zoom && a && a.points && a.points.length > 1) {
      map.flyToBounds(a.points.map((p) => [p[0], p[1]]), { padding: [60, 60], maxZoom: 16, duration: 0.8 });
    }
  }

  // Requests from the content script (the ClimbNamer panel).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__climbNamerGarmin || ev.data.type !== 'mapClimbs') return;
    request = ev.data.climbs ? { climbs: ev.data.climbs, active: ev.data.active ?? -1, zoom: !!ev.data.zoom } : null;
    try {
      if (request) draw(request.zoom);
      else clearLayer();
    } catch (e) {
      console.warn('[ClimbNamer] could not draw the climbs on the map', e);
    }
  });

  // Garmin builds the map after the course data arrives, and rebuilds it on navigation:
  // redraw (without zooming) when the map we drew on is gone or replaced.
  setInterval(() => {
    if (!request || !request.climbs) return;
    const map = findMap();
    if (map && (map !== drawnOn || !layer || !map.hasLayer(layer))) {
      try { draw(false); } catch (e) {}
    }
  }, 800);

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    const p = origFetch.apply(this, arguments);
    if (watched(url)) {
      p.then((res) => {
        if (res.ok) res.clone().json().then((j) => handle(url, j)).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cnUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = this.__cnUrl || '';
    if (watched(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          handle(url, this.responseType === 'json' ? this.response : JSON.parse(this.responseText));
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
