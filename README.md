# hackathon_tomato

## 公的情報を優先してください

！！仮の値！！ このリポジトリの成果物は、気象庁などの公的な発表を中継するだけのものです。独自の予報・警報は出しません。避難や身の安全にかかわる判断は、気象庁・自治体などの公的な発表と指示を優先してください。成果物の表示は、古い・止まっている・間違っている可能性があります。

## 試作

- 試作 C-A（公的発表の受信状況を見せる画面）：[docs/proto/c-a.md](docs/proto/c-a.md)
- 試作 C-B（発表文の平易な言い換えと、原文との照合）：[docs/proto/c-b.md](docs/proto/c-b.md)。言い換えは原文を加工したもので、気象庁の発表ではありません。照合を通っても正しさは保証されません。
- センサーのモジュール（位置・揺れ・向き・通信の有無・通信の種類・電池）：[modules/sensors/README.md](modules/sensors/README.md)。揺れの値は端末が記録した生の値で、震度ではありません。地震の発生や強さは判断しません。
- スマートフォン向けの簡易な画面（モジュールを組み合わせて見せる）：[app/README.md](app/README.md)。実機で確かめる点は [docs/proto/app.md](docs/proto/app.md)。公的発表は試作 C-A から取り次ぎ、つながらないときは「模擬データ」と表示します。

## モジュール

- 区域の判定（緯度・経度から、市町村と気象庁の警報・注意報の区域のコードを端末の中で引く。静岡県のみ）：[modules/area/README.md](modules/area/README.md)。区域を引くだけで、警報の有無は判定しません。「判定できない」は「安全」ではありません。
- 緊急支援モードの状態機械（平常／警戒高め／緊急と、緊急の中の段階）：[modules/mode/README.md](modules/mode/README.md)。入力は公的な発表と利用者の申告だけで、独自の判断はしません。「平常」は「安全」という意味ではありません。規則どうしの衝突と未決事項は [docs/proto/mode.md](docs/proto/mode.md)。
- 避難場所への直線の方向（国土地理院の指定緊急避難場所データから、災害の種別に対応した避難場所の近い順の候補と、直線距離・真北からの方位を端末の中で求める。静岡県のみ）：[modules/evac/README.md](modules/evac/README.md)。道順ではありません。安全かどうか、通れるかどうかは判断しません。データには市町村が登録し公開に同意した場所だけが含まれ、欠けがありえます。実機で確かめる点は [docs/proto/evac.md](docs/proto/evac.md)。
- 外枠のレベル（公的発表の種類を色にし、津波警報の中で海岸線の近くにいるときは点滅させる）：[modules/alert/README.md](modules/alert/README.md)。独自の予報・警報は出しません。色がないことは安全という意味ではありません。メニューとデモモード（静岡県の模擬、福島県・千葉県・東京都の過去の記録の再生）は [docs/proto/alert.md](docs/proto/alert.md)。

## 開発に参加する人へ

このリポジトリは、認証情報と個人情報が入らないように、コミットとプッシュのたびに検査します。クローンしたら、最初に次を実行して Git のフックを有効にしてください（Git の仕組み上、クローンしただけではフックは動きません）。

```bash
git config core.hooksPath .githooks
```

- 必要なもの：bash 4.4 以上と git。macOS に最初から入っている bash は 3.2 なので、Homebrew などで新しい bash を入れてください。python3 があると、検査の一部（表記ゆれ、符号化した値）が強くなります。
- 個人語（本名など）の検査には、リポジトリの外に置いた禁止語ファイルを環境変数 `ESM_DENYLIST_FILE` で指定します。書き方と仕組みの詳細は [CLAUDE.md](CLAUDE.md) の「開発基盤」にあります。
- 検査のテスト：`bash tests/check-secrets.test.sh`
- 公開前の最終確認（全履歴・すべてのブランチとタグ）：`scripts/check-secrets.sh --all --require-denylist`

## 外部データの出典

