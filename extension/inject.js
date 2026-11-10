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
