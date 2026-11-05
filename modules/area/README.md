# modules/area：位置から市町村と警報・注意報の区域を引く

緯度・経度と位置の誤差から、市町村（政令指定都市は区）と、気象庁の警報・注意報の区域（府県予報区等・一次細分区域等・市町村等をまとめた地域等・市町村等）のコードを返します。

- **処理はすべて端末の中で行います。** 位置を外に送りません。読み込むのは、このモジュールに同梱した区域のデータ（`data/shizuoka.json`）だけです。結果にも位置そのものは入れません。
- **対象は静岡県だけです。** 県の外では「判定できない」（`unknown`）を返します。
- 区域の名前とコードは、気象庁のデータの値をそのまま返します。
- このモジュールは区域を引くだけです。警報・注意報の有無は判定しません。独自の予報・警報は出しません（BW-S1）。避難や身の安全にかかわる判断は、気象庁・自治体などの公的な発表と指示を優先してください。
- 「判定できない」は「安全」ではありません。新しい警報・注意報がないことも意味しません（BW-S3）。

## 使い方

### Node.js

```js
import { loadAreaData, locateArea } from './modules/area/node.js';

const data = await loadAreaData(); // data/shizuoka.json を読む
const r = locateArea(data, { latitude: 34.9769, longitude: 138.3831, accuracy: 20 });
// r.status === 'ok'
// r.value.municipality.area             → { code: '2210100', name: '静岡葵区' }
// r.value.warning_areas.city.area       → { code: '2210001', name: '静岡市南部' }
// r.value.warning_areas.group.area      → { code: '220011', name: '中部南' }
// r.value.warning_areas.primary.area    → { code: '220010', name: '中部' }
// r.value.warning_areas.prefecture.area → { code: '220000', name: '静岡県' }
```

（例の座標は静岡県庁のおよその位置です。）

### ブラウザ

ブラウザ専用の部分は `browser/` に分けています。`data/` を同じサイトに置いてください。

```html
<script type="module">
  import { loadAreaData, locateArea } from './modules/area/browser/load.js';
  const data = await loadAreaData(); // ../data/shizuoka.json を同じサイトから読む
  navigator.geolocation.getCurrentPosition((p) => {
    const r = locateArea(data, {
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
    });
    console.log(r);
  });
</script>
```

`area.js` には入出力がないので、データを自分で読む場合は `prepareAreaData(json)` を通してから `locateArea` に渡します。

### 入力

| 項目 | 意味 |
| --- | --- |
| `latitude`・`longitude` | 度。数値でないとき、範囲の外のときは `error` |
| `accuracy` | 位置の誤差の半径（メートル）。**必須**。ないとき・負のときは `error`（誤差が分からないまま区域を決めない） |
| `source`（任意） | `"simulated"` にすると、結果の `source` も `"simulated"` になる（模擬データ・再生データ用） |

### 結果

共通の形で返します。

| 項目 | 値 |
| --- | --- |
| `kind` | `"area"` |
| `status` | `"ok"`／`"unknown"`／`"error"` |
| `value` | `status` が `"ok"` のときだけ入る。それ以外は `null` |
| `observed_at` | 判定した時刻（ISO 8601、`+09:00` 付き） |
| `source` | `"jma"`（気象庁のデータで判定）。入力が `"simulated"` なら `"simulated"` |
| `detail` | 理由や補足（日本語） |

`value` の中身：

| 項目 | 意味 |
| --- | --- |
| `determined` | すべての階層で区域が 1 つに決まったときだけ `true` |
| `outside_possible` | 調べた範囲の一部が県の外（海上または他の都道府県）にかかるとき `true` |
| `accuracy_m`・`checked_radius_m` | 渡された誤差と、実際に調べた半径（誤差＋データの誤差 約 31m） |
| `municipality` | 市町村等（地震津波関係）。政令指定都市は区（例：静岡葵区） |
| `warning_areas.prefecture`・`.primary`・`.group`・`.city` | 府県予報区等・一次細分区域等・市町村等をまとめた地域等・市町村等（気象警報等） |
| `attribution`・`processed` | 出典と、加工したことの表記（画面に出すときに使う） |

各階層は `{ type, determined, area, candidates }` の形です。

- `determined` が `true` のときだけ `area` に `{ code, name }` が入ります。それ以外は `area` は `null` です。
- `candidates` には、調べた範囲にかかる区域をすべて入れます。`center_inside` は、位置の中心がその区域の中にあるかです（参考の情報で、「その区域に決めた」という意味ではありません）。

### 判定のしかた

1. 調べる半径を「渡された誤差＋データの簡略化による誤差（`data/shizuoka.json` の `simplification.max_error_m`、約 31m）」にします。
2. 中心が県の外にあり、県の境界がその半径より遠いとき → `unknown`（海上、または他の都道府県）。
3. それ以外は、半径の中にかかる区域をすべて候補にします。候補が 1 つで、県の外にかかっていないときだけ、その階層を `determined` にします。複数にかかるときは `status` は `"ok"` で、`area` は `null`、`detail` に「1 つに決めず、候補をすべて返します」と書きます。
4. 候補が 1 つもないとき（省いた小さな島など）→ `unknown`。

上位の区域（市町村等をまとめた地域等・一次細分区域等・府県予報区等）は、気象庁防災情報 XML のコード表の対応から引いています。

### 制限

- 境界は簡略化しています。誤差は最大約 31m で、その分は必ず候補を広げて扱います。詳しくは `data/SOURCE.md`。
- 面積がごく小さい岩礁や小島（簡略化のあと 2,000m² 未満）は省いています。その上の点は「県の外」と判定されます。
- 海岸線の近くでは、陸でも海上、海上でも陸と判定されることがあります（誤差の範囲内なら `outside_possible` が `true` になります）。
- 境界とコードは、取得した時点（GIS データ 2026-02-26 版、コード表 2026-10-19 版）のものです。区域が変わったらデータを作り直してください。
- 地震情報の「細分区域」、津波予報区、火山の区域はまだ扱っていません。

## テスト

```bash
node --test modules/area/test/*.test.js
```

公共施設（県庁・市役所など）の座標、区域の境界の上の点（データから計算）、海上、県の外、誤差の円が広いとき、入力の誤りを試します。テストの位置は公共施設のおよその位置か、データから計算した点か、海上・県外の架空の点です。

## データの作り直し

`tools/build_area_data.py`（Python 標準ライブラリだけ）で作ります。手順は `data/SOURCE.md` にあります。

## 出典

出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）

`data/shizuoka.json` は、気象庁「予報区等GISデータ」（<https://www.data.jma.go.jp/developer/gis.html>）と気象庁防災情報 XML の個別コード表（<https://xml.kishou.go.jp/tec_material.html>）を加工して作成したものです（静岡県分の切り出し・形状の簡略化・座標の丸め）。加工したのは本プロジェクトで、編集責任は本プロジェクトにあります。気象庁が作ったものではありません。

気象庁の GIS データのページの記載：この地図の作成に当たっては、国土地理院長の承認を得て、同院発行の数値地図25000（空間データ基盤）、数値地図（国土基本情報）、電子国土基本図（地図情報）を使用した。（承認番号　平30情使 第401号・令２情使 第125号・令３情使 第90号・令３情使 第123号・令３情使 第648号・令４情使 第437号・令５情使 第71号・令６情使 第382号・令７情使 第395号）

## 心理・医療の助言について

このモジュールは、心理（メンタルヘルス）と医療の助言に当たる処理を持ちません（BW-S4）。区域を返すだけです。
