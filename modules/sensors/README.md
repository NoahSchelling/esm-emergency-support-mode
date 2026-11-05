# センサーのモジュール（modules/sensors/）

- 作成日：2026-11-05（日本時間）
- 状態：**試作**。実機ではまだ確かめていません（確かめるべき点は [docs/proto/sensors.md](../../docs/proto/sensors.md)）。

スマートフォンのウェブアプリで使う、センサーごとのモジュールです。画面は作っていません（試験用の最小のページだけ `demo/` にあります）。

## 安全の下限への対応

- **BW-S1**：揺れの値は**この端末が記録した生の値**です。「震度」とは呼びません。揺れの値から地震の発生や強さを判断する処理（しきい値、警報、通知）はありません。揺れの値を表示するときは、必ず `MOTION_LABEL`（「この端末が記録した揺れ（震度ではありません）」）を添えてください。結果の `value.label` と `detail` にも入っています。
- **BW-S2**：試験用のページの上に、公的な発表を優先する旨を出しています（文言は「！！仮の値！！」）。
- **BW-S3**：取れない・判定できないときは、`status` を `denied`・`unsupported`・`insecure`・`error`・`stale`・`unknown` で返し、`value` は `null` にします。値がないことを「異常なし」「安全」とは書きません。揺れの最大値も、期間内に値がなければ 0 ではなく `unknown` です。通信が「オンライン」でも、公的な情報源に届くとは限らない、と `detail` に書いています。
- **BW-S4**：心理・医療の助言にあたる処理はありません。
- 位置などの値を、端末の外に送る処理はありません。記録の仕組み（`recorder.js`）は、既定では位置を記録しません。

## ファイル

| ファイル | 中身 | 読み込める場所 |
| --- | --- | --- |
| `index.js` | すべてをまとめて出す入口。揺れと向きの許可をまとめて求める関数もある | ブラウザ・Node.js |
| `location.js` | 位置（Geolocation）。緯度・経度・誤差（メートル） | ブラウザ・Node.js |
| `motion.js` | 揺れ（DeviceMotion）。加速度と回転の生の値、一定時間の最大値 | ブラウザ・Node.js |
| `orientation.js` | 向き（DeviceOrientation） | ブラウザ・Node.js |
| `online.js` | 通信の有無（オンライン／オフラインの通知） | ブラウザ・Node.js |
| `network.js` | 通信の種類（Network Information） | ブラウザ・Node.js |
| `battery.js` | 電池（Battery Status） | ブラウザ・Node.js |
| `result.js` | 共通の結果の形、時刻の書き方 | ブラウザ・Node.js |
| `state.js`、`permission.js`、`env.js` | 内部の部品（値の保持と stale の判定、許可の求め方、端末とのつなぎ目） | ブラウザ・Node.js |
| `replay.js` | 記録した値を再生する仕組み（`source` は `"simulated"`） | ブラウザ・Node.js |
| `recorder.js` | 端末の生の値を、再生できる形で記録する | ブラウザ・Node.js |
| `fixtures/sample-session.json` | 再生用の架空のデータ（60 秒） | — |
| `tools/make-fixture.js` | 上のデータを作るスクリプト | Node.js |
| `demo/` | 試験用の最小のページ（**ブラウザ専用**） | ブラウザ |
| `test/` | 自動テスト（`node --test`）。`browser.test.js` は Playwright があるときだけ動く | Node.js |

外部ライブラリは使っていません。素の JavaScript（ES モジュール）です。モジュールは読み込んだ時点でブラウザの機能に触れないので、Node.js でも読み込めます。ブラウザの機能には `env`（端末とのつなぎ目）を通して触れます。

## 結果の形

すべての関数は、次の形の結果を返します（凍結したオブジェクト）。

