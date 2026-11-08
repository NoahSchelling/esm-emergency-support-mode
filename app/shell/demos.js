// Demo scripts and their replay (pure; browsers and Node.js).
//
// Shizuoka is a SIMULATED tsunami scenario (not a real event). Fukushima,
// Chiba and Tokyo replay PAST official announcements, taken only from rows
// marked "confirmed" in docs/research/demo_records.md (times are JST as
// recorded; names are the names used at the time). Nothing here is a
// current announcement, and every screen says so.
//
// Each event `set`s the list of kinds in effect after it (or leaves it as
// it is when `set` is absent: information such as observations). A tsunami
// kind may carry `height`: the forecast tsunami height of the region, as
// recorded (Fukushima) or simulated (Shizuoka). `unbounded` marks a value
// with no upper limit ("10m以上"). `info` carries recorded facts that are
// not kinds in effect (earthquake, observed tsunami heights), for the
// one-line texts of the main screen (./infolines.js).
//
// Each place carries `lookup`: the elevation (GSI elevation API) and whether
// the point is inside the national tsunami inundation estimate (hazard map
// portal tiles), looked up in advance on `checked` so the demos never send a
// position anywhere.

const H08 = Object.freeze({ text: '0.8m', value_m: 0.8, unbounded: false });
const H2 = Object.freeze({ text: '2m', value_m: 2, unbounded: false });
const H5 = Object.freeze({ text: '5m', value_m: 5, unbounded: false });
const H3 = Object.freeze({ text: '3m', value_m: 3, unbounded: false });
const H6 = Object.freeze({ text: '6m', value_m: 6, unbounded: false });
const H10 = Object.freeze({ text: '10m以上', value_m: 10, unbounded: true });
const H1 = Object.freeze({ text: '1m', value_m: 1, unbounded: false });

const SHIZUOKA_POINT = { latitude: 34.86, longitude: 138.32, accuracy: 20 }; // fictional, Yaizu, ~560 m from the coast line (computed from coast.json)
const FUKUSHIMA_POINT = { latitude: 37.765, longitude: 140.98, accuracy: 20 }; // fictional, Soma, ~1040 m from the coast line, inside the inundation estimate
const NERIMA_OFFICE = { latitude: 35.7356, longitude: 139.6517, accuracy: 20 }; // Nerima ward office (approximate, public facility)
const CHIBA_OFFICE = { latitude: 35.6073, longitude: 140.1063, accuracy: 20 }; // Chiba city office (approximate, public facility)

