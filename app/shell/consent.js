// One consent for every lookup that sends the position (or a map tile
// around it) outside the device: the GSI elevation API and the national
// tsunami inundation estimate (hazard map portal tiles). Pure; storage is
// passed in. Without consent nothing is sent and the screen says so.

export const CONSENT_KEY = 'bw-consent-position-lookup';

export const CONSENT_TEXT = Object.freeze([
  '同意すると、いる場所の位置（緯度・経度）を次の 2 つに送って調べます。',
  '国土地理院の標高 API：いる場所の標高を調べます。',
  'ハザードマップポータルサイト（国土地理院）の津波浸水想定の地図の画像：いる場所が国の津波浸水想定の区域の中かを調べます（位置のまわりの地図の画像を取りに行くので、およその位置が伝わります）。',
  '送るのは、画面を開いている間に、位置が大きく変わったときだけです。このアプリの運営者には送りません。',
  '同意しないときも、避難場所の方向は出します。そのときは、浸水想定の代わりに海岸線からの距離（このアプリの目安。公的な基準ではありません）を使います。',
  '避難場所の標高は、公開されている避難場所の座標を送って調べます（いる場所の位置は送りません）。この取得は同意がなくても行います。',
]);

export const CONSENT_STOP = 'やめるときは、この画面で「同意しない」を選んでください。選んだ後は送りません。';

export function readConsent(storage) {
  try {
    const raw = storage?.getItem(CONSENT_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.granted === true && Number.isFinite(v.at) ? { granted: true, at: v.at } : { granted: false, at: null };
  } catch {
    return { granted: false, at: null };
  }
}

export function writeConsent(storage, granted, nowMs = Date.now()) {
  try {
    if (granted) storage?.setItem(CONSENT_KEY, JSON.stringify({ granted: true, at: nowMs }));
    else storage?.removeItem(CONSENT_KEY);
  } catch {
    // storage unavailable: the consent lasts for this page only
  }
  return granted ? { granted: true, at: nowMs } : { granted: false, at: null };
}
