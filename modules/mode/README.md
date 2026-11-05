# modules/mode：緊急支援モードの状態機械

緊急支援モードの状態（平常／警戒高め／緊急、緊急の中の段階）を切り替える部品です。

- **入力は、公的な発表・利用者の申告・時間の経過だけです。** 発表の中身から危険度を独自に推定しません（BW-S1）。発表の「種類」（と震度の値）を、決められた表に当てはめるだけです。
- **「平常」は「安全」という意味ではありません。** 「新しい公的発表を受けていない」状態です（BW-S3）。解除・取消を受けても、自動で平常には戻しません。
- **段階は名前を返すだけです。** 段階に応じた心理的な対応・医療の助言は実装していません（BW-S4）。将来のために `supportFor()` という差し込み口だけを置いていて、いつも `status: "unsupported"` を返します。
- 公的情報を優先してください。この部品の状態は、気象庁・自治体などの公的な発表と指示の代わりにはなりません。

素の JavaScript（ES モジュール）で、外部ライブラリは使いません。Node.js の API もブラウザの API も使っていないので、どちらでも読み込めます（ブラウザ専用の部分はありません）。

## ファイル

| ファイル | 中身 |
| --- | --- |
| `index.js` | 入口。下の 3 つから公開する関数をまとめて出す |
| `machine.js` | 状態機械（`initialState`、`step`、`run`、`current`、`supportFor`） |
| `categories.js` | 発表の種類と規則（強い・弱い・下限）の対応表 |
| `config.js` | 設定（段階の名前と数、段階の時間、下限の期間など）と既定値 |
| `test/` | テスト（`node --test`） |

## 使い方

```js
import { initialState, step, createConfig } from "./modules/mode/index.js";

let state = initialState("2026-11-05T10:00:00+09:00");

const out = step(state, {
  type: "public",
  id: "eew-20261105-001",
  category: "eew_warning",
  at: "2026-11-05T10:00:05+09:00",
  source: "simulated",
});
state = out.state;          // 新しい状態（前の状態は変更しない）
console.log(out.result);    // 共通の形の結果
console.log(out.records);   // どの入力で何が変わったかの記録
```

`step(前の状態, イベント, { config, now })` は、前の状態とイベントから新しい状態を返す関数です。前の状態は書き換えません（返す状態は凍結してあります）。同じ入力には同じ出力を返します。`now` は、イベントの時刻が読めず `error` を返すときの `observed_at` にだけ使います。

`run(状態, イベントの配列, { config })` は、イベントを順に `step` に通します（再生やテスト用）。`current(状態)` は、イベントを与えずに今の状態を共通の形で返します。

### イベント

時刻 `at` は、タイムゾーン付きの ISO 8601 です（なければ `error`）。

| `type` | 項目 | 意味 |
| --- | --- | --- |
| `public` | `id`、`category`、`at`、`source`、（震度のとき）`intensity` | 公的発表を受けた |
| `public_end` | `target_id`、`reason`（`"lift"` 解除／`"cancel"` 取消）、`at`、`source` | 公的発表の解除・取消 |
| `user` | `request`、`at`、（省略時 `"user"`）`source` | 利用者の申告 |
| `tick` | `at`、（省略時 `"clock"`）`source` | 時間の経過 |

- `public` と `public_end` は `source` が必須です（例 `"jma"`）。`"user"` は使えません。`user` の `source` は `"user"` か `"simulated"` だけです。模擬データ・再生データは `"simulated"` にします。
- 同じ発表の続報（緊急地震速報の第 2 報など）は、同じ `id` で渡してください。種類と震度が同じなら「受け済み」として扱い、モードを変えません。種類か震度が変わっていれば（警報から大津波警報へ、など）、前の内容と置き換えて、新しく受けた発表として規則に当てはめます。
- 時間の経過による変化（段階が進む、設定した下限の期間が過ぎる）は、どの種類のイベントを受けたときにも、そのイベントの時刻で先に当てはめます。記録の原因には、そのイベントを書きます。画面の段階を新しく保つには、定期的に `tick` を送ってください。
- 前の状態の時刻より前の `tick`、対象の発表を受けた時刻より前の解除・取消は `stale` を返し、従いません。公的発表と申告は、時刻が前後していても受けます（公的発表を捨てないため）。

`category` と規則の対応（`categories.js`）：

| `category` | 発表 | 強さ | 下限 |
| --- | --- | --- | --- |
| `eew_warning` | 緊急地震速報（警報） | 強い（規則 1） | なし |
| `tsunami_warning` | 津波警報 | 強い | あり（規則 3） |
| `major_tsunami_warning` | 大津波警報 | 強い | あり |
| `special_warning` | 特別警報 | 強い | あり |
| `j_alert` | J アラート | 強い | なし |
| `eew_forecast` | 緊急地震速報（予報） | 弱い（規則 2） | なし |
| `warning` | 警報 | 弱い | なし |
| `intensity` | 震度の観測。`intensity` は `"0"`〜`"4"`、`"5-"`、`"5+"`、`"6-"`、`"6+"`、`"7"` | 震度3以上で弱い | 震度6弱以上であり |

