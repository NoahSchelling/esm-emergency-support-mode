// Fixed table that maps public announcement categories to the rules.
// This is a lookup on the announcement type itself. The module never
// estimates danger from the content of an announcement (BW-S1).

export const MODES = Object.freeze({
  NORMAL: "normal",
  ELEVATED: "elevated",
  EMERGENCY: "emergency",
});

export const MODE_LABELS = Object.freeze({
  normal: "平常",
  elevated: "警戒高め",
  emergency: "緊急",
});

export const MODE_RANK = Object.freeze({ normal: 0, elevated: 1, emergency: 2 });

// strong: rule 1 (move to emergency). weak: rule 2 (raise to elevated only).
// floor: rule 3 (mode cannot go below elevated while active).
export const CATEGORIES = Object.freeze({
  eew_warning: { label: "緊急地震速報（警報）", strength: "strong", floor: false },
  tsunami_warning: { label: "津波警報", strength: "strong", floor: true },
  major_tsunami_warning: { label: "大津波警報", strength: "strong", floor: true },
  special_warning: { label: "特別警報", strength: "strong", floor: true },
  j_alert: { label: "J アラート", strength: "strong", floor: false },
  eew_forecast: { label: "緊急地震速報（予報）", strength: "weak", floor: false },
  warning: { label: "警報", strength: "weak", floor: false },
  // Seismic intensity observation: strength and floor depend on the value.
  intensity: { label: "震度の観測", strength: "by_value", floor: "by_value" },
});

// JMA seismic intensity scale, in order. "5-" = 5 lower, "6+" = 6 upper.
export const INTENSITY_SCALE = Object.freeze(["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]);
export const INTENSITY_WEAK_MIN = "3";
export const INTENSITY_FLOOR_MIN = "6-";

const INTENSITY_LABELS = Object.freeze({
  "5-": "5弱",
  "5+": "5強",
  "6-": "6弱",
  "6+": "6強",
});

export function intensityLabel(value) {
  return `震度${INTENSITY_LABELS[value] ?? value}`;
}

/**
 * Classify a public announcement by its category (and intensity value).
 * @returns {{ok: true, label: string, strength: "strong"|"weak"|"none", floor: boolean}
 *          | {ok: false, reason: string}}
 */
export function classify(category, intensity) {
  const entry = Object.hasOwn(CATEGORIES, category) ? CATEGORIES[category] : undefined;
  if (!entry) {
    return { ok: false, reason: `種類「${String(category)}」は規則の表にないため、判定できません。` };
  }
  if (entry.strength !== "by_value") {
    return { ok: true, label: entry.label, strength: entry.strength, floor: entry.floor };
  }
  const idx = INTENSITY_SCALE.indexOf(intensity);
  if (idx < 0) {
    return { ok: false, reason: `震度の値「${String(intensity)}」を読み取れないため、判定できません。` };
  }
  const weak = idx >= INTENSITY_SCALE.indexOf(INTENSITY_WEAK_MIN);
  const floor = idx >= INTENSITY_SCALE.indexOf(INTENSITY_FLOOR_MIN);
  return {
    ok: true,
    label: `${intensityLabel(intensity)}の観測`,
    strength: weak ? "weak" : "none",
    floor,
  };
}
