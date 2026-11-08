// Elevation and tsunami heights for the main screen (pure; browsers and
// Node.js). Facts only: the elevation from the GSI elevation API, the
// forecast height as published by JMA and the observed height as published
// by JMA (or the demo script). The warning mark compares the elevation with
// the HIGHER of the forecast and the observed height: once a tsunami has been
// observed there is still time before it reaches the person, and the screen
// must not make anyone give up evacuating. It is a comparison of published
// numbers, not a forecast of our own (BW-S1). Nothing here ever says "safe"
// (BW-S3).

// Always shown with the heights, whatever the numbers are.
export const TERRAIN_NOTE = '津波は予想より高くなる場合あり。';
// Shown under the map link. The link itself has no route: a navigation app
// does not know about tsunamis and may lead along the coast.
export const MAP_NOTE = '地図アプリの経路は通れない道を反映していません';
export const ELEVATION_SOURCE = '標高：国土地理院の標高 API の値';
// The elevation of a site is the ground. A tsunami evacuation tower or
// building is used from its upper floors, which this value does not include.
export const SITE_GROUND_NOTE = '避難場所の標高は地面の高さです。避難タワーやビルの上の階の高さは含みません。';
// Warning texts (shown after "⚠️").
export const BELOW_TEXT = '津波よりも下にいます';
export const UNBOUNDED_TEXT = '津波上限が予測不能です';

/**
 * One elevation value: { status, value_m, source }
 *   status: 'ok' | 'loading' | 'no-consent' | 'unavailable' | 'none'
 */
export function elevationText(e) {
  if (!e || e.status === 'none') return 'まだ調べていません';
  if (e.status === 'ok' && Number.isFinite(e.value_m)) return `約 ${formatMeters(e.value_m)} m`;
  if (e.status === 'loading') return '調べています';
  if (e.status === 'no-consent') return '調べていません（位置を外に送る取得に同意していないため）';
  return '分かりません（取得できませんでした）';
}

// Short form for the large value under the compass: "約1.4m".
export function elevationShort(e) {
  if (!e || e.status === 'none') return '—';
  if (e.status === 'ok' && Number.isFinite(e.value_m)) return `約${formatMeters(e.value_m)}m`;
  if (e.status === 'loading') return '調べています';
  if (e.status === 'no-consent') return '調べていません';
  return '分かりません';
}

export function formatMeters(v) {
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/**
 * A published height text -> { text, value_m, unbounded }.
 * "333cm" -> 3.33 m; "9.3m以上" / "10m超" -> no upper limit; "巨大" -> no value.
 */
export function parseHeight(text) {
  const t = String(text ?? '').normalize('NFKC').trim();
  const m = /^(\d+(?:\.\d+)?)\s*(cm|m)/.exec(t);
  const value = m ? Number(m[1]) / (m[2] === 'cm' ? 100 : 1) : null;
  return { text: String(text ?? ''), value_m: value, unbounded: value === null || /以上|超/.test(t) };
}

// The higher of two heights ({ value_m, unbounded } or null). A height with
// no upper limit is the higher one.
export function higherHeight(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.unbounded !== b.unbounded) return a.unbounded ? a : b;
  return (b.value_m ?? -Infinity) > (a.value_m ?? -Infinity) ? b : a;
}

// The warning for an elevation against a height (the higher of forecast
// and observed): '' (no mark), 'unbounded' or 'below'. Equal heights are
// marked too (cautious side).
export function heightWarning(e, h) {
  if (!h) return '';
  if (h.unbounded) return 'unbounded';
  if (!e || e.status !== 'ok' || !Number.isFinite(e.value_m) || !Number.isFinite(h.value_m)) return '';
  return e.value_m <= h.value_m ? 'below' : '';
}

// Kept for older callers: true when heightWarning() gives a mark.
export function lowerThanForecast(e, forecast) {
  return heightWarning(e, forecast) !== '';
}

/**
 * forecast: { text, value_m, unbounded, area, kind } or null
 * observed: { text, value_m, unbounded, place } or null (the highest
 *           observation published for the region)
 * here, site: elevation values (see elevationText)
 * opts.mark: '【模擬】' etc. appended to the height lines
 * opts.received: false when no announcement source is reachable
 */
export function heightsView({ forecast = null, observed = null, here = null, site = null, mark = '', received = true, siteName = '' } = {}) {
  const rows = [];
  if (forecast) {
    rows.push({
      key: 'forecast',
      label: '予想される津波の高さ',
      text: `${forecast.text}（${forecast.kind ? `${forecast.kind}・` : ''}${forecast.area}）${mark}`,
      warn: forecast.unbounded,
      warnText: forecast.unbounded ? UNBOUNDED_TEXT : '',
    });
  } else {
    rows.push({
      key: 'forecast',
      label: '予想される津波の高さ',
      text: received
        ? '受け取っている範囲では、この海岸への予想の高さはありません（発表がないことは、安全という意味ではありません）'
        : '受け取れていません（発表がないという意味ではありません）',
      warn: false,
      warnText: '',
    });
  }
  if (observed) {
    rows.push({
      key: 'observed',
      label: '観測された津波の高さ（実測）',
      text: `${observed.text}（${observed.place}）${mark}`,
      warn: false,
      warnText: '',
    });
  }
  const top = higherHeight(forecast, observed);
  const w = heightWarning(here, top);
  rows.push({
    key: 'here',
    label: 'いる場所の標高',
    text: elevationText(here),
    warn: w !== '',
    warnText: w === 'unbounded' ? UNBOUNDED_TEXT : w === 'below' ? BELOW_TEXT : '',
  });
  if (site) {
    const sw = heightWarning(site, top);
    rows.push({
      key: 'site',
      label: siteName ? `避難場所（${siteName}）の地面の標高` : '避難場所の地面の標高',
      text: elevationText(site),
      warn: sw !== '',
      warnText: sw === 'unbounded' ? `${UNBOUNDED_TEXT}（タワー・ビルの上の階は含みません）`
        : sw === 'below' ? '地面は津波よりも下です（タワー・ビルの上の階は含みません）' : '',
    });
  }
  return { rows, warn: rows.some((r) => r.warn), top, note: TERRAIN_NOTE, source: ELEVATION_SOURCE, siteNote: site ? SITE_GROUND_NOTE : '' };
}

// GSI map (地理院地図) centred on the public coordinates of the designated
// site, zoom 15. No route: a navigation app does not know about tsunamis and
// may lead along a coastal road. The person's position is never put in the
// URL.
export const MAP_ZOOM = 15;
export function mapSiteUrl(site) {
  if (!site || !Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) return null;
  return `https://maps.gsi.go.jp/#${MAP_ZOOM}/${site.latitude.toFixed(6)}/${site.longitude.toFixed(6)}/`;
}