表にない `category`、読めない `intensity` は `unknown` を返し、モードは変えません（「判定できない」を「異常なし」にしない）。震度 2 以下の観測は規則の対象外として受け、モードは変えません。

利用者の申告 `request`：

| `request` | 申告 | 動き |
| --- | --- | --- |
| `no_emergency` | 緊急にしない | 緊急なら警戒高めにする。新しい強い公的発表を受けたら、また緊急に移る |
| `set_elevated` | 警戒高めにして | 警戒高めにする |
| `set_normal` | 平常に戻して | 平常にする。下限に当たるときは `denied` と理由を返し、従わない |
| `set_emergency` | 緊急にして | 緊急にする（段階 1 から）。この緊急は、解除・取消では下げない |

### 結果

```js
{
  kind: "mode",
  status: "ok" | "denied" | "unknown" | "stale" | "error",
  value: {               // status が "ok" のときだけ。それ以外は null
    mode: "normal" | "elevated" | "emergency",
    mode_label: "平常" | "警戒高め" | "緊急",
    stage: 1..N | null,  // 緊急のときだけ
    stage_label: "発災直後" など | null,
    stage_count: N,
    emergency_by: "public" | "user" | null,
    floor_active: true | false,
    floor_reasons: [{ id, label }],
    active_announcements: [{ id, label, strength }],
    changed: true | false
  },
  observed_at: イベントの時刻,
  source: イベントの source,
  detail: "人が読む日本語"
}
```

- `denied`：下げる申告が下限に当たった。理由（どの発表による下限か）を `detail` に書く。状態は変えない。
- `unknown`：発表の種類や震度が表にない、解除の対象を受けた記録がない、申告が一覧にない。状態は変えない。
- `stale`：時刻が古い入力（上の「イベント」を参照）。状態は変えない。
- `error`：イベント、前の状態、設定の形が正しくない。状態は変えない。

### 記録（規則 7）

`records` は、その入力で起きたことを 1 件ずつ並べた配列です。モードや段階が変わったとき、下限の期間が過ぎたとき、申告を断ったとき、判定できなかったとき、古い解除・取消を断ったときに記録を返します（何も変わらない `tick` は記録を返しません）。

```js
{
  at: イベントの時刻,
  rule: "R1"〜"R7" または "-",
  from: { mode, stage },
  to:   { mode, stage },
  changed: true | false,
  outcome: "applied" | "updated" | "denied" | "duplicate" | "unknown" | "stale" | "floor_expired",
  cause: { type, source, at, id?, category?, intensity?, target_id?, reason?, request? },
  detail: "人が読む日本語"
}
```

保存は呼び出す側の役目です。人があとで確かめられるように、記録を捨てずに残してください。

## 設定

```js
const config = createConfig({
  stages: ["段階1", "段階2", "段階3", "段階4", "段階5", "段階6"], // 6 段階案
  stageHours: [0.25, 6, 72, 336, 4380],  // 段階 i から i+1 へ進むまでの時間。stages の数 - 1 個
  intensityFloorHours: null,             // 震度6弱以上の下限の期間。null は取消まで
  onEndInEmergency: "to_elevated",       // 緊急中の解除・取消："to_elevated" か "keep"
});
step(state, event, { config });
```

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `stages` | 7 段階（発災直後〜長期支援） | 段階の名前。数も変えられる。6 段階案の中身は決まっていない |
| `stageHours` | 0.25、6、72、336、2160、8760 時間（！！仮の値！！） | 段階が進むまでの時間。緊急に入った時刻から測る |
| `intensityFloorHours` | `null`（！！仮の値！！） | 震度の観測には「解除」がないため、下限をいつまで保つか |
| `onEndInEmergency` | `"to_elevated"`（！！仮の値！！） | 解除・取消で緊急から警戒高めに下げるか |

設定の値が正しくないと、`createConfig` が例外を投げます。`step` に渡した設定も中で検査し、正しくなければ `error` を返します。前の状態の段階が設定の段階の数を超えるときも `error` です。

既定値が仮の値になっている理由と、規則どうしが衝突する場面は [docs/proto/mode.md](../../docs/proto/mode.md) に書いています。

## テスト

リポジトリの一番上で：

```bash
node --test 'modules/mode/test/*.test.js'
```

- `test/rules.test.js`：規則 1〜7 のそれぞれと、純粋な関数であること・誤った入力の扱い。独立した突き合わせで見つかった食い違いの再発防止のテストも含む。
- `test/scenarios.test.js`：強い発表 → 解除 → 利用者が平常に戻す／津波警報の間に「平常に戻して」（下限で止まる）／弱い発表が続く（緊急に上がらない）／取消（誤報）。

テストのイベントはすべて架空のもので、`source` は `"simulated"` です。
