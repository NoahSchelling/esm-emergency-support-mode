// Public agencies: websites and phone numbers (pure data; browsers and
// Node.js). Every entry was checked one by one on the official page given in
// `src` on CHECKED. Entries that could not be checked are not listed.
// Numbers are written as on the official page (half-width digits).
//
// National entries are always shown. The demo places (Yaizu, Soma, Chiba,
// Nerima) and their prefectures follow.

export const CHECKED = '2026-11-07';

const tel = (label, number, src, note = '') => ({ type: 'tel', label, value: number, src, note });
const web = (label, url, note = '') => ({ type: 'web', label, value: url, src: url, note });

export const CONTACT_GROUPS = Object.freeze([
  {
    id: 'national',
    title: '全国',
    links: [
      web('気象庁', 'https://www.jma.go.jp/jma/index.html'),
      web('防災庁（旧 内閣府 防災情報のページ）', 'https://www.bousai.go.jp/', '2026年11月2日に発足'),
      web('総務省消防庁', 'https://www.fdma.go.jp/'),
      web('海上保安庁', 'https://www.kaiho.mlit.go.jp/'),
      web('ハザードマップポータルサイト（国土地理院）', 'https://disaportal.gsi.go.jp/'),
      web('重ねるハザードマップ（国土地理院）', 'https://disaportal.gsi.go.jp/hazardmap/maps/index.html'),
      web('119番緊急通報（総務省消防庁）', 'https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html'),
      web('救急安心センター事業 #7119 の実施地域（総務省消防庁）', 'https://www.fdma.go.jp/mission/enrichment/appropriate/appropriate007.html'),
      web('118番（海上保安庁）', 'https://www.kaiho.mlit.go.jp/doc/tel118.html'),
      web('災害用伝言ダイヤル 171（NTT東日本）', 'https://www.ntt-east.co.jp/saigai/voice171/'),
    ],
    phones: [
      tel('消防・救急', '119', 'https://www.fdma.go.jp/mission/enrichment/kyukyumusen_kinkyutuhou/119.html'),
      tel('警察（事件・事故の緊急通報）', '110', 'https://www.npa.go.jp/goiken_index.html', '緊急でない相談は #9110'),
      tel('海の事件・事故（海上保安庁）', '118', 'https://www.kaiho.mlit.go.jp/doc/tel118.html'),
      tel('災害用伝言ダイヤル', '171', 'https://www.ntt-east.co.jp/saigai/voice171/', '災害のときに提供される'),
      tel('気象庁（代表）', '03-6758-3900', 'https://www.jma.go.jp/jma/index.html', '公式の表記は 03(6758)3900'),
      tel('防災庁（大代表）', '03-5797-7611', 'https://www.bousai.go.jp/'),
      tel('総務省消防庁（代表）', '03-5253-5111', 'https://www.fdma.go.jp/'),
      tel('海上保安庁（代表・自動応答）', '03-3591-6361', 'https://www.kaiho.mlit.go.jp/'),
    ],
  },
  {
    id: 'shizuoka',
    title: '静岡県・焼津市',
    links: [
      web('静岡県', 'https://www.pref.shizuoka.jp/'),
      web('静岡県 防災・緊急', 'https://www.pref.shizuoka.jp/bosaikinkyu/'),
      web('焼津市', 'https://www.city.yaizu.lg.jp/'),
      web('焼津市 防災', 'https://www.city.yaizu.lg.jp/safety/bosai/index.html'),
      web('焼津市 ハザードマップ', 'https://www.city.yaizu.lg.jp/safety/bosai/bosai-info/hazard-map/index.html'),
    ],
    phones: [
      tel('静岡県 救急電話相談', '#7119', 'https://www.pref.shizuoka.jp/bosaikinkyu/shobo/1064942.html', '24時間。つながらない回線では 054-204-7119。15歳未満は #8000'),
      tel('静岡県庁（県庁案内）', '054-221-2455', 'https://www.pref.shizuoka.jp/kensei/pr/hiroba/1007313.html', '平日 8:30〜17:15'),
      tel('静岡県 危機管理部 危機対策課', '054-221-2072', 'https://www.pref.shizuoka.jp/kensei/introduction/soshiki/1003618/1030239.html'),
      tel('焼津市役所（代表）', '054-626-1111', 'https://www.city.yaizu.lg.jp/shisetsu/cate001/cityoffice-yaizu.html', '月〜金 8:30〜17:15'),
      tel('焼津市 防災部 防災政策課', '054-625-0128', 'https://www.city.yaizu.lg.jp/safety/bosai/bosai-info/index.html'),
      tel('焼津市 同報無線 音声応答サービス', '054-656-2727', 'https://www.city.yaizu.lg.jp/safety/bosai/bosai-info/obtain-info/doho-onsei-outo.html', '直近 2 回の放送を聞ける。通話料がかかる'),
    ],
  },
  {
    id: 'fukushima',
    title: '福島県・相馬市',
    links: [
      web('福島県', 'https://www.pref.fukushima.lg.jp/'),
      web('ふくしまぼうさいウェブ（福島県）', 'https://www.pref.fukushima.lg.jp/site/bousai/'),
      web('相馬市', 'https://www.city.soma.fukushima.jp/'),
      web('相馬市 防災・安全', 'https://www.city.soma.fukushima.jp/bosai_anzen/index.html'),
      web('相馬市 津波ハザードマップ', 'https://www.city.soma.fukushima.jp/bosai_anzen/saigainisonaete/hazard_map/1906.html'),
    ],
    phones: [
      tel('福島県救急電話相談', '#7119', 'https://www.pref.fukushima.lg.jp/sec/21045c/iryou-yakankyukyu.html', '毎日24時間。つながらない回線では 024-524-3020。15歳未満は #8000'),
      tel('福島県庁（代表）', '024-521-1111', 'https://www.pref.fukushima.lg.jp/'),
      tel('福島県 危機管理部 危機管理課', '024-521-8651', 'https://www.pref.fukushima.lg.jp/sec/01010a/'),
      tel('相馬市役所（代表）', '0244-37-2120', 'https://www.city.soma.fukushima.jp/', '夜間・休日は 0244-37-2195'),
      tel('相馬市 地域防災対策室 消防防災係', '0244-37-2121', 'https://www.city.soma.fukushima.jp/bosai_anzen/saigainisonaete/hazard_map/1906.html'),
      tel('相馬市 防災行政無線 電話応答装置', '0244-35-6633', 'https://www.city.soma.fukushima.jp/bosai_anzen/saigainisonaete/bousai_musen/1917.html'),
    ],
  },
  {
    id: 'chiba',
    title: '千葉県・千葉市',
    links: [
      web('千葉県', 'https://www.pref.chiba.lg.jp/'),
      web('千葉県 防災対策課', 'https://www.pref.chiba.lg.jp/bousai/'),
      web('千葉市', 'https://www.city.chiba.jp/'),
      web('千葉市 防災・安全安心', 'https://www.city.chiba.jp/anzen/index.html'),
      web('千葉市 地震・風水害ハザードマップ（WEB版）', 'https://www.city.chiba.jp/other/jf_hazardmap/index.html'),
    ],
    phones: [
      tel('千葉県救急安心電話相談', '#7119', 'https://www.pref.chiba.lg.jp/iryou/soudan/ansindenwasoudan.html', '24時間365日。つながらない回線では 043-216-3668。小児は #8000'),
      tel('千葉県庁（代表）', '043-223-2110', 'https://www.pref.chiba.lg.jp/'),
      tel('千葉県 防災対策課 災害対策室', '043-223-2175', 'https://www.pref.chiba.lg.jp/bousai/'),
      tel('千葉市役所（代表）', '043-245-5111', 'https://www.city.chiba.jp/front/cityhall.html', '月〜金 9:00〜17:00'),
      tel('千葉市 危機管理部 危機管理課', '043-245-5151', 'https://www.city.chiba.jp/sogoseisaku/kikikanri/kikikanri/index.html'),
      tel('千葉市 防災行政無線テレホンサービス', '050-5530-9907', 'https://www.city.chiba.jp/somu/kikikanri/bosai/musentelephone.html', '通話料は利用者負担。2023年7月に番号が変わった'),
    ],
  },
  {
    id: 'tokyo',
    title: '東京都・練馬区',
    links: [
      web('東京都', 'https://www.metro.tokyo.lg.jp/'),
      web('東京都防災ホームページ', 'https://www.bousai.metro.tokyo.lg.jp/'),
      web('練馬区', 'https://www.city.nerima.tokyo.jp/'),
      web('練馬区 防災・安全安心情報', 'https://www.city.nerima.tokyo.jp/kurashi/bosai/index.html'),
      web('練馬区 水害ハザードマップ', 'https://www.city.nerima.tokyo.jp/kurashi/bosai/suigai/hazardmap.html'),
    ],
    phones: [
      tel('東京消防庁救急相談センター（23区）', '#7119', 'https://www.tfd.metro.tokyo.lg.jp/lfe/kyuu_adv/soudan-center.html', '24時間365日。つながらない回線では 03-3212-2323'),
      tel('東京都庁（代表）', '03-5321-1111', 'https://www.metro.tokyo.lg.jp/'),
      tel('東京都 総合防災部 防災管理課', '03-5388-2453', 'https://www.bousai.metro.tokyo.lg.jp/link/1000044/1000252.html'),
      tel('練馬区役所（代表）', '03-3993-1111', 'https://www.city.nerima.tokyo.jp/shisetsu/ku/ku/annai.html'),
      tel('練馬区 危機管理室 危機管理課', '03-5984-2762', 'https://www.city.nerima.tokyo.jp/kusei/soshiki/kikikanri/kanri.html'),
      tel('練馬区 無線放送塔の放送内容 電話確認', '0120-707-111', 'https://www.city.nerima.tokyo.jp/kurashi/bosai/oshirase/automatic-answer.html', '通話無料。放送から24時間以内'),
    ],
  },
]);

// tel: URL ("#" must be escaped).
export function telHref(number) {
  return `tel:${String(number).replace(/#/g, '%23').replace(/[^0-9%+]/g, '')}`;
}
