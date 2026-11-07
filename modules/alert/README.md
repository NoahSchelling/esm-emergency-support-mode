# modules/alert：外枠のレベル（公的発表の中継と、津波浸水想定・海岸線からの距離）

画面の外枠（幅 10px）の色と点滅を決めます。

- 作成日：2026-11-07（日本時間）
- 状態：**試作**。実機では確かめていません。設計と未決事項は [docs/proto/alert.md](../../docs/proto/alert.md)。

## 公的情報を優先してください

！！仮の値！！ 外枠は、公的な発表の種類を色で示すだけです。予報や警報を独自に出しません。避難や身の安全の判断は、気象庁・市町村などの公的な発表と指示を優先してください。外枠に色がないことは、安全という意味ではありません。

## 決め方

| 状態 | 外枠 |
| --- | --- |
| 発表を受け取れない・区域が分からない | 背景色のまま（状態は `unknown`。画面の状態の行に「警報が出ていないという意味ではありません」） |
| 受け取っている範囲で、この地域への発表がない | 背景色のまま（`level: 0`。「安全という意味ではありません」） |
| 注意報 | 黄 `#F2E700` |
| 警報 | 赤 `#FF2800` |
| 危険警報・土砂災害警戒情報 | 紫 `#AA00AA` |
| 特別警報・大津波警報 | 紫、3 秒周期のフェードで点滅（`fade3s`） |
| 切迫：最寄りの津波予報区に津波警報・大津波警報が出ていて、国の津波浸水想定の区域の中（`inundation: true`）。区域が分からない（`inundation: null`）ときだけ、海岸線から 1000m（！！仮の値！！、このアプリの目安）以内 | そのレベルの色で、1 秒周期・フェードなしの点滅（`hard1s`） |

- 色は気象庁の警戒レベルの色（レベル 2 黄、3 赤、4 紫）。レベル 5（気象庁は黒）は紫で点滅させる（人の決定）。
- 種類の名前からレベルへの表は `levelOfKind()`（！！仮の値！！）。発表の中身から危険を推定することはしない（BW-S1）。
- 切迫は、浸水想定の区域を優先する（2026-11-07、人の決定）。区域の外（`inundation: false`）なら距離にかかわらず切迫にしない。区域が分からないときだけ、海岸線からの距離（このアプリの独自の目安）を使い、`detail` に「このアプリの目安です。公的な基準ではありません」と入れる。どちらで決めたかは `basis`（`inundation` / `distance` / `null`）。
- 遅い点滅・点滅なしのときに、安心させる文は返さない。

## 使い方

```js
import { loadCoastData, nearestCoast, alertState } from './modules/alert/node.js'; // ブラウザは browser/load.js

const coast = await loadCoastData();
const near = nearestCoast(coast, lat, lon); // { distance_m, region_code, region_name } または null
const s = alertState({
  items,      // [{ area_code, area_name, kinds: [{ name, status }] }]（試作 C-A の detail.items）
  areaCodes,  // 現在位置の区域のコード（modules/area から）
  coast: near,
  received,   // 発表を受け取れているか
  inundation, // true（浸水想定の区域の中）/ false（外）/ null（分からない）。呼ぶ側が調べる
});
// s.status, s.level（0・2〜5、または null）, s.imminent, s.basis, s.color, s.blink（none / fade3s / hard1s）, s.detail
```

位置は結果に入れません。このモジュールは位置を端末の外に送りません（浸水想定は呼ぶ側が、同意の後だけ調べます。`app/shell/lookup.js`）。

## データ

`data/coast.json`：気象庁「予報区等GISデータ」の「津波予報区」の線（静岡県・福島県・千葉県・東京湾内湾）。作り方と出典は [data/SOURCE.md](data/SOURCE.md)。

出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）。気象庁「予報区等GISデータ」をもとに本プロジェクトが作成。

## テスト

```bash
node --test 'modules/alert/test/*.test.js'
```

## 心理・医療の助言について

このモジュールは、心理（メンタルヘルス）と医療の助言に当たる処理を持ちません（BW-S4）。
