// One-line texts of the received information for the main screen (pure;
// browsers and Node.js). The line above the compass is the first of
// infoLines(); the others are shown under the compass.
//
// Priority: tsunami > earthquake > other hazards. Within a class: the
// higher level first, then the newer one. Every value is copied from the
// announcement (or the demo record) as given (BW-S1). The earthquake
// intensity here is only the published one; the device's own shaking is
// never called an intensity.

const RANK = Object.freeze({ tsunami: 0, quake: 1, other: 2 });

// Colour level of an observed tsunami height, by the height classes JMA uses
// for its tsunami warnings (1 m or less: advisory, up to 3 m: warning, over
// 3 m or no upper limit: major warning). Only a colour for a published
// observation; the alert border still comes from the announcements (BW-S1).
export function observedLevel(h) {
  if (!h) return null;
  if (h.unbounded || h.value_m > 3) return 5;
  if (h.value_m > 1) return 3;
  return 2;
}

// "3.11 14:46" (JST; no year).
export function formatMdHm(ms) {
  if (!Number.isFinite(ms)) return '';
  const t = new Date(ms + 9 * 3600 * 1000);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${t.getUTCMonth() + 1}.${t.getUTCDate()} ${hh}:${mm}`;
}

// "2011-03-11 14:46" -> "3.11 14:46"; "2019-09-09 05時前" -> "9.9 05時前".
export function recordMdHm(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s*(.*)$/.exec(text ?? '');
  if (!m) return text ?? '';
  return `${Number(m[2])}.${Number(m[3])}${m[4] ? ` ${m[4]}` : ''}`;
}

export function classOf(name) {
  if (/津波/.test(name ?? '')) return 'tsunami';
  if (/地震/.test(name ?? '')) return 'quake';
  return 'other';
}

const join = (parts) => parts.filter(Boolean).join('、');

// 津波 〇m、〇〇港、到着 xx:xx、予想／実測. The kind name (大津波警報 ...)
// is kept in front of the height so the line says what was announced.
export function tsunamiLine({ name = '津波', height = '', place = '', arrival = '', basis = '' }) {
  return `${name}${height ? ` ${height}` : ''}${place || arrival || basis ? '、' : ''}${join([place, arrival ? `到着 ${arrival}` : '', basis])}`;
}

// 地震 最大震度〇、〇〇県〇〇地域、M〇、深さ〇km、予想／実測.
export function quakeLine({ label = '', maxInt = '', area = '', magnitude = '', depth = '', basis = '' }) {
  return `地震 ${join([label, maxInt ? `最大震度${maxInt}` : '', area, magnitude ? `M${magnitude}` : '', depth ? `深さ${depth}` : '', basis])}`;
}

export function otherLine({ name, area = '' }) {
  return join([name, area]);
}

/**
 * items: announcement items in effect for this place
 *   ({ area_name, kinds: [{ name, status }], max_height?, time?, report_ms? })
 * facts: demo facts ({ type: 'quake' | 'tsunami-obs', ..., time })
 * levelOf(name, status) -> { level } | null (modules/alert levelOfKind)
 * Returns [{ cls, level, text, time }] sorted by priority.
 */
export function infoLines({ items = [], facts = [], levelOf = () => null, parseHeight = null } = {}) {
  const out = [];
  let seq = 0;
  for (const it of items) {
    for (const k of it.kinds ?? []) {
      const lv = levelOf(k.name, k.status);
      if (!lv) continue;
      const cls = classOf(k.name);
      const h = it.max_height;
      const text = cls === 'tsunami'
        ? tsunamiLine({ name: k.name, height: h ? h.description : '', place: it.area_name ?? '', basis: h ? '予想' : '' })
        : otherLine({ name: k.name, area: it.area_name ?? '' });
      const time = it.time ? recordMdHm(it.time) : formatMdHm(it.report_ms);
      out.push({ cls, sub: 0, level: lv.level, text, time, seq: seq++ });
    }
  }
  for (const f of facts) {
    const time = f.time ? recordMdHm(f.time) : '';
    if (f.type === 'tsunami-obs') {
      // The higher of the observed height's class and the tsunami warning
      // in effect: an observation never lowers the warning colour.
      const warnLevel = Math.max(0, ...out.filter((l) => l.cls === 'tsunami' && l.sub === 0).map((l) => l.level ?? 0));
      const obs = parseHeight ? observedLevel(parseHeight(f.height)) : null;
      const level = Math.max(warnLevel, obs ?? 0) || null;
      out.push({ cls: 'tsunami', sub: 1, level, text: tsunamiLine({ name: '津波', height: f.height, place: f.place, basis: '実測' }), time, seq: seq++ });
    } else if (f.type === 'quake') {
      out.push({ cls: 'quake', sub: 0, level: null, text: quakeLine(f), time, seq: seq++ });
    }
  }
  out.sort((a, b) => RANK[a.cls] - RANK[b.cls] || a.sub - b.sub || (b.level ?? -1) - (a.level ?? -1) || b.seq - a.seq);
  return out.map(({ cls, level, text, time }) => ({ cls, level, text, time }));
}