| データ | 出典 | 扱い |
| --- | --- | --- |
| 防災情報 XML（Atom フィードと電文） | 気象庁 | 試作 C-A が動いているあいだに取得して表示する。リポジトリには保存していない。 |
| 防災情報 XML のサンプル（地震情報 1 件、気象警報 1 件、Atom フィード 1 件。加工なし） | 出典：気象庁ホームページ（取得元の URL は `data/samples/README.md`） | 調査用に `data/samples/` に保存している。 |
| 防災情報 XML の電文（地震情報 4 件、気象警報・注意報 3 件。加工なし） | 出典：気象庁ホームページ（取得元の URL は `proto/c-b/bulletins/README.md`） | 試作 C-B の言い換えの例文と照合に使うため、`proto/c-b/bulletins/` に保存している。画面での言い換えと原文の切り出しは、本プロジェクトが加工して作成したもの。 |
| キキクルの時刻の一覧（1 件。加工なし） | 出典：気象庁ホームページ（取得元の URL は `data/samples/README.md`） | 調査用に `data/samples/` に保存している。 |
| 暑さ指数（WBGT）の地点別予測値（1 件。加工なし） | 出典：環境省熱中症予防情報サイト（環境省）（取得元の URL は `data/samples/README.md`） | 調査用に `data/samples/` に保存している。提供期間が終わったあとの古いデータ。 |
| 重ねるハザードマップの WMTS メタデータ（1 件。加工なし） | 出典：「ハザードマップポータルサイト」（取得元の URL は `data/samples/README.md`） | 調査用に `data/samples/` に保存している。 |
| 予報区等 GIS データ（静岡県分。市町村等（気象警報等）・市町村等（地震津波関係）・府県予報区等）と、防災情報 XML の個別コード表 | 出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）。気象庁「予報区等GISデータ」を加工して作成（加工と編集の責任は本プロジェクト）。GIS データは国土地理院長の承認を得て作成されたもの（承認番号は `modules/area/data/SOURCE.md`） | `modules/area/data/shizuoka.json` に、切り出し・簡略化・座標の丸めをして保存している。手順と簡略化による誤判定の恐れは `modules/area/data/SOURCE.md`。 |
| 指定緊急避難場所データ（静岡県分） | 出典：国土地理院ウェブサイト（指定緊急避難場所データ）<https://hinanmap.gsi.go.jp/index.html>。「指定緊急避難場所データ」（国土地理院）をもとに本プロジェクトが作成（加工と編集の責任は本プロジェクト。国土地理院が作成したものではありません）。市町村が登録し、公開に同意したものだけが含まれ、最新でない場合や載っていない場合があります | `modules/evac/data/shizuoka_evac.json` に、静岡県分の抽出・項目の選択・座標の丸めをして保存している。手順と国土地理院の「ご利用上の注意」は `modules/evac/data/SOURCE.md`、利用条件の調べは `docs/research/evac_sites.md`。 |
| 偏角の近似式（2020.0 年値） | 国土地理院「近似式から求める」<https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html> | 式の係数だけを `modules/evac/geo.js` で使っている。 |
| 予報区等 GIS データ「津波予報区」（静岡県・福島県・千葉県・東京湾内湾の線） | 出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）。気象庁「予報区等GISデータ」をもとに本プロジェクトが作成 | `modules/alert/data/coast.json` に、抽出・簡略化・座標の丸めをして保存している。手順は `modules/alert/data/SOURCE.md`。 |
| デモで再生する過去の公的発表の時刻と名前（2011 年 東北地方太平洋沖地震、2019 年 房総半島台風、2019 年 東日本台風） | 気象庁・内閣府・千葉県・千葉市・練馬区の公表資料（一覧は `docs/research/demo_records.md`） | 時刻・名前・数値だけを `app/shell/demos.js` に書いている。文章は写していない。自治体の資料の利用条件は未確認。 |

気象庁のデータの利用条件は `docs/research/jma_data.md` の 4 章に、気象庁防災情報 XML 以外の公的な防災データの取得方法と利用条件は `docs/research/other_data.md` に、指定緊急避難場所データは `docs/research/evac_sites.md` にまとめています。

試作 C-A の模擬データは、プログラムが作る架空のデータで、外部から持ち込んだものではありません。センサーのモジュールの再生用データ（`modules/sensors/fixtures/`）も、スクリプトで作った架空のデータです。
