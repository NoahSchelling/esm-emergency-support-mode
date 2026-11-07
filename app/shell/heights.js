// Elevation and forecast tsunami height for the main screen (pure; browsers
// and Node.js). Facts only: the elevation from the GSI elevation API and the
// forecast height as published by JMA (or the demo script). The warning
// mark is a comparison of those two published numbers, not a forecast of
// our own (BW-S1). Nothing here ever says "safe" (BW-S3).

// Always shown with the heights, whatever the numbers are.
export const TERRAIN_NOTE = '地形によって津波は予想より高くなる可能性があります。';
export const MAP_ROUTE_NOTE = '地図アプリの経路は、通れない道や浸水を考えていません。';
export const ELEVATION_SOURCE = '標高：国土地理院の標高 API の値';
// The elevation of a site is the ground. A tsunami evacuation tower or
// building is used from its upper floors, which this value does not include.
export const SITE_GROUND_NOTE = '避難場所の標高は地面の高さです。避難タワーやビルの上の階の高さは含みません。';

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

export function formatMeters(v) {
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

// True when the place is lower than (or as high as) the forecast, or the
// forecast has no upper limit ("10m以上", "巨大"). Equal heights are marked
// too (cautious side).
export function lowerThanForecast(e, forecast) {
  if (!forecast) return false;
  if (forecast.unbounded) return true;
  if (!e || e.status !== 'ok' || !Number.isFinite(e.value_m) || !Number.isFinite(forecast.value_m)) return false;
  return e.value_m <= forecast.value_m;
}

/**
 * forecast: { text, value_m, unbounded, area, kind } or null
 * here, site: elevation values (see elevationText)
 * opts.mark: '【模擬】' etc. appended to the forecast line
 * opts.received: false when no announcement source is reachable
 */
export function heightsView({ forecast = null, here = null, site = null, mark = '', received = true, siteName = '' } = {}) {
  const rows = [];
  if (forecast) {
    rows.push({
      key: 'forecast',
      label: '予想される津波の高さ',
      text: `${forecast.text}（${forecast.kind ? `${forecast.kind}・` : ''}${forecast.area}）${mark}`,
      warn: forecast.unbounded,
      warnText: forecast.unbounded ? '予想に上限がありません' : '',
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
  const hereLow = lowerThanForecast(here, forecast);
  rows.push({
    key: 'here',
    label: 'いる場所の標高',
    text: elevationText(here),
    warn: hereLow,
    warnText: hereLow ? (forecast?.unbounded ? '予想に上限がありません' : '予想の高さ以下です') : '',
  });
  if (site) {
    const siteLow = lowerThanForecast(site, forecast);
    rows.push({
      key: 'site',
      label: siteName ? `避難場所（${siteName}）の地面の標高` : '避難場所の地面の標高',
      text: elevationText(site),
      warn: siteLow,
      warnText: siteLow ? (forecast?.unbounded ? '予想に上限がありません（タワー・ビルの上の階は含みません）' : '地面は予想の高さ以下です（タワー・ビルの上の階は含みません）') : '',
    });
  }
  return { rows, warn: rows.some((r) => r.warn), note: TERRAIN_NOTE, source: ELEVATION_SOURCE, siteNote: site ? SITE_GROUND_NOTE : '' };
}

// Google Maps directions URL (official URL format, no API key): walking,
// destination = the public coordinates of the designated site only. The
// person's position is never put in the URL.
export function mapRouteUrl(site) {
  if (!site || !Number.isFinite(site.latitude) || !Number.isFinite(site.longitude)) return null;
  const dest = `${site.latitude.toFixed(5)},${site.longitude.toFixed(5)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=walking`;
}
