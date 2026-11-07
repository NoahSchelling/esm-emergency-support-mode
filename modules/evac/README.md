# modules/evac：公的に指定された避難場所への直線の方向

位置（緯度・経度・誤差）と災害の種別から、その災害に対応した**指定緊急避難場所**（市町村長が指定し、国土地理院が公開しているもの）の近い順の候補と、直線距離・真北からの方位を返します。端末の方位が使えるときは、画面の矢印をどれだけ回すかも返します。

- 作成日：2026-11-07（日本時間）
- 状態：**試作**。実機ではまだ確かめていません（確かめる点は [docs/proto/evac.md](../../docs/proto/evac.md)）。
- 対象は**静岡県だけ**です。

## 公的情報を優先してください

！！仮の値！！ このモジュールが示すのは、公的に指定された避難場所への**直線の方向**です。**道順ではありません。** 道の状態、通れるかどうか、安全かどうかは判断しません。避難の判断は、市町村・気象庁などの公的な発表と指示を優先してください。

## 安全の下限への対応

- **BW-S1**：独自の予報・警報・安全の判断をしません。方向は、国土地理院のデータにある指定緊急避難場所への直線の方向だけです。災害の種別を自分では選びません（呼び出す側が、公的な発表などから渡します。渡されないときは `error`）。「通れない」の除外は利用者の判断で、モジュールは道の状態を推定しません。
- **BW-S3**：候補がないときは `unknown` で、「近くにない」ではなく「データの中に見つかりません」「近くに避難場所がないという意味ではありません」と書きます。方位が取れない・古い・精度が悪い・値が揺れているときは、矢印を出さないことを結果で示します（誤った向きの矢印を出さないことを、正しい矢印を出すことより優先します）。
- **BW-S4**：心理・医療の助言にあたる処理はありません。
- 揺れの値は使いません。揺れから地震を判断しません。

## データ

`data/shizuoka_evac.json`：国土地理院「指定緊急避難場所データ」の静岡県分（2,885 か所、国土地理院の最終更新日 2026-10-27、取得日 2026-11-07）を加工したもの。作り方は [data/SOURCE.md](data/SOURCE.md)、利用条件の調べは [docs/research/evac_sites.md](../../docs/research/evac_sites.md)。

**データに欠けがありえます。** このデータには、市町村が登録し、公開に同意した指定緊急避難場所だけが含まれます。最新でない場合、載っていない場合があります。市町によって数に大きな差があり（熱海市 6 か所、長泉町 6 か所など）、登録されていない場所がある可能性があります。静岡県のデータだけなので、県境の近くでは隣の県の避難場所は出ません。最新の状況は市町村に確かめてください。

国土地理院の「ご利用上の注意」（このデータを使う人に正確に伝えることが求められています）：

1. 本データは、災害対策基本法第49条の4・第49条の7に基づき市町村長が指定した指定緊急避難場所・指定避難所の情報を各市町村に登録いただいたものです。なお、最新でない場合や未掲載の場合があるため、最新かつ詳細の状況などは必ず当該市町村にご確認ください。
2. 「指定緊急避難場所」と「指定避難所」の違いや、指定緊急避難場所が災害種別ごとに指定されていることを理解した上でご利用ください。
3. 本データは随時更新されますので、利用される場合は、ご注意ください。

（指定緊急避難場所は、災害の危険から命を守るために緊急的に避難する場所で、災害の種別ごとに指定されています。指定避難所は、災害の危険がなくなるまでの一時的な避難施設です。このモジュールは指定緊急避難場所だけを扱います。）

## 使い方

### Node.js

```js
import { loadEvacData, computeEvacDirections, siteCoordinates } from './modules/evac/node.js';

const data = await loadEvacData();
const r = computeEvacDirections(data, {
  latitude: 34.9769, longitude: 138.3831, accuracy: 30, // 静岡県庁のおよその位置
  hazard: 'tsunami',
});
// r.status === 'ok'
// r.value.candidates[0] → { name, municipality, distance_m, distance_text, bearing_deg, direction_text, arrow_deg: null, ... }

// 避難場所の公開された座標（地図アプリへのリンクと、避難場所の標高の取得に使う）。
// 結果には座標を入れないので（距離・方位と合わせると位置が分かるため）、必要なときだけ id で引く。
const site = siteCoordinates(data, r.value.candidates[0].id); // { latitude, longitude } または null
```

### ブラウザ

