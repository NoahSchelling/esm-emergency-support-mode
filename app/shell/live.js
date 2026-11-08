// Current-location mode: turn the C-A status (relayed JMA messages) and the
// area lookup into the inputs of modules/alert (pure; browsers and Node.js).
//
// Prototype limits (docs/proto/alert.md): C-A keeps only recent entries, so
// an announcement older than that window is not seen; for each message
// title only the newest message is used (a newer message of the same title
// replaces the older one, as JMA warning messages do for their areas).

// Items in effect from a C-A /api/status body.
export function itemsFromStatus(status) {
  // "current" (C-A): the newest message of each group, kept even after it
  // leaves the 10 newest entries ("recent", older C-A without "current").
  const list = Array.isArray(status?.current) ? status.current : Array.isArray(status?.recent) ? status.recent : null;
  if (!list) return { items: [], simulated: false, count: 0 };
  const newest = new Map();
  for (const e of list) {
    const d = e.detail;
    if (!d || !Array.isArray(d.items) || !d.items.length || d.status && d.status !== '通常') continue;
    // Same grouping as C-A: every tsunami message carries the current
    // tsunami list; other kinds are per title and per issuing office.
    const title = d.title || e.title || '';
    const key = `${/津波/.test(title) ? '津波' : title}|${e.author ?? ''}`;
    const t = d.report_datetime ?? e.updated ?? 0;
    if (!newest.has(key) || newest.get(key).t < t) newest.set(key, { t, items: d.items });
  }
  // report_ms identifies the message (stable across reloads, for the history).
  const items = [...newest.values()].flatMap((x) => x.items.map((it) => ({ ...it, report_ms: Number.isFinite(x.t) ? x.t : null })));
  return { items, simulated: status.source?.mode !== 'live', count: newest.size };
}

// Area codes that describe the location, from a modules/area result. When
// the area is not decided (several candidates), every candidate is used, so
// the higher alert of the candidates is shown (cautious side).
export function areaCodesFromArea(r) {
  if (!r || r.status !== 'ok' || !r.value) return [];
  const out = new Set();
  const add = (layer) => {
    if (!layer) return;
    for (const c of layer.candidates ?? []) if (c.code) out.add(String(c.code));
    if (layer.area?.code) out.add(String(layer.area.code));
  };
  add(r.value.municipality);
  for (const k of ['prefecture', 'primary', 'group', 'city']) add(r.value.warning_areas?.[k]);
  return [...out];
}

// The tsunami warning that applies to the nearest coast region, if any.
// A tsunami warning or advisory in effect (JMA kind names such as
// "大津波警報", "大津波警報：発表", "津波警報", "津波注意報"). Lifts
// ("警報解除", "津波注意報解除", status 解除), "津波なし" and forecasts
// ("津波予報（若干の海面変動）") are not.
export function isTsunamiAnnouncement(k) {
  const name = k?.name ?? '';
  if (/解除|なし$/.test(name) || (k?.status && /解除/.test(k.status))) return false;
  return /大津波|津波警報|津波注意報/.test(name);
}

// Facts of the replay that still apply. An observed tsunami height counts
// only while a tsunami warning or advisory is in effect for its region and
// only if it was observed after that announcement was issued: when JMA
// lowers a warning after the waves it observed, the older observation no
// longer raises the border (BW-S1 exception: raise only with a current
// observation). Other facts (earthquakes) pass.
export function currentFacts(facts, items, timeMs = () => null) {
  return (facts ?? []).filter((f) => {
    if (f.type !== 'tsunami-obs') return true;
    const its = (items ?? []).filter((it) => String(it.area_code) === String(f.region ?? '') && (it.kinds ?? []).some(isTsunamiAnnouncement));
    if (!its.length) return false;
    const ft = timeMs(f.time);
    if (ft === null) return true;
    const issued = Math.max(...its.map((it) => timeMs(it.time) ?? -Infinity));
    return ft >= issued;
  });
}

export function tsunamiWarningFor(items, coast) {
  if (!coast) return null;
  for (const it of items) {
    if (String(it.area_code) !== String(coast.region_code)) continue;
    for (const k of it.kinds ?? []) {
      if (!isTsunamiAnnouncement(k)) continue;
      if (/大津波|津波警報/.test(k.name)) return { name: k.name, area: it.area_name ?? coast.region_name };
    }
  }
  return null;
}

// Forecast tsunami height for the nearest coast region (JMA tsunami
// warning / advisory messages, Item/MaxHeight as relayed by C-A, or the
// demo scripts). Copied as given; null when no height is in effect.
export function forecastHeightFor(items, coast) {
  if (!coast) return null;
  for (const it of items ?? []) {
    if (String(it.area_code) !== String(coast.region_code) || !it.max_height) continue;
    // Only with a warning or advisory in effect (not a lift, not a forecast
    // of slight sea level changes).
    if (!(it.kinds ?? []).some(isTsunamiAnnouncement)) continue;
    const h = it.max_height;
    const value = Number.isFinite(h.value_m) ? h.value_m : null;
    return {
      text: h.description || (value !== null ? `${value}m` : '不明'),
      value_m: value,
      unbounded: Boolean(h.unbounded) || value === null,
      area: it.area_name ?? coast.region_name,
      kind: it.kinds?.[0]?.name ?? '',
    };
  }
  return null;
}

// The highest observed tsunami height published for the nearest coast
// region (demo facts: { type: 'tsunami-obs', height, place, region }).
// Copied as given; null when there is none. The caller compares it with the
// forecast and uses the higher one.
export function observedHeightFor(facts, coast, parse) {
  if (!coast) return null;
  let best = null;
  for (const f of facts ?? []) {
    if (f.type !== 'tsunami-obs' || String(f.region ?? '') !== String(coast.region_code)) continue;
    const h = { ...parse(f.height), place: f.place };
    if (!best || (h.unbounded && !best.unbounded) || (h.unbounded === best.unbounded && (h.value_m ?? -Infinity) > (best.value_m ?? -Infinity))) best = h;
  }
  return best;
}
