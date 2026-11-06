// Where to look when the public data cannot be used (failed to load, or no
// candidate found). Links only: the position or any input is never put into
// the URL. Public sources come first (BW-S2). The private sites are shown
// with a clear "not an official announcement" label.
// ！！仮の値！！ The list must be approved by a person (docs/research/evac_sites.md, 6).

export const FALLBACK_NOTE = '市町村の発表とハザードマップを確かめてください。';

export const FALLBACK_LINKS = Object.freeze([
  Object.freeze({
    kind: 'public',
    label: '地理院地図（指定緊急避難場所）',
    // The link the GSI information page itself uses (hinanbasho.html).
    url: 'https://maps.gsi.go.jp/#11/35.362222/138.731389/&base=std&ls=std&disp=1&lcd=skhb01&vs=c1j0l0u0f0&d=vl',
    note: '国土地理院の地図です。開いたあとで災害の種別を選びます。地図なので通信量が多くなります。',
  }),
  Object.freeze({
    kind: 'private',
    label: 'Yahoo!天気・災害 避難場所マップ（静岡県）',
    url: 'https://crisis.yahoo.co.jp/map/?pref=22',
    note: '民間のサイトです。公的な発表ではありません。',
  }),
  Object.freeze({
    kind: 'private',
    label: 'Yahoo!天気・災害 避難情報・避難所の開設情報（静岡県）',
    url: 'https://crisis.yahoo.co.jp/evacuation/22/',
    note: '民間のサイトです。公的な発表ではありません（L アラートを通じた自治体の発表などを載せています）。',
  }),
]);
