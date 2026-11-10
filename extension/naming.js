// Climb naming with OpenStreetMap data.
// Loaded by the background service worker with importScripts().
//
// Per climb we look for, in order:
//   1. a named summit or pass (natural=peak/hill/saddle, mountain_pass=yes) near the top;
//   2. the road the climb mostly follows;
//   3. the nearest village/town ("Climb near …").
//
// Sources: Overpass API first (one query for all climbs of a route/ride, raced over a
// few public mirrors). If Overpass is busy, Nominatim is used (max 1 request/second,
// ~3 requests per climb). Both are free public services that are sometimes overloaded,
// so results are cached by background.js and failures can be retried from the panel.

// ---------------------------------------------------------------- geometry helpers
/**
 * Distance in metres between two [lat, lon] points.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function haversine(a, b) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 +
    Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Distance in metres from point p to the segment a-b.
 * @param {number[]} p
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function distToSegment(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * k, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy) * 111320;
}

/**
 * Bounding box (south, west, north, east) around points, plus a margin.
 * @param {number[][]} points [lat, lon, ...]
 * @param {number} marginDeg
 * @returns {string[]}
 */
function bbox(points, marginDeg) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const p of points) {
    s = Math.min(s, p[0]); n = Math.max(n, p[0]);
    w = Math.min(w, p[1]); e = Math.max(e, p[1]);
  }
  return [s - marginDeg, w - marginDeg, n + marginDeg, e + marginDeg].map((v) => v.toFixed(5));
}

/**
 * Points at the given fractions of a line's length.
 * @param {number[][]} points
 * @param {number[]} fractions 0..1
 * @returns {number[][]}
 */
function pointsAlong(points, fractions) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  return fractions.map((f) => {
    let i = cum.findIndex((c) => c >= f * total);
    return points[i < 0 ? points.length - 1 : i];
  });
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Nearest qualifying summit or pass to the top of a climb.
 * @param {number[]} top [lat, lon]
 * @param {Array<{ name: string, lat: number, lon: number, kind: string }>} candidates
 * @returns {{ name: string, lat: number, lon: number, kind: string, d: number }|null}
 */
function pickSummit(top, candidates) {
  // candidates: [{ name, lat, lon, kind: 'pass'|'peak'|'hill' }]
  const scored = candidates
    .map((c) => ({ ...c, d: haversine(top, [c.lat, c.lon]) }))
    .filter((c) => c.d <= (c.kind === 'pass' ? 350 : 600));
  const rank = { pass: 0, peak: 1, hill: 2 };
  scored.sort((a, b) => rank[a.kind] - rank[b.kind] || a.d - b.d);
  return scored[0] || null;
}

/**
 * Final name and detail from a summit, the roads followed and the nearest place.
 * @param {{ name: string }|null} summit
 * @param {string[]} roads
 * @param {string} place
 * @returns {{ name: string, detail: string, source: string }}
 */
function compose(summit, roads, place) {
  if (summit) {
    const via = roads.filter((r) => r !== summit.name).slice(0, 2);
    return { name: summit.name, detail: via.length ? 'via ' + via.join(' / ') : place || '', source: 'summit' };
  }
  if (roads.length) {
    const detail = [roads[1] ? 'then ' + roads[1] : '', place].filter(Boolean).join(' · ');
    return { name: roads[0], detail, source: 'road' };
  }
  if (place) return { name: 'Climb near ' + place, detail: '', source: 'place' };
  return { name: 'Unnamed climb', detail: '', source: 'none' };
}

// ---------------------------------------------------------------- Overpass
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const SKIP_HIGHWAYS = 'footway|steps|corridor|elevator|platform|proposed|construction|bus_stop';

// Fair use: ask the mirrors one after another (next one only if the previous hasn't
// answered within MIRROR_STAGGER_MS or failed), not all at once.
const MIRROR_STAGGER_MS = 4000;

