// History of the public announcements this device received (pure; storage
// is passed in, so it runs in browsers and Node.js). Kept on this device
// only, and the person can delete it from the menu.
//
// Entry: { id, at, name, area, height, source, mark, level }
//   at:     epoch ms when this device received it (or the replayed time)
//   source: 'live' | 'mock' | 'record' | 'simulated'
//   mark:   '' | '【模擬データ】' | '【模擬】' | '【過去の記録の再生】'

export const HISTORY_KEY = 'bw-history';
export const HISTORY_MAX = 300;

function read(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : [];
  } catch {
    return [];
  }
}

function write(storage, key, list) {
  try {
    storage?.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false; // storage full or unavailable: the page keeps working
  }
}

export function createHistory(storage, { key = HISTORY_KEY, max = HISTORY_MAX } = {}) {
  let cache = read(storage, key);
  return {
    list() {
      return cache.slice();
    },
    // Adds the entries that are not there yet; returns the added ones.
    add(entries) {
      const known = new Set(cache.map((e) => e.id));
      const added = [];
      for (const e of entries) {
        if (!e || typeof e.id !== 'string' || known.has(e.id)) continue;
        known.add(e.id);
        added.push({ ...e });
      }
      if (added.length) {
        cache = cache.concat(added).slice(-max);
        write(storage, key, cache);
      }
      return added;
    },
    clear() {
      cache = [];
      try {
        storage?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

// Entries for the announcements in effect (items in the modules/alert shape).
// `levelOf(name, status)` is modules/alert levelOfKind; kinds without a level
// (plain information) are not recorded.
export function entriesFromItems(items, { at, source, mark = '', idPrefix, levelOf }) {
  const out = [];
  for (const it of items ?? []) {
    for (const k of it.kinds ?? []) {
      const lv = levelOf ? levelOf(k.name, k.status) : null;
      if (!lv) continue;
      const height = it.max_height?.description ?? null;
      out.push({
        id: `${idPrefix}|${it.area_code}|${k.name}|${height ?? ''}`,
        at,
        name: k.name,
        area: it.area_name ?? '',
        height,
        source,
        mark,
        level: lv.level,
      });
    }
  }
  return out;
}

// Earliest received entry of warning level (3) or higher: used as the start
// of the disaster for the handoff memo. null when there is none.
export function disasterStartMs(list, sources = ['live', 'mock']) {
  let t = null;
  for (const e of list) {
    if (!sources.includes(e.source) || !(e.level >= 3) || !Number.isFinite(e.at)) continue;
    if (t === null || e.at < t) t = e.at;
  }
  return t;
}

export function historyLine(e, fmt) {
  return `${fmt(e.at)} ${e.mark ?? ''}${e.name}（${e.area}）${e.height ? ` 予想される津波の高さ ${e.height}` : ''}`;
}
