// Current-location mode: turn the C-A status (relayed JMA messages) and the
// area lookup into the inputs of modules/alert (pure; browsers and Node.js).
//
// Prototype limits (docs/proto/alert.md): C-A keeps only recent entries, so
// an announcement older than that window is not seen; for each message
// title only the newest message is used (a newer message of the same title
// replaces the older one, as JMA warning messages do for their areas).

// Items in effect from a C-A /api/status body.
export function itemsFromStatus(status) {
  if (!status || !Array.isArray(status.recent)) return { items: [], simulated: false, count: 0 };
  const newest = new Map();
  for (const e of status.recent) {
    const d = e.detail;
    if (!d || !Array.isArray(d.items) || d.status && d.status !== '通常') continue;
    const key = d.title || e.title;
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
export function tsunamiWarningFor(items, coast) {
  if (!coast) return null;
  for (const it of items) {
    if (String(it.area_code) !== String(coast.region_code)) continue;
    for (const k of it.kinds ?? []) {
      if (k.status && /解除/.test(k.status)) continue;
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
    if ((it.kinds ?? []).every((k) => k.status && /解除/.test(k.status))) continue;
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
