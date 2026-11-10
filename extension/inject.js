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

  // ---------- zoom Garmin's map to a climb ----------
  // Garmin Connect's course map is a Leaflet map rendered by React. It isn't exposed
  // on window, so it's found through the React tree of the map container.

  /** @type {any} the climb highlight drawn on the map (a Leaflet layer group) */
  let highlight = null;
  /** @type {string} map pane above Garmin's course line panes (z 430–450), below markers (610) */
  const PANE = 'climbNamerPane';

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
   * Draws a climb on the map and zooms to it; with no points, removes the highlight.
   * @param {number[][]|null} points [lat, lon, …] along the climb
   * @returns {void}
   */
  function showOnMap(points) {
    const map = findMap();
    if (highlight) {
      try { highlight.remove(); } catch (e) {}
      highlight = null;
    }
    if (!map || !points || points.length < 2) return;
    const latlngs = points.map((p) => [p[0], p[1]]);
    const L = /** @type {any} */ (window).L;
    if (L && typeof L.polyline === 'function' && typeof L.layerGroup === 'function') {
      if (!map.getPane(PANE)) {
        const pane = map.createPane(PANE);
        pane.style.zIndex = '455';
        pane.style.pointerEvents = 'none';
      }
      /** @type {object} */
      const common = { pane: PANE, interactive: false, lineCap: 'round', lineJoin: 'round' };
      highlight = L.layerGroup([
        L.polyline(latlngs, { ...common, color: '#0c1220', weight: 10, opacity: 0.55 }), // dark outline
        L.polyline(latlngs, { ...common, color: '#ff6b1a', weight: 6, opacity: 1 }),
      ]).addTo(map);
    }
    map.flyToBounds(latlngs, { padding: [60, 60], maxZoom: 16, duration: 0.8 });
  }

  // Requests from the content script (the ClimbNamer panel).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__climbNamerGarmin || ev.data.type !== 'showClimb') return;
    try {
      showOnMap(ev.data.points || null);
    } catch (e) {
      console.warn('[ClimbNamer] could not zoom the map', e);
    }
  });

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
