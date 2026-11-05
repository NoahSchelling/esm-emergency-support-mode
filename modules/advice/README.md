# modules/advice：助言の入口（インターフェースのみ）

## 方針（BW-S4）

このリポジトリは、**メンタルヘルスの助言も、医療の助言も実装しません**。このモジュールは、将来それを足すことになった場合に備えた「入口」だけを用意します。助言の中身（文面、判定、提供元）は、1 つも入っていません。

## 公的情報を優先してください

！！仮の値！！ 避難や身の安全にかかわる判断は、気象庁・自治体などの公的な発表と指示を優先してください。このモジュールが将来何かを返すようになっても、それは公的な発表ではありません。

## 今の動き

提供元が 1 つもないので、どんな問い合わせにも `unsupported` を返します。

```js
import { requestAdvice } from './modules/advice/index.js';

const r = await requestAdvice({ topic: 'mental-health' });
// { kind: 'advice', status: 'unsupported', value: null, source: 'device',
//   detail: 'このアプリは、メンタルヘルスの助言も医療の助言も行いません。…', … }
```

- `topic` は `'mental-health'` か `'medical'`。それ以外、形の違う問い合わせも `unsupported`。
- 返り値は共通の形（`kind` / `status` / `value` / `observed_at` / `source` / `detail`）。`value` は `ok` のときだけ。
- 画面に出す側は、`unsupported` のとき `detail`（方針の説明）をそのまま出せる。助言のように見える言葉を足さないこと。
- 断片入力の解析（`modules/fragment/`）は、このモジュールを呼ばない。利用者の入力の文面や位置は、ここに渡さない（問い合わせに入るのは `topic` だけ）。

## 将来、提供元を足すときの約束

提供元の追加は、**先に設計を見直してから**にします（手順は [docs/proto/advice-interface.md](../../docs/proto/advice-interface.md)）。足すときは、次の形を満たす必要があります。

```js
const provider = {
  id: 'example',                 // 提供元の識別子
  topics: ['mental-health'],     // 扱う topic
  provide: async ({ topic }) => ({   // 受け取るのは topic だけ
    kind: 'advice', status: 'ok',
    value: { text: '…', officialInformationFirst: true, notAnnouncement: true },
    observed_at: '2026-11-05T18:00:00+09:00',
    source: 'example',           // 自分の id（模擬は 'simulated'）
    detail: '…',
  }),
};
const gateway = createAdviceGateway({ providers: [provider] });
```

門（ゲートウェイ）は、提供元の結果を次の点で検査し、満たさなければ `error` に置き換えて、助言を返しません。

| 検査 | 理由 |
| --- | --- |
| 共通の形、`kind` が `advice`、`status` の値、`observed_at` がタイムゾーン付き | 結果の形をそろえる |
| `source` が `jma` `user` `device` でない | 公的な発表や利用者の申告に見せかけない（BW-S1） |
| `source` が提供元の `id`（または `simulated`） | 出どころを偽らない |
| `ok` のとき `value.text` があり、`officialInformationFirst` と `notAnnouncement` が `true` | 公的情報の優先と、公的発表でないことを示す（BW-S1、BW-S2） |
| 「安全です」「異常なし」などの言い切りがない | 「新しい発表がない」を安全と読ませない（BW-S3） |
| `ok` でないとき `value` が `null` | 取れないものを値にしない |

検査は最低限の機械的なものです。**通ったことは、助言が適切であることを意味しません。**

## テスト

```bash
node --test modules/advice/test/*.test.js
```

テストに出てくる提供元は、文面が「！！仮の値！！」の試験用の模擬で、助言ではありません。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.js` | 公開の入口 |
| `gateway.js` | 門。既定は提供元なしで `unsupported` |
| `contract.js` | 提供元が満たす約束と、その検査 |
| `test/advice.test.js` | テスト |