export const DEMOS = Object.freeze({
  shizuoka: {
    id: 'shizuoka',
    label: '静岡県（津波の模擬）',
    kind: 'simulated',
    banner: '【模擬】訓練用の模擬の発表です。実際の発表ではありません。',
    place: '焼津市内の架空の地点（海岸線から約 560 m）',
    position: SHIZUOKA_POINT,
    lookup: { elevation_m: 1.4, elevation_source: '1m（レーザ）', inundation: true, checked: '2026-11-07' },
    hasEvacData: true,
    hazardOnTsunami: 'tsunami',
    stepMs: 9000,
    sources: [],
    // Simulated hours since the (simulated) disaster, so the replay can show
    // how the handoff guide grows with the stages of modules/mode.
    // Simulated scenario (2026-11-08, from the person's request): an
    // earthquake in Suruga Bay, then the forecast height rises
    // 0.8m -> 2m -> 5m -> 10m以上. Times are simulated (no date).
    events: [
      { time: '05:07', simHours: 0, text: '【模擬】地震が発生したという想定です。駿河湾、最大震度6弱、M6.5、深さ20km（模擬）。', info: [{ type: 'quake', maxInt: '6弱', area: '駿河湾', magnitude: '6.5', depth: '20km' }] },
      { time: '05:09', simHours: 0.05, text: '【模擬】静岡県に津波注意報（模擬）が出たという想定です。予想される津波の高さ 0.8m（模擬）。', set: [{ name: '津波注意報', area: '静岡県', region: '380', height: H08 }] },
      { time: '05:20', simHours: 0.2, text: '【模擬】静岡県の津波注意報（模擬）が津波警報（模擬）に切り替わったという想定です。予想される津波の高さ 2m（模擬）。', set: [{ name: '津波警報', area: '静岡県', region: '380', height: H2 }] },
      { time: '05:35', simHours: 0.5, text: '【模擬】静岡県の津波警報（模擬）が大津波警報（模擬）に切り替わったという想定です。予想される津波の高さ 5m（模擬）。', set: [{ name: '大津波警報', area: '静岡県', region: '380', height: H5 }] },
      { time: '05:50', simHours: 0.75, text: '【模擬】静岡県の大津波警報（模擬）の予想される津波の高さが 10m以上（模擬）に上がったという想定です。', set: [{ name: '大津波警報', area: '静岡県', region: '380', height: H10 }] },
      { time: '14:10', simHours: 9, text: '【模擬】静岡県の大津波警報（模擬）が津波注意報（模擬）に切り替わったという想定です。', set: [{ name: '津波注意報', area: '静岡県', region: '380', height: H1 }] },
      { time: '翌日 11:10', simHours: 30, text: '【模擬】静岡県の津波注意報（模擬）が解除されたという想定です。', set: [] },
    ],
  },
  fukushima: {
    id: 'fukushima',
    label: '福島県（2011年3月 東北地方太平洋沖地震）',
    kind: 'record',
    banner: '【過去の記録の再生】2011年3月11日〜13日の気象庁の発表です。いま出ている発表ではありません。',
    place: '相馬市内の架空の地点（海岸線から約 1040 m、国の津波浸水想定の区域の中）',
    position: FUKUSHIMA_POINT,
    lookup: { elevation_m: 5.9, elevation_source: '国土地理院の標高 API', inundation: true, checked: '2026-11-07' },
    hasEvacData: false,
    hazardOnTsunami: 'tsunami',
    stepMs: 7000,
    sources: [
      '気象庁「災害時地震・津波速報 平成23年（2011年）東北地方太平洋沖地震」 https://www.jma.go.jp/jma/kishou/books/saigaiji/saigaiji_201101/saigaiji_201101_01.pdf',
      '同「7．気象官署のとった措置」 https://www.jma.go.jp/jma/kishou/books/saigaiji/saigaiji_201101/saigaiji_201101_07.pdf',
      '気象庁 報道発表（2011年3月12日 20:30、3月13日 09:00） https://www.jma.go.jp/jma/press/1103/12j/201103122030.html https://www.jma.go.jp/jma/press/1103/13a/201103130900.html',
    ],
    events: [
      { time: '2011-03-11 14:46', text: '三陸沖で地震が発生（のちに M9.0）。', info: [{ type: 'quake', area: '三陸沖', magnitude: '9.0（のちの値）' }] },
      { time: '2011-03-11 14:46', text: '緊急地震速報（警報）：福島県浜通り・中通りなど。', info: [{ type: 'quake', label: '緊急地震速報（警報）', area: '福島県浜通り・中通りなど', basis: '予想' }] },
      { time: '2011-03-11 14:49', text: '津波警報（大津波）：福島県。予想される津波の高さ 3m。', set: [{ name: '津波警報（大津波）', area: '福島県', region: '250', height: H3 }] },
      { time: '2011-03-11 15:14', text: '津波警報（大津波）の更新：福島県の予想高さ 6m。', set: [{ name: '津波警報（大津波）', area: '福島県', region: '250', height: H6 }] },
      { time: '2011-03-11 15:30', text: '津波警報（大津波）の更新：福島県の予想高さ 10m以上。', set: [{ name: '津波警報（大津波）', area: '福島県', region: '250', height: H10 }] },
      { time: '2011-03-11 15:39', text: '観測：いわき市小名浜で最大波 333cm。', info: [{ type: 'tsunami-obs', height: '333cm', place: '小名浜', region: '250' }] },
      { time: '2011-03-11 15:51', text: '観測：相馬で最大波 9.3m以上（観測施設の被災でデータが欠けた期間あり）。', info: [{ type: 'tsunami-obs', height: '9.3m以上', place: '相馬', region: '250' }] },
      { time: '2011-03-12 20:20', text: '福島県は津波警報（津波）に切り替え。', set: [{ name: '津波警報（津波）', area: '福島県', region: '250' }] },
      { time: '2011-03-13 07:30', text: '福島県は津波注意報に切り替え。', set: [{ name: '津波注意報', area: '福島県', region: '250' }] },
      { time: '2011-03-13 17:58', text: '津波注意報の解除（全国）。', set: [] },
    ],
  },
  chiba: {
    id: 'chiba',
    label: '千葉県（2019年9月 令和元年房総半島台風）',
    kind: 'record',
    banner: '【過去の記録の再生】2019年9月8日〜9日の千葉市への発表です。いま出ている発表ではありません。',
    place: '千葉市役所（およその位置）',
    position: CHIBA_OFFICE,
    lookup: { elevation_m: 3.1, elevation_source: '国土地理院の標高 API', inundation: true, checked: '2026-11-07' },
    hasEvacData: false,
    hazardOnTsunami: null,
    stepMs: 8000,
    sources: [
      '千葉市「令和元年台風第15号・第19号及び10月25日の大雨に関する災害記録誌」第2章・第3章 https://www.city.chiba.jp/sogoseisaku/kikikanri/kikikanri/documents/saigaikirokushi_no3.pdf',
      '千葉県「令和元年台風第15号等の災害対応検証報告書」第2章 https://www.pref.chiba.lg.jp/gyoukaku/press/2019/documents/houkokusyo2-2.pdf',
      '内閣府 関係省庁災害対策会議（第7回）資料 https://www.bousai.go.jp/kohou/oshirase/pdf/kaigi07.pdf',
    ],
    events: [
      { time: '2019-09-08 16:30', text: '暴風警報・波浪警報：千葉市。', set: [{ name: '暴風警報', area: '千葉市' }, { name: '波浪警報', area: '千葉市' }] },
      { time: '2019-09-09 04:28', text: '観測：千葉で最大瞬間風速 57.5m/s（観測史上1位）。' },
      { time: '2019-09-09 05時前', text: '台風が千葉市付近に上陸（中心気圧 960hPa）。' },
      { time: '2019-09-09 05:16', text: '土砂災害警戒情報：千葉市（2026年5月からの名称では「レベル4土砂災害危険警報」に当たる）。', set: [{ name: '暴風警報', area: '千葉市' }, { name: '波浪警報', area: '千葉市' }, { name: '土砂災害警戒情報', area: '千葉市' }] },
      { time: '2019-09-09 15:10まで', text: '警報などの解除（解除の時刻そのものは記録で確かめられませんでした）。', set: [] },
    ],
  },
  tokyo: {
    id: 'tokyo',
    label: '東京都（2019年10月 令和元年東日本台風）',
    kind: 'record',
    banner: '【過去の記録の再生】2019年10月12日〜13日の練馬区への発表です。いま出ている発表ではありません。',
    place: '練馬区役所（およその位置）',
    position: NERIMA_OFFICE,
    lookup: { elevation_m: 40.7, elevation_source: '国土地理院の標高 API', inundation: null, checked: '2026-11-07' },
    hasEvacData: false,
    hazardOnTsunami: null,
    stepMs: 7000,
    sources: [
      '練馬区 区議会資料（2019年10月16日） https://www.city.nerima.tokyo.jp/kusei/kaigi/chogi/h31/tyougi011016.files/siryout-5-3.pdf',
      '気象庁「災害をもたらした気象事例の速報 令和元年東日本台風」 https://www.jma.go.jp/jma/kishou/know/jirei/sokuhou/R011012.pdf',
      '気象庁 報道発表（2019年10月12日 16:30） https://www.jma.go.jp/jma/press/1910/12a/kaisetsu201910121630.pdf',
    ],
    events: [
      { time: '2019-10-12 04:18', text: '大雨警報：練馬区。', set: [{ name: '大雨警報', area: '練馬区' }] },
      { time: '2019-10-12 06:32', text: '洪水警報・暴風警報：練馬区。', set: [{ name: '大雨警報', area: '練馬区' }, { name: '洪水警報', area: '練馬区' }, { name: '暴風警報', area: '練馬区' }] },
      { time: '2019-10-12 15:30', text: '気象庁が東京都を含む7都県に大雨特別警報を発表（練馬区への発表は 21:19）。' },
      { time: '2019-10-12 19時前', text: '台風が伊豆半島に上陸。' },
      { time: '2019-10-12 21:15', text: '土砂災害警戒情報：練馬区。', set: [{ name: '大雨警報', area: '練馬区' }, { name: '洪水警報', area: '練馬区' }, { name: '暴風警報', area: '練馬区' }, { name: '土砂災害警戒情報', area: '練馬区' }] },
      { time: '2019-10-12 21:19', text: '大雨特別警報：練馬区。', set: [{ name: '大雨特別警報', area: '練馬区' }, { name: '洪水警報', area: '練馬区' }, { name: '暴風警報', area: '練馬区' }, { name: '土砂災害警戒情報', area: '練馬区' }] },
      { time: '2019-10-12 23:55', text: '大雨特別警報の解除（大雨警報へ切り替え）。', set: [{ name: '大雨警報', area: '練馬区' }, { name: '洪水警報', area: '練馬区' }, { name: '暴風警報', area: '練馬区' }, { name: '土砂災害警戒情報', area: '練馬区' }] },
      { time: '2019-10-13 00:07', text: '土砂災害警戒情報の解除。', set: [{ name: '大雨警報', area: '練馬区' }, { name: '洪水警報', area: '練馬区' }, { name: '暴風警報', area: '練馬区' }] },
      { time: '2019-10-13 02:13', text: '練馬区の気象警報をすべて解除。', set: [] },
    ],
  },
});

