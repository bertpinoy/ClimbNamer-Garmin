importScripts('naming.js', 'summits.js');

// Fair use: identify ClimbNamer to the OpenStreetMap services (their usage policies ask
// apps to identify themselves). Applies only to requests made by this extension.
const USER_AGENT = `ClimbNamer/${chrome.runtime.getManifest().version} (+https://github.com/bertpinoy/ClimbNamer-Garmin)`;
chrome.declarativeNetRequest
  .updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: USER_AGENT }],
      },
      condition: {
        requestDomains: ['overpass-api.de', 'overpass.kumi.systems', 'nominatim.openstreetmap.org'],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    }],
  })
  .catch((e) => console.warn('[ClimbNamer] could not set User-Agent rule', e));

const CACHE_VERSION = 2;
const inflight = new Map(); // cache key -> { p: Promise<result>, prio: { low } }
// Note: names are cached without expiry; names of hills and roads rarely change,
// and "Clear name cache" in the settings forces new lookups.

/**
 * Cache key of a climb: start and top rounded to ~100 m.
 * @param {{ start: number[], top: number[] }} c
 * @returns {string}
 */
function climbKey(c) {
  /** @param {number} v @returns {string} */
  const r = (v) => v.toFixed(3); // ~100 m grid
  return `v${CACHE_VERSION}:${r(c.start[0])},${r(c.start[1])}>${r(c.top[0])},${r(c.top[1])}`;
}

// background: true for prefetch from list pages (lower priority).
/**
 * Names for a list of climbs: from the cache, from local summit data, or looked up.
 * @param {Array<{ start: number[], top: number[], maxEle?: number, points: number[][] }>} climbs
 * @param {boolean} background true for low-priority lookups
 * @returns {Promise<Array<object>>} one { name, detail, source } or { error } per climb
 */
async function getNames(climbs, background) {
  const keys = climbs.map(climbKey);
  const cached = await chrome.storage.local.get(keys);
  const results = new Array(climbs.length);
  const todo = [];
  const waits = [];

  const unresolved = [];
  climbs.forEach((c, i) => {
    const k = keys[i];
    if (cached[k]) {
      results[i] = cached[k];
      if (cached[k].needsDetail) enrichLater(climbs[i], k, cached[k]);
    } else if (inflight.has(k) && (background || !inflight.get(k).prio.low)) {
      waits.push(inflight.get(k).p.then((r) => (results[i] = r)));
    } else {
      // Not cached, or only queued in a slower background batch: look it up now.
      unresolved.push(i);
    }
  });

  // Instant answer for climbs whose top is a known summit or pass (bundled data or a
  // downloaded area). The "via <road>" detail is filled in later, in the background.
  await Promise.all(unresolved.map(async (i) => {
    let local = null;
    try {
      local = await HHSummits.lookup(climbs[i].top);
    } catch (e) {
      console.warn('[ClimbNamer] local summit lookup failed', e);
    }
    if (!local) return todo.push(i);
    const r = { name: local.name, detail: '', source: 'summit', needsDetail: true, at: Date.now() };
    results[i] = r;
    await chrome.storage.local.set({ [keys[i]]: r });
    enrichLater(climbs[i], keys[i], r);
  }));
  todo.sort((a, b) => a - b);

  if (todo.length) {
    const prio = { low: !!background };
    const batch = HHNaming.nameClimbs(todo.map((i) => climbs[i]), prio);
    todo.forEach((i, j) => {
      const k = keys[i];
      const entry = { prio };
      entry.p = batch
        .then(async (arr) => {
          const r = arr[j];
          if (r && !r.error) await chrome.storage.local.set({ [k]: { ...r, at: Date.now() } });
          return r;
        })
        .finally(() => { if (inflight.get(k) === entry) inflight.delete(k); });
      inflight.set(k, entry);
      waits.push(entry.p.then((r) => (results[i] = r)));
    });
  }

  await Promise.all(waits);
  return results;
}

// Background detail for locally named summits ("via Lettingstraat"): low priority,
// Overpass only, a few climbs per request. Keeps the summit name found locally.
const enrichQueue = new Map(); // cache key -> { climb, entry }
let enrichTimer = null;

/**
 * Queues a locally named climb to get its 'via <road>' detail later.
 * @param {{ start: number[], top: number[], points: number[][] }} climb
 * @param {string} key cache key
 * @param {{ name: string }} entry cached result
 * @returns {void}
 */
function enrichLater(climb, key, entry) {
  if (enrichQueue.has(key)) return;
  enrichQueue.set(key, { climb, entry });
  clearTimeout(enrichTimer);
  enrichTimer = setTimeout(runEnrich, 2000); // collect climbs of the same page into one request
}

/**
 * Looks up the road detail for queued climbs (low priority, Overpass only).
 * @returns {Promise<void>}
 */
async function runEnrich() {
  const batch = [...enrichQueue.entries()].slice(0, 12);
  if (!batch.length) return;
  try {
    const found = await HHNaming.nameClimbs(batch.map(([, v]) => v.climb), { low: true });
    await Promise.all(batch.map(async ([key, { entry }], j) => {
      const r = found[j];
      if (!r || r.error) return; // services busy: try again next time the climb is shown
      const detail = r.source === 'summit' ? r.detail : r.source === 'road' ? 'via ' + r.name : '';
      await chrome.storage.local.set({ [key]: { name: entry.name, detail, source: 'summit', at: Date.now() } });
    }));
  } finally {
    batch.forEach(([key]) => enrichQueue.delete(key));
    if (enrichQueue.size) enrichTimer = setTimeout(runEnrich, 2000);
  }
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'nameClimbs') {
    getNames(msg.climbs, !!msg.background)
      .then((names) => sendResponse({ ok: true, names }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }
  if (msg?.type === 'clearCache') {
    chrome.storage.local.clear().then(() => sendResponse({ ok: true }));
    return true;
  }
});