```js
import {
  loadEvacData, computeEvacDirections, createHeadingTracker, startOrientation,
  requestOrientationPermission, currentScreenAngle, declinationWestDeg, createExclusion,
} from './modules/evac/browser/load.js';

const data = await loadEvacData();            // 同じサイトの data/shizuoka_evac.json だけを読む
const tracker = createHeadingTracker();
button.addEventListener('click', () => {
  requestOrientationPermission().then(() => {}); // iPhone：await の前に呼ぶ
  startOrientation(tracker);
});
// 位置が取れたら（modules/sensors の位置のセンサーなど）
const heading = tracker.read({
  nowMs: Date.now(),
  screenAngleDeg: currentScreenAngle(),
  declinationWestDeg: declinationWestDeg(lat, lon),
});
const r = computeEvacDirections(data, {
  latitude: lat, longitude: lon, accuracy: acc, hazard: 'tsunami',
  heading, course: { heading_deg, speed_mps, at_ms }, exclusions,
});
```

### 入力

| 項目 | 意味 |
| --- | --- |
| `latitude`・`longitude` | 度。不正なときは `error` |
| `accuracy` | 位置の誤差の半径（メートル）。**必須**。ないときは `error`。上限（1000m、！！仮の値！！）を超えるときは `unknown` |
| `hazard` | 災害の種別のキー（下の表）。**必須**。ないとき・分からない種別のときは `error`（種別が分からないまま避難場所を選ばない） |
| `exclusions` | 「通れない」として除外する方向（`createExclusion()` で作る）。期限が過ぎたものは無視 |
| `heading` | `createHeadingTracker().read()` の結果（端末の画面の上が、真北から何度か）。なくてもよい（そのときは矢印なし） |
| `course` | GPS の進行方向と速さ `{ heading_deg, speed_mps, at_ms }`（Geolocation の `coords.heading`・`coords.speed`）。なくてもよい |
| `position_at_ms` | 位置を取った時刻（Geolocation の `timestamp`）。ない、または 15 秒（！！仮の値！！）より古いときは矢印なし |
| `compass_confirmed_at_ms` | `createCompassCheck()` が記録した、端末の方位と GPS の進行方向が一致した最後の時刻。精度が得られない方位（Android）で矢印を出すために要る |
| `source` | `"simulated"` にすると結果の `source` も `"simulated"` |

災害の種別のキー：`flood`（洪水）、`landslide`（崖崩れ、土石流及び地滑り）、`storm_surge`（高潮）、`earthquake`（地震）、`tsunami`（津波）、`large_fire`（大規模な火事）、`inland_flood`（内水氾濫）、`volcano`（火山現象）。

### 結果

共通の形（`kind`・`status`・`value`・`observed_at`・`source`・`detail`）で返します。`kind` は `"evac_direction"`、`source` は `"gsi"`（国土地理院のデータで計算）または `"simulated"`。

`value` の主な中身：

| 項目 | 意味 |
| --- | --- |
| `hazard` | `{ key, label }` |
| `candidates` | 近い順、最大 3 件（！！仮の値！！）。直線で 5km（！！仮の値！！）より遠い場所は入れない |
| `candidates[].name`・`municipality` | 避難場所の名前（データのまま）、市町 |
| `candidates[].distance_m`・`distance_text` | 直線距離（メートル）と「約 670 m」のような文 |
| `candidates[].bearing_deg`・`direction_text` | 真北から時計回りの方位（0〜360 未満）と「北から約 123 度（東南東）の方向」。位置の誤差の円の中にあるときは `null` と「方向を示せません」 |
| `candidates[].bearing_uncertainty_deg` | 位置の誤差による方位の幅（±度） |
| `candidates[].arrow_deg`・`arrow_reason` | 画面の上から時計回りに矢印を回す角度。矢印を出してはいけないときは `null` と理由 |
| `candidates[].course_relative_deg` | GPS の進行方向から見た向き（右が正）。動いていないときは `null` |
| `candidates[].hazards`・`remarks` | その場所が対応する災害の種別すべて、備考（「『洪水』では2階以上に避難」など） |
| `arrow` | `{ show, reason }`。端末の方位を矢印に使えるか |
| `heading` | 使った方位（画面の上の向き）、元の値の種類、精度が分かるか（`accuracy_known`） |
| `position_age_s` | 位置を取ってからの秒数 |
| `course` | `{ show, heading_deg, speed_mps, text }`。速さが 1.0m/s（！！仮の値！！）以上のときだけ `show: true` |
| `exclusions`・`excluded_count` | 有効な除外（方向・場所・期限）と、除外で外した場所の数 |
| `straight_line_note`・`coverage_note`・`notices`・`attribution`・`processed`・`data_updated` | 画面に出す注記、出典、データの更新日 |

