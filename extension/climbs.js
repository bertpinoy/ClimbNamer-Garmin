// Climb detection for Garmin Connect courses.
// Loaded in the page world (inject.js) and the extension world (content.js).
//
// Garmin Connect course pages don't list climbs, so ClimbNamer detects them from the
// course's elevation profile (geoPoints: latitude, longitude, elevation, distance),
// with criteria similar to Garmin's ClimbPro:
//   - at least MIN_LENGTH m long and MIN_GRADE % average gradient,
//   - "climb score" length (m) × average grade (%) ≥ MIN_SCORE,
//   - small dips (less than HYSTERESIS m) don't split a climb.
// If Garmin's own response ever includes climbs, those are used instead.
(() => {
  if (self.HHClimbs) return;

  const STEP = 20;          // resample the profile every 20 m
  const SMOOTH = 100;       // smoothing window (m) against elevation noise
  const HYSTERESIS = 10;    // m of ascent to start a climb, minimum descent to end one
  const HYSTERESIS_REL = 0.25; // …and the descent must be ≥ 25% of the height gained so far
  const RUN_GRADE = 2;      // % — the climb starts where the slope (over 200 m) stays ≥ this
  const MIN_PART_RISE = 5;  // m — pieces that rise less are ignored
  const MERGE_GAP = 300;    // m — climbing pieces closer than this, without a real dip, are one climb
  const MIN_LENGTH = 300;   // m
  const MIN_GRADE = 3;      // %
  const MIN_SCORE = 1500;   // length (m) × grade (%), e.g. 500 m at 3%

  /**
   * Distance in metres between two [lat, lon] points.
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number}
   */
  function hav(a, b) {
    const R = 6371000, r = (d) => (d * Math.PI) / 180;
    const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 +
      Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /**
   * Keeps at most `max` evenly spread items.
   * @template T
   * @param {T[]} points
   * @param {number} max
   * @returns {T[]}
   */
  function thin(points, max) {
    if (points.length <= max) return points;
    const out = [];
    for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
    return out;
  }

  /** geoPoints → [{ d, lat, lon, ele }] with a distance for every point. */
  function profileFrom(geoPoints) {
    const pts = [];
    let d = 0;
    for (let i = 0; i < geoPoints.length; i++) {
      const g = geoPoints[i];
      if (g == null || g.latitude == null || g.longitude == null || g.elevation == null) continue;
      const prev = pts[pts.length - 1];
      if (typeof g.distance === 'number' && (!prev || g.distance >= prev.d)) d = g.distance;
      else if (prev) d = prev.d + hav([prev.lat, prev.lon], [g.latitude, g.longitude]);
      pts.push({ d, lat: g.latitude, lon: g.longitude, ele: g.elevation });
    }
    return pts;
  }

  /** Resample to a fixed step and smooth the elevation. */
  function resample(pts) {
    if (pts.length < 2) return [];
    const out = [];
    let j = 0;
    for (let d = 0; d <= pts[pts.length - 1].d; d += STEP) {
      while (j < pts.length - 2 && pts[j + 1].d < d) j++;
      const a = pts[j], b = pts[j + 1];
      const t = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
      out.push({ d, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, ele: a.ele + (b.ele - a.ele) * t });
    }
    const half = Math.round(SMOOTH / STEP / 2);
    const prefix = [0];
    out.forEach((p, i) => prefix.push(prefix[i] + p.ele));
    out.forEach((p, i) => {
      const lo = Math.max(0, i - half), hi = Math.min(out.length - 1, i + half);
      p.sm = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    });
    return out;
  }

  /** Valley → peak segments, with hysteresis. Returns [[iStart, iEnd], …]. */
  function risingSegments(p) {
    const segs = [];
    let lowI = 0, highI = 0, climbing = false;
    for (let i = 1; i < p.length; i++) {
      if (!climbing) {
        if (p[i].sm < p[lowI].sm) lowI = i;
        else if (p[i].sm - p[lowI].sm >= HYSTERESIS) { climbing = true; highI = i; }
      } else if (p[i].sm > p[highI].sm) {
        highI = i;
      } else {
        const gained = p[highI].sm - p[lowI].sm;
        if (p[highI].sm - p[i].sm >= Math.max(HYSTERESIS, HYSTERESIS_REL * gained)) {
          segs.push([lowI, highI]);
          climbing = false;
          lowI = i;
        }
      }
    }
    if (climbing) segs.push([lowI, highI]);
    return segs;
  }

  /**
   * Within a valley → peak segment: the climb is the steady part that ends at the top
   * (walking back while the slope over 200 m stays ≥ RUN_GRADE). What lies before it
   * is examined the same way, so a long gentle run-in doesn't dilute the climb.
   */
  function extract(p, a, b, out) {
    if (b - a < 2) return;
    let e = a;
    for (let i = a; i <= b; i++) if (p[i].sm > p[e].sm) e = i;
    if (p[e].sm - p[a].sm < MIN_PART_RISE) return;
    const w = Math.round(200 / STEP);
    let s = e;
    while (s - w >= a && ((p[s].sm - p[s - w].sm) / (p[s].d - p[s - w].d)) * 100 >= RUN_GRADE) s--;
    let low = s;
    for (let i = s; i >= Math.max(a, s - w); i--) if (p[i].sm < p[low].sm) low = i;
    s = low;
    if (e > s && p[e].sm - p[s].sm >= MIN_PART_RISE) out.push([s, e]);
    extract(p, a, s, out);
  }

  // Climbing pieces close together without a real dip in between form one climb,
  // as long as the combined climb is still steep enough (a gentle run-in must not
  // dilute a real climb below MIN_GRADE).
  /**
   * @param {Array<{ d: number, sm: number }>} p resampled profile
   * @param {number[][]} parts [startIndex, endIndex] pairs
   * @returns {number[][]} merged [startIndex, endIndex] pairs
   */
  function merge(p, parts) {
    parts.sort((x, y) => x[0] - y[0]);
    /** @param {number} s @param {number} e @returns {number} average grade (%) between two indexes */
    const grade = (s, e) => ((p[e].sm - p[s].sm) / Math.max(1, p[e].d - p[s].d)) * 100;
    const out = [];
    for (const cur of parts) {
      const prev = out[out.length - 1];
      if (prev && p[cur[0]].d - p[prev[1]].d <= MERGE_GAP) {
        let low = Infinity;
        for (let i = prev[1]; i <= cur[0]; i++) low = Math.min(low, p[i].sm);
        const end = Math.max(prev[1], cur[1]);
        if (p[prev[1]].sm - low < HYSTERESIS && grade(prev[0], end) >= MIN_GRADE) {
          prev[1] = end;
          continue;
        }
      }
      out.push([...cur]);
    }
    return out;
  }

  /**
   * Climb object for profile indexes s..e.
   * @param {Array<{ d: number, lat: number, lon: number, ele: number, sm: number }>} p
   * @param {number} s
   * @param {number} e
   * @returns {object|null}
   */
  function buildClimb(p, s, e) {
    const seg = p.slice(s, e + 1);
    if (seg.length < 2) return null;
    let top = seg[0], gain = 0;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i].sm > top.sm) top = seg[i];
      if (i && seg[i].ele > seg[i - 1].ele) gain += seg[i].ele - seg[i - 1].ele;
    }
    const length = seg[seg.length - 1].d - seg[0].d;
    const rise = top.sm - seg[0].sm;
    return {
      startDist: seg[0].d, endDist: seg[seg.length - 1].d, length,
      gain: Math.round(Math.max(gain, rise)),
      grade: length > 0 ? (rise / length) * 100 : 0,
      maxEle: top.ele, minEle: Math.min(...seg.map((x) => x.ele)),
      start: [seg[0].lat, seg[0].lon],
      top: [top.lat, top.lon],
      points: thin(seg, 80).map((x) => [x.lat, x.lon, x.ele]),
    };
  }

  /**
   * Detects the climbs of a course from its elevation profile.
   * @param {Array<{ latitude: number, longitude: number, elevation: number, distance?: number }>} geoPoints
   * @returns {{ totalDist: number, climbs: object[] }}
   */
  function detectClimbs(geoPoints) {
    const p = resample(profileFrom(geoPoints));
    if (p.length < 3) return { totalDist: 0, climbs: [] };
    const parts = [];
    for (const [a, b] of risingSegments(p)) extract(p, a, b, parts);
    const climbs = merge(p, parts)
      .map(([s, e]) => buildClimb(p, s, e))
      .filter((c) => c && c.length >= MIN_LENGTH && c.grade >= MIN_GRADE && c.length * c.grade >= MIN_SCORE);
    return { totalDist: p[p.length - 1].d, climbs };
  }

  /** Climbs listed by Garmin itself (if a course response ever includes them). */
  function fromGarminClimbs(list, geoPoints) {
    const p = resample(profileFrom(geoPoints));
    if (!Array.isArray(list) || !list.length || p.length < 3) return null;
    /** @param {number} d metres @returns {number} profile index */
    const idx = (d) => Math.max(0, Math.min(p.length - 1, Math.round(d / STEP)));
    const climbs = list
      .map((c) => {
        const s = c.startDistance ?? c.startDistanceInMeters ?? c.distanceIntoCourse ?? c.start;
        const e = c.endDistance ?? c.endDistanceInMeters ?? (s != null && c.length != null ? s + c.length : null);
        if (typeof s !== 'number' || typeof e !== 'number' || e <= s) return null;
        return buildClimb(p, idx(s), idx(e));
      })
      .filter(Boolean)
      .sort((a, b) => a.startDist - b.startDist);
    return climbs.length ? { totalDist: p[p.length - 1].d, climbs } : null;
  }

  /** Response of GET /gc-api/course-service/course/{id} (+ optional onroute-features). */
  function fromCourse(course, features) {
    const geo = course && course.geoPoints;
    if (!Array.isArray(geo) || geo.length < 2) return null;
    const garmin = features && (features.climbs || features.climbSections);
    const r = (garmin && fromGarminClimbs(garmin, geo)) || detectClimbs(geo);
    return { kind: 'course', totalDist: r.totalDist, climbs: r.climbs };
  }

  self.HHClimbs = { fromCourse, detectClimbs };
})();
