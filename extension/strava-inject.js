// Runs in the page's own JS world (MAIN), after climbs.js. Reads the route data that
// Strava itself loads for a route page and forwards the detected climbs to the content
// script. It never changes requests or responses.
//
// Where Strava's route data comes from:
//  - a full page load: the page embeds it in <script id="__NEXT_DATA__"> (props.pageProps.route);
//  - in-app navigation: Next.js fetches /_next/data/<build>/…/routes/<id>.json;
//  - otherwise (fallback): the route page itself is read once more and its __NEXT_DATA__ used.
(() => {
  if (/** @type {any} */ (window).__cnStravaHooked) return;
  /** @type {any} */ (window).__cnStravaHooked = true;

  /** @type {RegExp} Next.js data request for a route page */
  const NEXT_DATA = /\/_next\/data\/[^?]*\/routes\/(\d+)\.json/;
  /** @type {Set<string>} route IDs already published for the current page */
  const published = new Set();

  /**
   * Route ID of the open page (/routes/123), or null.
   * @returns {string|null}
   */
  function routeIdFromUrl() {
    const m = location.pathname.match(/\/routes\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * Detects the climbs of a route and sends them to the content script.
   * @param {string} id route ID
   * @param {any} route pageProps.route
   * @returns {void}
   */
  function publish(id, route) {
    try {
      const r = /** @type {any} */ (self).HHClimbs.fromRoute(route);
      if (!r) return;
      published.add(id);
      window.postMessage(
        { __climbNamerStrava: true, type: 'climbs', payload: { ...r, routeId: id, name: route.title || '' } },
        location.origin
      );
    } catch (e) {
      console.warn('[ClimbNamer]', e);
    }
  }

  /**
   * Publishes the route found in Next.js page data, if it belongs to a route page.
   * @param {any} nextData parsed __NEXT_DATA__ (or a /_next/data response)
   * @param {string|null} id route ID, if known
   * @returns {boolean} true when a route was found
   */
  function fromNextData(nextData, id) {
    const props = nextData && (nextData.props ? nextData.props.pageProps : nextData.pageProps);
    const route = props && props.route;
    if (!route || !Array.isArray(route.polyline)) return false;
    publish(String(id || route.id || routeIdFromUrl() || ''), route);
    return true;
  }

  /**
   * Reads the embedded __NEXT_DATA__ of a (parsed) HTML document.
   * @param {Document} doc
   * @param {string|null} id
   * @returns {boolean}
   */
  function fromDocument(doc, id) {
    const el = doc.getElementById('__NEXT_DATA__');
    if (!el || !el.textContent) return false;
    try {
      return fromNextData(JSON.parse(el.textContent), id);
    } catch (e) {
      return false;
    }
  }

  // Full page load: the data is in the page once the DOM is there.
  /** @returns {void} */
  const onReady = () => {
    const id = routeIdFromUrl();
    if (id) fromDocument(document, id);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();

  // In-app navigation: Next.js data requests.
  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && /** @type {any} */ (input).url) || String(input);
    const p = origFetch.apply(this, /** @type {any} */ (arguments));
    const m = url.match(NEXT_DATA);
    if (m) {
      p.then((res) => {
        if (res.ok) res.clone().json().then((j) => fromNextData(j, m[1])).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  // Fallback: a route page whose data didn't arrive by either way above (e.g. loaded by
  // a request type Strava adds later): read the route page once more and use its data.
  /** @type {string|null} */
  let lastPath = null;
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const id = routeIdFromUrl();
    if (!id) return;
    setTimeout(() => {
      if (published.has(id) || routeIdFromUrl() !== id) return;
      origFetch(location.href, { credentials: 'include' })
        .then((res) => (res.ok ? res.text() : ''))
        .then((html) => {
          if (html && !published.has(id)) fromDocument(new DOMParser().parseFromString(html, 'text/html'), id);
        })
        .catch(() => {});
    }, 2500);
  }, 700);
})();
