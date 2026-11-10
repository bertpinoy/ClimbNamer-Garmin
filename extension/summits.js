// Local summit lookup, so climbs named after a summit or pass are named instantly.
// Loaded by the background service worker after naming.js (uses overpass(), pickSummit()).
//
// Two sources:
//  1. Bundled data: named summits/passes in Belgium, the Netherlands and Luxembourg
//     (data/summits-benelux.json, built by tools/make-summits.py).
//  2. Areas: the first time a climb is looked up in an area (a tile of 0.5° × 0.75°,
//     about 55 × 50 km), all named summits/passes in that area are downloaded with ONE
//     Overpass request and kept on this device. Every later climb in that area is
//     named locally. Fair use: one request per area, at most one area at a time,
//     refreshed after 180 days, and at most MAX_TILES areas are kept.
//
// Data © OpenStreetMap contributors, ODbL 1.0.

/** @type {{ lookup: Function, tileKey: Function }} */
const HHSummits = (() => {
  const TILE_LAT = 0.5;
  const TILE_LON = 0.75;
  const TILE_MAX_AGE_MS = 180 * 24 * 3600 * 1000;
  const TILE_RETRY_MS = 30 * 60 * 1000;   // after a failed download, wait before retrying that area
  const MAX_TILES = 80;                    // keeps storage well under the 10 MB extension quota
  const INDEX_KEY = 'tiles:index';         // { tileKey: lastUsed }
  const KIND = { 0: 'peak', 1: 'pass', 2: 'hill' };
  const CELL = 0.05;                       // spatial index cell (~5 km)

  const index = new Map();                 // cell -> [{ name, lat, lon, kind }]
  const loadedTiles = new Set();           // tile keys merged into the index
  const failedAt = new Map();              // tile key -> time of last failure
  let bundled = null;                      // Promise, loads once per worker lifetime
  let tileQueue = Promise.resolve();
  const tileInflight = new Map();

  /** @param {number} lat @param {number} lon @returns {string} spatial index cell */
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  /** @param {number} lat @param {number} lon @returns {string} area (tile) key */
  const tileKey = (lat, lon) => `tile:${Math.floor(lat / TILE_LAT)}:${Math.floor(lon / TILE_LON)}`;

  /**
   * Adds summit rows to the in-memory index.
   * @param {Array<Array<number|string>>} rows [lat, lon, name, kind]
   * @returns {void}
   */
  function addRows(rows) {
    for (const [lat, lon, name, kind] of rows) {
      const k = cellKey(lat, lon);
      if (!index.has(k)) index.set(k, []);
      const list = index.get(k);
      // Same summit from bundled data and an area download: keep one.
      if (!list.some((s) => s.name === name && Math.abs(s.lat - lat) < 1e-4 && Math.abs(s.lon - lon) < 1e-4)) {
        list.push({ name, lat, lon, kind: KIND[kind] || 'peak' });
      }
    }
  }

  /**
   * Loads the bundled Benelux summits once per worker lifetime.
   * @returns {Promise<void>}
   */
  function loadBundled() {
    if (!bundled) {
      bundled = fetch(chrome.runtime.getURL('data/summits-benelux.json'))
        .then((r) => r.json())
        .then((d) => addRows(d.rows || []))
        .catch((e) => console.warn('[ClimbNamer] bundled summits not loaded', e));
    }
    return bundled;
  }

  // Tiles needed to cover the search area around a summit point.
  /**
   * Area keys needed to cover the search area around a point.
   * @param {number[]} top
   * @param {number} [marginDeg]
   * @returns {string[]}
   */
  function tilesAround(top, marginDeg = 0.007) {
    const keys = new Set();
    for (const dLat of [-marginDeg, marginDeg]) {
      for (const dLon of [-marginDeg, marginDeg]) keys.add(tileKey(top[0] + dLat, top[1] + dLon));
    }
    return [...keys];
  }

  /**
   * Marks areas as recently used and evicts the oldest beyond MAX_TILES.
   * @param {string[]} keys
   * @returns {Promise<void>}
   */
  async function touch(keys) {
    const idx = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] || {};
    const now = Date.now();
    keys.forEach((k) => (idx[k] = now));
    const all = Object.keys(idx);
    if (all.length > MAX_TILES) {
      const evict = all.sort((a, b) => idx[a] - idx[b]).slice(0, all.length - MAX_TILES);
      evict.forEach((k) => delete idx[k]);
      await chrome.storage.local.remove(evict);
    }
    await chrome.storage.local.set({ [INDEX_KEY]: idx });
  }

  // Load stored areas into memory. Returns the keys that are missing or too old.
  /**
   * Loads stored areas into memory.
   * @param {string[]} keys
   * @returns {Promise<string[]>} keys that are missing or too old
   */
  async function loadStoredTiles(keys) {
    const want = keys.filter((k) => !loadedTiles.has(k));
    const missing = [];
    if (want.length) {
      const stored = await chrome.storage.local.get(want);
      for (const k of want) {
        const t = stored[k];
        if (t && t.rows) {
          addRows(t.rows);
          loadedTiles.add(k);
          if (Date.now() - t.at > TILE_MAX_AGE_MS) missing.push(k);
        } else {
          missing.push(k);
        }
      }
    }
    return missing;
  }

  /** @param {string} key @returns {string} south,west,north,east */
  function tileBbox(key) {
    const [, a, b] = key.split(':').map(Number);
    const s = a * TILE_LAT, w = b * TILE_LON;
    return [s, w, s + TILE_LAT, w + TILE_LON].map((v) => v.toFixed(4)).join(',');
  }

  /**
   * Downloads the named summits of one area (one request, one area at a time).
   * @param {string} key
   * @returns {Promise<boolean>} true when stored
   */
  function downloadTile(key) {
    if (tileInflight.has(key)) return tileInflight.get(key);
    const last = failedAt.get(key);
    if (last && Date.now() - last < TILE_RETRY_MS) return Promise.resolve(false);
    /** @returns {Promise<boolean>} */
    const run = async () => {
      const bb = tileBbox(key);
      const q = `[out:json][timeout:60];(node[name][natural~"^(peak|hill|saddle)$"](${bb});node[name][mountain_pass=yes](${bb}););out;`;
      try {
        const data = await overpass(q, 70000);
        const rows = (data.elements || [])
          .filter((e) => e.type === 'node' && e.tags && e.tags.name)
          .map((e) => [
            +e.lat.toFixed(5), +e.lon.toFixed(5), e.tags.name,
            e.tags.mountain_pass === 'yes' || e.tags.natural === 'saddle' ? 1 : e.tags.natural === 'hill' ? 2 : 0,
          ]);
        await chrome.storage.local.set({ [key]: { at: Date.now(), rows } });
        await touch([key]);
        addRows(rows);
        loadedTiles.add(key);
        return true;
      } catch (e) {
        failedAt.set(key, Date.now());
        return false;
      }
    };
    // One area download at a time.
    const p = tileQueue.then(run, run);
    tileQueue = p.catch(() => {});
    tileInflight.set(key, p);
    p.finally(() => tileInflight.delete(key));
    return p;
  }

  /**
   * Named summit/pass near the top of a climb, from bundled data and stored areas.
   * Starts downloading missing areas in the background (doesn't wait for them).
   * Returns { name, kind, d } or null.
   */
  async function lookup(top) {
    await loadBundled();
    const keys = tilesAround(top);
    const missing = await loadStoredTiles(keys);
    missing.forEach((k) => downloadTile(k));
    if (keys.some((k) => loadedTiles.has(k))) touch(keys.filter((k) => loadedTiles.has(k))).catch(() => {});

    const candidates = [];
    const [lat, lon] = top;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = index.get(cellKey(lat + i * CELL, lon + j * CELL));
        if (list) candidates.push(...list);
      }
    }
    return pickSummit(top, candidates);
  }

  return { lookup, tileKey, _index: index };
})();

self.HHSummits = HHSummits;