```js
{
  kind:        'location',          // 結果の種類
  status:      'ok',                // ok | denied | unsupported | insecure | error | stale | unknown
  value:       { ... },             // status が ok のときだけ。それ以外は null
  observed_at: '2026-11-05T10:00:01.000+09:00', // 取得または判定した時刻（タイムゾーン付き）
  source:      'device',            // 端末の値は device、再生の値は simulated
  detail:      '端末が報告した位置です（誤差はおよそ 25 メートル）。',
}
```

| status | 意味 |
| --- | --- |
| `ok` | 値がある |
| `denied` | 利用者または画面の設定が許可していない |
| `unsupported` | 端末・ブラウザが対応していない（イベントは届いたが値が空、も含む） |
| `insecure` | HTTPS ではない画面（`isSecureContext` が false）。6 つのモジュールすべてで同じ扱い |
| `error` | 取得の途中で失敗した、値が不正だった |
| `stale` | 値が `staleAfterSec` 秒より長く更新されていない。古い値は返さない |
| `unknown` | まだ値がない、許可の結果が分からない、期間内に値がない |

## 使い方

```js
import {
  createLocationSensor, createMotionSensor, createOrientationSensor,
  createOnlineSensor, createNetworkSensor, createBatterySensor,
  requestMotionAndOrientationPermission, MOTION_LABEL,
} from './modules/sensors/index.js';

const location = createLocationSensor({ staleAfterSec: 120 });
const motion = createMotionSensor({ staleAfterSec: 2, historySec: 60 });
const orientation = createOrientationSensor();
const online = createOnlineSensor();
const network = createNetworkSensor();
const battery = createBatterySensor();

// iPhone の Safari：許可は、ボタンを押したときの処理の中で「直接」求める。
// この関数の前に await を書かないこと（操作から呼んだと見なされなくなる）。
button.addEventListener('click', () => {
  requestMotionAndOrientationPermission(motion, orientation).then(({ motion, orientation }) => {
    console.log(motion.status, orientation.status);
  });
  motion.start();
  orientation.start();
  location.start();          // 位置の許可の確認もここで出る
});

online.start();
online.subscribe((r) => console.log('通信', r.value?.online)); // online / offline の通知
network.start();
battery.start();             // Promise を返す

// stale は「読んだとき」に判定する。画面は定期的に read() を呼ぶ。
setInterval(() => {
  const r = motion.read();
  label.textContent = MOTION_LABEL;
  if (r.status === 'ok') show(r.value); else showStatus(r.status, r.detail);
}, 500);
```

### モジュールごとの関数

すべてに `read()`（今の結果を返す）、`subscribe(fn)`（値が変わったときに呼ぶ。戻り値は解除の関数）、`start()`、`stop()` があります。引数は 1 つのオブジェクトで、すべて省略できます。`env` を渡すと端末の代わりにそれを使います（再生用）。

| モジュール | 作る関数と引数 | ほかの関数 | value の中身 |
| --- | --- | --- | --- |
| 位置 | `createLocationSensor({ staleAfterSec = 120, enableHighAccuracy = true, timeoutSec = 30, maximumAgeSec = 0 })` | `locateOnce()`：1 回だけ取る（Promise。失敗しても reject せず結果を返す） | `latitude`、`longitude`、`accuracy_m`、`altitude_m`、`altitude_accuracy_m`、`heading_deg`、`speed_mps`（ないものは null） |
| 揺れ | `createMotionSensor({ staleAfterSec = 2, historySec = 60 })` | `requestPermission()`、`peak(windowSec)`：直近 windowSec 秒の最大値、`startPeakRecording()`：記録を始め、`.read()` で途中の値、`.stop()` で確定した値 | `acceleration`（x, y, z。m/s²）、`acceleration_including_gravity`、`rotation_rate`（alpha, beta, gamma。度/秒）、`interval_ms`、`label` |
| 揺れの最大値（`kind: "motion_peak"`） | — | — | `acceleration_max`、`acceleration_including_gravity_max`、`rotation_rate_max`（それぞれ軸ごとの絶対値の最大と `magnitude`＝大きさの最大）、`sample_count`、`from`、`to`、`first_sample_at`、`last_sample_at`、`label` |
| 向き | `createOrientationSensor({ staleAfterSec = 2, eventName = 'deviceorientation' })` | `requestPermission()` | `alpha_deg`、`beta_deg`、`gamma_deg`、`absolute`、`compass_heading_deg`、`compass_accuracy_deg`（後の 2 つは iPhone の Safari だけ） |
| 通信の有無 | `createOnlineSensor({ staleAfterSec = 60 })` | — | `online`（true / false） |
| 通信の種類 | `createNetworkSensor({ staleAfterSec = 60 })` | — | `type`、`effective_type`、`downlink_mbps`、`rtt_ms`、`save_data` |
| 電池 | `createBatterySensor({ staleAfterSec = 120 })` | `start()` は Promise を返す | `level`（0〜1）、`level_percent`、`charging`、`charging_time_sec`、`discharging_time_sec`（分からないときは null） |