**位置そのものは結果に入れません**（避難場所の座標も、位置から求めた偏角も、位置の誤差の値も入れません）。ただし、避難場所の名前と距離・方位からは、およその位置が分かります。結果も端末の外に送らないでください。

### 矢印を出す条件

次のすべてを満たすときだけ `arrow_deg` に値が入ります。1 つでも欠けたら、文（「北から○度の方向」）と北を上にした図だけにします。

1. 端末の方位が北を基準にした値である（iPhone の Safari の `webkitCompassHeading`、Android の Chrome の `deviceorientationabsolute`）。ふつうの `deviceorientation`（北を基準にしていない）は使わない。
2. 方位の値が新しい（2 秒以内、！！仮の値！！）。現在より 1 秒より先の時刻の値は使わない。
3. iPhone では `webkitCompassAccuracy` が 0 以上 20 度以下（！！仮の値！！）。負の値（校正が要る）は使わない。
4. **精度が得られない方位（Android）は、GPS の進行方向と一致してから 20 秒（！！仮の値！！）のあいだだけ使う。** 一致は、1.0m/s 以上で動いていて、端末の上の向きと GPS の進行方向の差が 20 度以内（！！仮の値！！）のとき（`createCompassCheck()`）。歩いているあいだは一致し続けている必要がある（外れたらすぐ矢印を消す）。方位の値が途切れたら一致の記録を消す。止まったままでは矢印を出さない。止まってからの 20 秒のあいだに方位が偏った場合は検出できない（残る危険。人が決める）。精度が分からない方位は、金属や車の近くで一定の向きにずれていても「安定している」ように見えるため。
5. 画面が上を向いていて、水平から 45 度以内（！！仮の値！！）。立てて持っているときは使わない。
6. 直近 1 秒（！！仮の値！！）の値が 3 個以上あり、平均からのずれが 20 度以内（！！仮の値！！）。iPhone 風の値と Android 風の値が混ざっているときも使わない。
7. **画面が縦向き**（`screen.orientation.angle`、なければ `window.orientation` が 0。どちらもなく縦長の画面なら 0 とみなす）。横向き・上下逆の計算は入れてあるが、符号を実機で確かめるまでは使わない（`HEADING_DEFAULTS.allowLandscape: false`、！！仮の値！！）。
8. 偏角が求められる（下）。
9. **位置が新しい**（位置を取った時刻から 15 秒以内、！！仮の値！！）。古い位置から計算した方向は、そのあと動いていればずれるため。
10. GPS で動いている（1.0m/s 以上）ときは、端末の方位と GPS の進行方向の差が 60 度以内（！！仮の値！！）。
11. その候補の方位の幅（位置の誤差による）が ±30 度以内（！！仮の値！！）。

### 方位の求め方

- **iPhone の Safari**：`webkitCompassHeading`（磁北から時計回り）をそのまま使う。
- **Android の Chrome**：`deviceorientationabsolute` の `alpha`（反時計回り、端末の上が北のとき 0）から `360 − alpha`。画面が上を向いている範囲（4）だけを使うので、この式で端末の上の向きになる。基準の北は磁北とみなしている（Android の回転ベクトルの座標系による。**実機で確かめる**）。Android の Chrome は、北を基準にしない `deviceorientation` も出すので、`deviceorientationabsolute` があるブラウザではそちらを無視する（`browser/orientation.js`）。
- **画面の回転**：画面の上の向き ＝ 端末の上の向き ＋ 画面の回転の角度（90 度は、端末を左に倒した横向き）。端末を傾けているときは、画面の上の軸を地面に投影した向きを使う。**符号は実機で確かめる**（docs/proto/evac.md）。確かめるまでは横向きで矢印を出さない（7）。
- **傾いた画面に描く矢印の角度**：画面は傾いているので、「方位の差」をそのまま矢印の角度にすると、上から見たときの向きがずれる（例：縦向きで 20 度傾けると、前後方向が cos 20° だけ縮んで見える）。画面の上に描いた矢印を真上から地面に投影した向きが、避難場所の方位に一致するように角度を求めている（`screenArrowDeg`）。テストで、W3C の回転（Rz(alpha)・Rx(beta)・Ry(gamma)）で端末の姿勢を作り、描いた矢印を地面に投影して確かめている（モジュールの式は使わない検算）。
- **偏角の補正**：真北からの方位 ＝ 磁北からの方位 − 偏角（西偏を正）。偏角は国土地理院の 2020.0 年値の近似式で求める。

  出典：国土地理院「近似式から求める」<https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html>

  D = 8°15.822′ + 18.462′Δφ − 7.726′Δλ + 0.007′(Δφ)² − 0.007′ΔφΔλ − 0.655′(Δλ)²（Δφ = 緯度 − 37°、Δλ = 経度 − 138°。西回りが正）

  地域的な磁気異常は反映されず、2020 年 1 月 1 日の値なので、今の値とはずれがあります。静岡県ではおよそ 7〜8 度（西偏）です。テストで、国土地理院のページの計算例（東京、7°36.5′）を再現しています。