/**
 * Runs an Overpass query on the mirrors, one after another (see MIRROR_STAGGER_MS).
 * @param {string} query
 * @param {number} timeoutMs
 * @param {{ onCancel: Function }} [cancel]
 * @returns {Promise<any>}
 */
async function overpass(query, timeoutMs, cancel) {
  const controllers = OVERPASS_ENDPOINTS.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach((c) => c.abort()), timeoutMs);
  cancel?.onCancel(() => controllers.forEach((c) => c.abort()));
  // failed[i] resolves when mirror i has failed.
  const failed = OVERPASS_ENDPOINTS.map(() => {
    let done;
    const p = new Promise((r) => (done = r));
    return { p, done };
  });
  try {
    return await Promise.any(
      OVERPASS_ENDPOINTS.map(async (url, i) => {
        try {
          // Start after the stagger delay, or as soon as all earlier mirrors failed.
          if (i > 0) {
            await Promise.race([sleep(i * MIRROR_STAGGER_MS), Promise.all(failed.slice(0, i).map((f) => f.p))]);
            if (controllers[i].signal.aborted) throw new Error('aborted');
          }
          const res = await fetch(url, {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: controllers[i].signal,
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const json = await res.json();
          controllers.forEach((c, j) => j !== i && c.abort());
          return json;
        } catch (e) {
          failed[i].done();
          throw e;
        }
      })
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names climbs with one Overpass query.
 * @param {Array<{ points: number[][], top: number[] }>} climbs
 * @param {{ onCancel: Function }} [cancel]
 * @returns {Promise<Array<{ name: string, detail: string, source: string }>>}
 */
async function nameWithOverpass(climbs, cancel) {
  const parts = [];
  for (const c of climbs) {
    parts.push(`way[highway][name][highway!~"^(${SKIP_HIGHWAYS})$"](${bbox(c.points, 0.0008)});`);
    parts.push(`node[name][natural~"^(peak|hill|saddle)$"](${bbox([c.top], 0.007)});`);
    parts.push(`node[name][mountain_pass=yes](${bbox([c.top], 0.005)});`);
    parts.push(`node[name][place~"^(village|town|hamlet|suburb|city)$"](${bbox([c.top], 0.04)});`);
  }
  const data = await overpass(`[out:json][timeout:50];(\n${parts.join('\n')}\n);out tags geom;`, 60000, cancel);
  const els = data.elements || [];
  const nodes = els.filter((e) => e.type === 'node' && e.tags);
  const ways = els.filter((e) => e.type === 'way' && e.geometry && e.tags && e.tags.name);

  return climbs.map((climb) => {
    const top = climb.top;
    const summit = pickSummit(
      top,
      nodes
        .filter((e) => e.tags.natural || e.tags.mountain_pass)
        .map((e) => ({
          name: e.tags.name, lat: e.lat, lon: e.lon,
          kind: e.tags.mountain_pass === 'yes' || e.tags.natural === 'saddle' ? 'pass' : e.tags.natural === 'hill' ? 'hill' : 'peak',
        }))
    );

    const pts = climb.points;
    const tally = new Map();
    for (let i = 1; i < pts.length; i++) {
      const mid = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
      let best = null, bestD = 35;
      for (const w of ways) {
        const g = w.geometry;
        for (let j = 1; j < g.length; j++) {
          if (!g[j - 1] || !g[j]) continue;
          const d = distToSegment(mid, [g[j - 1].lat, g[j - 1].lon], [g[j].lat, g[j].lon]);
          if (d < bestD) { bestD = d; best = w; }
        }
      }
      if (best) tally.set(best.tags.name, (tally.get(best.tags.name) || 0) + haversine(pts[i - 1], pts[i]));
    }
    const total = [...tally.values()].reduce((s, v) => s + v, 0) || 1;
    const roads = [...tally.entries()].filter((r) => r[1] / total >= 0.2).sort((a, b) => b[1] - a[1]).map((r) => r[0]);

    const place = nodes
      .filter((e) => e.tags.place)
      .map((e) => ({ name: e.tags.name, d: haversine(top, [e.lat, e.lon]) }))
      .sort((a, b) => a.d - b.d)[0];

    return compose(summit, roads, place ? place.name : '');
  });
}

// ---------------------------------------------------------------- Nominatim
const NOMINATIM = 'https://nominatim.openstreetmap.org';
let nomLastAt = 0;
// One request at a time. Jobs for the page you have open go before background
// (prefetch) jobs; a background job is promoted when its lookup becomes urgent
// (cancel.low turns false).
const nomJobs = [];
let nomBusy = false;

/**
 * Queues a Nominatim request (max 1 per second; open page before background).
 * @param {string} path
 * @param {{ cancelled: boolean, low: boolean }} [cancel]
 * @returns {Promise<any>}
 */
function nominatim(path, cancel) {
  return new Promise((resolve, reject) => {
    nomJobs.push({ path, cancel, resolve, reject });
    pumpNominatim();
  });
}

/**
 * Runs queued Nominatim jobs one at a time.
 * @returns {Promise<void>}
 */
async function pumpNominatim() {
  if (nomBusy) return;
  nomBusy = true;
  try {
    while (nomJobs.length) {
      // Wait for the rate-limit gap *before* choosing, so a lookup for the open page
      // can queue its next request in time and isn't overtaken by background jobs.
      const wait = nomLastAt + 1100 - Date.now();
      await sleep(Math.max(wait, 0));
      let i = nomJobs.findIndex((j) => !j.cancel?.low);
      if (i < 0) i = 0;
      const job = nomJobs.splice(i, 1)[0];
      try {
        job.resolve(await nominatimRun(job.path, job.cancel));
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    nomBusy = false;
  }
}

/**
 * One Nominatim request, with retries when the service is busy.
 * @param {string} path
 * @param {{ cancelled: boolean }} [cancel]
 * @returns {Promise<any>}
 */
async function nominatimRun(path, cancel) {
  {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancel?.cancelled) throw new Error('cancelled');
      const wait = nomLastAt + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      if (cancel?.cancelled) throw new Error('cancelled');
      nomLastAt = Date.now();
      try {
        const res = await fetch(NOMINATIM + path);
        if (res.ok) return await res.json();
        if (res.status !== 429 && res.status < 500) throw Object.assign(new Error('HTTP ' + res.status), { fatal: true });
      } catch (e) {
        // A 429 comes without CORS headers and surfaces as a network error.
        if (e.fatal) throw e;
      }
      await sleep(5000 * (attempt + 1));
    }
    throw new Error('Nominatim is busy');
  }
}

/**
 * Nominatim search for features of a kind around a point.
 * @param {string} phrase special phrase such as [natural=peak]
 * @param {number[]} top
 * @param {number} radiusDeg
 * @param {string} kind
 * @param {{ cancelled: boolean }} [cancel]
 * @returns {Promise<Array<{ name: string, lat: number, lon: number, kind: string }>>}
 */
async function nomSearch(phrase, top, radiusDeg, kind, cancel) {
  const [lat, lon] = top;
  const vb = [lon - radiusDeg, lat + radiusDeg, lon + radiusDeg, lat - radiusDeg].map((v) => v.toFixed(5)).join(',');
  const list = await nominatim(`/search?format=jsonv2&q=${encodeURIComponent(phrase)}&viewbox=${vb}&bounded=1&limit=10`, cancel);
  return (list || []).filter((x) => x.name).map((x) => ({ name: x.name, lat: +x.lat, lon: +x.lon, kind }));
}

/**
 * Names one climb with Nominatim (fallback when Overpass is busy).
 * @param {{ points: number[][], top: number[], maxEle?: number }} climb
 * @param {{ cancelled: boolean }} [cancel]
 * @returns {Promise<{ name: string, detail: string, source: string }>}
 */
async function nameWithNominatim(climb, cancel) {
  const top = climb.top;
  let candidates = [];
  if ((climb.maxEle ?? 0) >= 400) candidates = candidates.concat(await nomSearch('[mountain_pass=yes]', top, 0.005, 'pass', cancel));
  candidates = candidates.concat(await nomSearch('[natural=peak]', top, 0.007, 'peak', cancel));
  const summit = pickSummit(top, candidates);

  const tally = new Map();
  let place = '';
  for (const p of pointsAlong(climb.points, [0.3, 0.75])) {
    const r = await nominatim(`/reverse?format=jsonv2&lat=${p[0].toFixed(6)}&lon=${p[1].toFixed(6)}&zoom=17&layer=address&addressdetails=1`, cancel);
    const a = (r && r.address) || {};
    const road = r && r.category === 'highway' && r.name ? r.name : a.road || '';
    if (road) tally.set(road, (tally.get(road) || 0) + 1);
    place = place || a.village || a.town || a.hamlet || a.suburb || a.city || a.municipality || '';
  }
  const roads = [...tally.entries()].sort((a, b) => b[1] - a[1]).map((r) => r[0]);
  return compose(summit, roads, place);
}

// ---------------------------------------------------------------- entry point
/** climbs: [{ points:[[lat,lng,ele],...], top:[lat,lng], maxEle }] → [{name, detail, source} | {error}] */
// Overpass gets a head start; if it hasn't answered after this long (or fails
// sooner), Nominatim starts too, and whichever completes first wins.
// Background (prefetch) lookups use Overpass only, so Nominatim — the more
// restrictive service — is only used for the route or ride you actually open.
const FALLBACK_AFTER_MS = 5000;
const BUSY = { error: 'OpenStreetMap services are busy — retry later' };

/**
 * Cancellation token that also carries the priority.
 * @param {{ low: boolean }} [prio]
 * @returns {{ cancelled: boolean, low: boolean, onCancel: Function, cancel: Function }}
 */
function makeCancel(prio) {
  const fns = [];
  return {
    cancelled: false,
    get low() { return !!prio?.low; },
    onCancel(f) { fns.push(f); if (this.cancelled) f(); },
    cancel() { if (this.cancelled) return; this.cancelled = true; fns.forEach((f) => f()); },
  };
}

/** prio: { low: boolean } — low for background prefetch. */
async function nameClimbs(climbs, prio = { low: false }) {
  if (!climbs.length) return [];
  const opCancel = makeCancel(prio);
  const nomCancel = makeCancel(prio);
  const t0 = Date.now();

  if (prio.low) {
    try {
      return await nameWithOverpass(climbs, opCancel);
    } catch (e) {
      return climbs.map(() => BUSY);
    }
  }

  const op = nameWithOverpass(climbs, opCancel);

  const startNom = new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, FALLBACK_AFTER_MS - (Date.now() - t0)));
    op.then(() => clearTimeout(timer), () => { clearTimeout(timer); resolve(); });
  });

  // Nominatim results per climb; kept even when partial, in case Overpass fails too.
  const nomResults = climbs.map(() => null);
  const nom = startNom.then(async () => {
    for (let i = 0; i < climbs.length; i++) {
      if (nomCancel.cancelled) throw new Error('cancelled');
      try {
        nomResults[i] = await nameWithNominatim(climbs[i], nomCancel);
      } catch (e) {
        if (nomCancel.cancelled) throw e;
      }
    }
    // Only win the race with a complete answer; otherwise let Overpass keep trying.
    if (nomResults.some((r) => !r)) throw new Error('Nominatim incomplete');
    return nomResults;
  });

  try {
    const winner = await Promise.any([
      op.then((r) => ({ from: 'overpass', r })),
      nom.then((r) => ({ from: 'nominatim', r })),
    ]);
    (winner.from === 'overpass' ? nomCancel : opCancel).cancel();
    return winner.r;
  } catch (e) {
    console.warn('[Climb names] both lookups failed:', e);
    return nomResults.map((r) => r || BUSY);
  } finally {
    opCancel.cancel();
    nomCancel.cancel();
  }
}

self.HHNaming = { nameClimbs, haversine };