- 既定の秒数（`staleAfterSec`、`historySec`、`timeoutSec`）は、すべて**！！仮の値！！**です。実機で決めます。
- 通信の有無・通信の種類・電池は、`read()` のたびに端末の今の値を読み直すので、ふつうは `stale` になりません。
- `requestPermission()` は、許可が要らない端末（Android の Chrome など）では `status: "ok"`、`value.permission: "not_required"` を返します。答えが `"prompt"`（許可を求める画面が出なかった）のときは `unknown` です。
- 揺れの最大値は、重力を差し引く計算をしていません。`acceleration` はブラウザが重力を除いた値、`acceleration_including_gravity` は重力を含む値です（含む方の大きさは、止まっていても約 9.8）。

## 再生で動かす（source は "simulated"）

```js
import { createReplayPlayer, createMotionSensor } from './modules/sensors/index.js';

const player = createReplayPlayer(recording);   // 手動の時計。advance するまで何も起きない
const motion = createMotionSensor({ env: player.env });
motion.start();
await motion.requestPermission();               // 記録の environment が "prompt" なら必要
player.advanceTo(21_000);                       // 記録の先頭から 21 秒まで進める
motion.read();                                  // source: "simulated"
```

- ブラウザでは `player.playRealtime({ speed: 1 })` で実時間で再生できます（戻り値は止める関数）。
- 記録の形（`format: "sensor-recording/1"`）は `replay.js` の先頭に書いています。`environment` で、HTTPS かどうか、どの機能があるか、許可の状態（`granted`・`denied`・`prompt`・`not_required`）を決められます。`prompt` は iPhone の Safari のように、`requestPermission()` を呼ぶまで揺れと向きのイベントが届きません。
- `fixtures/sample-session.json` は、`tools/make-fixture.js` で作った**架空のデータ**です（位置は架空の座標、揺れは合成した波で、地震の記録ではありません）。作り直すとき：`node modules/sensors/tools/make-fixture.js`
- 端末で記録するとき：`createRecorder({ env })` を作り、`stop()` で記録を受け取ります。**位置は既定では記録しません。** `includeLocation: true` で記録した実際の位置は、リポジトリに入れないでください（架空の座標に置き換えてから入れる）。

## テスト

```bash
node --test 'modules/sensors/test/*.test.js'
```

- Node.js 22 で確かめました。`browser.test.js` は Playwright（Chromium）があるときだけ動き、ないときは飛ばします。
- `browser.test.js` は、テストの中で一時的なサーバーを立て、試験用のページを開きます。位置の偽装、`DeviceMotionEvent` と `DeviceOrientationEvent` の発火、オフラインの切り替え、許可がないとき、HTTPS でないとき（LAN のアドレスで開く）、再生を確かめます。

## 試験用のページ

リポジトリの一番上で、

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

を実行し、`http://127.0.0.1:8000/modules/sensors/demo/` を開きます（`127.0.0.1` と `localhost` は HTTPS と同じ扱いになります）。スマートフォンの実機で開くときは HTTPS が必要です（HTTP の LAN アドレスで開くと、すべて `insecure` になります）。