- **GPS の進行方向**：Geolocation の `coords.heading`（真北から時計回り）。速さが 1.0m/s（！！仮の値！！）未満、または 10 秒（！！仮の値！！）より古いときは使わない。GPS の進行方向は、端末の方位を「確かめる」ために使う：一致すれば精度の分からない方位を一時的に使ってよいことにし（4）、大きく食い違えば矢印を消す（10）。GPS で方位を回して足し引きする補正はしない（端末を進行方向に向けているとは限らず、回すと誤った矢印を作りうるため）。位置が変わるたびに方位と距離は計算し直す（呼び出す側が位置の更新ごとに呼ぶ）。

### 「通れない」の除外

利用者が「この方向は通れない」を押したときに、呼び出す側が `createExclusion(今の第 1 候補の bearing_deg, 今の時刻, { siteId: 今の第 1 候補の id })` を作り、`exclusions` に入れて呼び直します。

- その方向の前後 30 度（！！仮の値！！）にある避難場所と、そのとき示していた避難場所そのものを、10 分（！！仮の値！！）のあいだ候補から外します。場所も外すのは、移動して方位が変わると、方向だけの除外では同じ場所が戻ってくるため。
- 結果の `exclusions` に、除外している方向と期限が入ります。画面はそれを出し、取り消し（リストから外して呼び直す）を用意します。
- 判断は利用者のものです。モジュールは道の状態を推定しません。
- 方位が分からない候補（位置の誤差の円の中）は、除外の対象にしません。

## 公的データが使えないときの案内先（`fallback.js`）

データを読めない、または候補が見つからないときに、画面がリンクとして出す先です。公的な先を先に、民間のサイトは「公的な発表ではありません」と添えて出します。位置などを URL に入れません。**どれを出すかは人が決めます（！！仮の値！！）。** 調べた内容は docs/research/evac_sites.md の 6 章。

## ファイル

| ファイル | 中身 | 読み込める場所 |
| --- | --- | --- |
| `evac.js` | データの準備、候補と方向の計算、除外 | ブラウザ・Node.js |
| `heading.js` | 端末の方位（iPhone・Android）、画面の回転、安定の検査、GPS の進行方向 | ブラウザ・Node.js |
| `geo.js` | 距離・方位・角度の計算、16 方位の名前、偏角 | ブラウザ・Node.js |
| `fallback.js` | 公的データが使えないときの案内先 | ブラウザ・Node.js |
| `index.js` | 上の 4 つをまとめて出す | ブラウザ・Node.js |
| `node.js` | データをファイルから読む | Node.js |
| `browser/load.js` | データを同じサイトから読む | ブラウザ |
| `browser/orientation.js` | 向きのイベントの受け取り、画面の回転、iPhone の許可 | ブラウザ（テストでは偽の window で動かす） |
| `data/shizuoka_evac.json`・`data/SOURCE.md` | データと、その出典・作り方 | — |
| `tools/build_evac_data.py` | データを作るスクリプト（Python 標準ライブラリだけ） | — |

外部ライブラリは使っていません。

## テスト

```bash
node --test 'modules/evac/test/*.test.js'
```

方位の計算（北・東・南・西、0 度と 360 度の境目）、偏角（国土地理院の計算例）、画面の回転、iPhone と Android の方位、方位が取れない・古い・精度が悪い・揺れているとき、災害の種別での絞り込み、除外（境目と 0/360 をまたぐ場合、期限切れ、すべて除外）、候補なし、位置の誤差、結果に位置が入らないこと、安全を言い切る言葉や「震度」がないことを確かめます。座標は架空の切りのよい点と、公共施設（県庁・市役所）のおよその位置だけです。

## 出典

出典：国土地理院ウェブサイト（指定緊急避難場所データ）<https://hinanmap.gsi.go.jp/index.html>

「指定緊急避難場所データ」（国土地理院）（<https://hinanmap.gsi.go.jp/index.html>）をもとに本プロジェクトが作成（静岡県分の抽出、項目の選択、災害の種別の符号化、座標の丸め）。国土地理院が作成したものではありません。

偏角：国土地理院「近似式から求める」（2020.0 年値）<https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html> の式を使用。

## 心理・医療の助言について

このモジュールは、心理（メンタルヘルス）と医療の助言に当たる処理を持ちません（BW-S4）。