export const DEMO_IDS = Object.freeze(Object.keys(DEMOS));
export const DEMO_AREA_CODE = 'demo';

// Replay position after `elapsedMs` of real time. Each event is shown for
// demo.stepMs; the last one stays.
export function replayState(demo, elapsedMs) {
  const n = demo.events.length;
  const idx = Math.max(0, Math.min(n - 1, Math.floor(Math.max(0, elapsedMs) / demo.stepMs)));
  let set = [];
  // Time each kind in effect was announced (or last changed), as recorded.
  const sig = (k) => `${k.name}|${k.area}|${k.height?.text ?? ''}`;
  let since = new Map();
  const facts = [];
  for (let i = 0; i <= idx; i++) {
    const ev = demo.events[i];
    if (ev.set) {
      const next = new Map();
      for (const k of ev.set) next.set(sig(k), since.get(sig(k)) ?? ev.time);
      since = next;
      set = ev.set;
    }
    for (const f of ev.info ?? []) facts.push({ ...f, time: ev.time });
  }
  const items = set.map((k) => ({
    area_code: k.region ?? DEMO_AREA_CODE,
    area_name: k.area,
    kinds: [{ name: k.name, status: null }],
    time: since.get(sig(k)) ?? '',
    ...(k.height ? { max_height: { description: k.height.text, value_m: k.height.value_m, unbounded: k.height.unbounded } } : {}),
  }));
  return {
    index: idx,
    finished: elapsedMs >= n * demo.stepMs,
    event: demo.events[idx],
    log: demo.events.slice(0, idx + 1),
    items,
    facts,
    inEffect: set.map((k) => k.name),
  };
}

// The tsunami warning in effect in a replay state (for the evacuee view).
export function tsunamiInEffect(state) {
  const k = state.items.flatMap((it) => it.kinds.map((x) => ({ ...x, area: it.area_name, max_height: it.max_height ?? null }))).find((x) => /津波警報|大津波/.test(x.name));
  return k ?? null;
}

// Parse "2011-03-11 14:46" (JST, as recorded) to epoch ms; null otherwise
// (e.g. "2019-09-09 05時前" keeps only the date and hour when present).
export function recordTimeMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(?::(\d{2})|時)/.exec(text ?? '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, m[5] ? +m[5] : 0);
}

// Hours since the start of the disaster at a replay state: the recorded
// times for past records, the simulated hours for the simulated demo.
export function demoElapsedHours(demo, state) {
  if (demo.kind !== 'record') return state.event.simHours ?? 0;
  const t0 = recordTimeMs(demo.events[0].time);
  let t = null;
  for (let i = state.index; i >= 0 && t === null; i--) t = recordTimeMs(demo.events[i].time);
  return t0 === null || t === null ? 0 : Math.max(0, (t - t0) / 3600000);
}
