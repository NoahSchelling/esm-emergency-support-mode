# shizuoka_evac.json の出典と作り方

## 出典

出典：国土地理院ウェブサイト（指定緊急避難場所データ）<https://hinanmap.gsi.go.jp/index.html>

「指定緊急避難場所データ」（国土地理院）（<https://hinanmap.gsi.go.jp/index.html>）をもとに本プロジェクトが作成（静岡県分の抽出、項目の選択、災害の種別の符号化、座標の丸め）。国土地理院が作成したものではありません。加工したものの編集責任は本プロジェクトにあります。

利用条件：国土地理院コンテンツ利用規約（<https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html>。公共データ利用規約 第 1.0 版）と、次の「ご利用上の注意」（<https://www.gsi.go.jp/bousaichiri/hinanbasho-menseki.html>）。調べた内容は `docs/research/evac_sites.md`。

## ご利用上の注意（国土地理院の記載を書き写したもの）

1. 本データは、災害対策基本法第49条の4・第49条の7に基づき市町村長が指定した指定緊急避難場所・指定避難所の情報を各市町村に登録いただいたものです。なお、最新でない場合や未掲載の場合があるため、最新かつ詳細の状況などは必ず当該市町村にご確認ください。
2. 「指定緊急避難場所」と「指定避難所」の違いや、指定緊急避難場所が災害種別ごとに指定されていることを理解した上でご利用ください。
3. 本データは随時更新されますので、利用される場合は、ご注意ください。
4. 本データを用いた情報を第三者に提供する場合は、上記1．～3．の注意事項が正確に伝わるよう、十分にご留意ください。

**このデータには、市町村が登録し、公開に同意した指定緊急避難場所だけが含まれます。** 載っていない場所がありえます。データの中に見つからないことは、近くに避難場所がないことを意味しません。

## 元にしたファイル

2026-11-07 03:24（日本時間）ごろに取得した。元のファイルはリポジトリに入れていない（JSON の中に、CSV の SHA-256 を記録している）。

| 使い道 | ファイル | 取得元 URL |
| --- | --- | --- |
| 避難場所の名前・座標・災害の種別・備考 | `22000_2.csv`（静岡県の指定緊急避難場所。UTF-8・BOM 付き、2,885 か所、`Last-Modified: Mon, 02 Nov 2026 07:19:23 GMT`） | <https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/22000_2.csv> |
| 静岡県のデータの最終更新日（`source.gsi_updated`） | `prefectureListData.csv` | <https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/publicHistoryCSV/prefectureListData.csv> |
| 市町のコードと名前、市町ごとの最終更新日 | `publicHistoryListData.csv` | <https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/publicHistoryCSV/publicHistoryListData.csv> |

## 作り直す手順

Python 標準ライブラリだけで動きます。ダウンロードしたファイルは信頼できないデータとして扱い、リポジトリの外の空のディレクトリに置き、Python は `-I` で動かします。

```bash
python3 -I modules/evac/tools/build_evac_data.py --fetch /path/to/empty-dir
```

```bash
python3 -I modules/evac/tools/build_evac_data.py \
  --csv /path/to/empty-dir/22000_2.csv \
  --pref-list /path/to/empty-dir/prefectureListData.csv \
  --muni-list /path/to/empty-dir/publicHistoryListData.csv \
  --retrieved 2026-11-07 \
  --csv-last-modified "Mon, 02 Nov 2026 07:19:23 GMT" \
  --out modules/evac/data/shizuoka_evac.json
```

- 同じ入力と引数からは、同じ中身（バイト単位で同じ）の JSON ができます（2 回作って比べて確かめた）。日付は引数で渡すので、実行した日によって変わりません。
- CSV の列が想定と違う、共通 ID の形が違う、市町のコードが一覧にない、災害の種別の値が「1」と空以外、のときは止まります。
- 座標が数値でない、県のおおよその範囲（北緯 34.4〜35.8 度、東経 137.3〜139.3 度）の外、災害の種別が 1 つもない行は、落として理由を出します（この版では 0 件）。

## 加工の内容

1. 列の名前が想定どおりかを確かめる（`NO, 共通ID, 施設・場所名, 住所, 洪水, 崖崩れ、土石流及び地滑り, 高潮, 地震, 津波, 大規模な火事, 内水氾濫, 火山現象, 指定避難所との住所同一, 緯度, 経度, 備考`）。
2. 使う項目：共通 ID、施設・場所名、市町（共通 ID の 2〜6 文字目のコードで、市町ごとの一覧から名前を引く）、緯度、経度、災害の種別、備考。住所・「指定避難所との住所同一」・NO は入れていない（画面に出さないため）。
3. 名前と備考は、前後の空白を取り、備考の中の改行を空白にしただけで、言い換えていない。
4. 災害の種別は、8 つの列を `hazards` の順の「1」「0」の文字列にした（例：`"11111110"` は火山現象以外）。
5. 座標は小数 6 桁（約 0.1m）に丸めた。
6. 共通 ID の順に並べた。

## JSON の形（`format: "evac-sites/1"`）

| 項目 | 中身 |
| --- | --- |
| `source` | 出典の URL、取得日（`retrieved`）、国土地理院の最終更新日（`gsi_updated`）、元の CSV の `Last-Modified` と SHA-256 |
| `attribution`・`processed` | 画面に出す出典と加工の表記 |
| `notices` | ご利用上の注意（上の 1〜4 の原文） |
| `coverage_note` | 「登録し公開に同意したものだけ」の説明（画面に出す） |
| `hazards` | 災害の種別のキーと名前（順番が `sites` の `hazards` の文字の順） |
| `municipalities` | 市町のコード → 名前、国土地理院の市町ごとの最終更新日、か所の数 |
| `fields`・`sites` | 1 行 1 か所：`[共通ID, 名前, 市町のコード, 緯度, 経度, 災害の種別, 備考]` |

災害の種別のキー：`flood`（洪水）、`landslide`（崖崩れ、土石流及び地滑り）、`storm_surge`（高潮）、`earthquake`（地震）、`tsunami`（津波）、`large_fire`（大規模な火事）、`inland_flood`（内水氾濫）、`volcano`（火山現象）。

## 大きさ

約 270KB（gzip で約 65KB）。画面は、開いたときに一度だけ読み、開いているあいだは持ち続けます（位置が変わるたびに読み直さない）。発災の前に一度開いておけば、ブラウザのキャッシュに残る場合がありますが、残るかどうかはブラウザと配信の設定によります（**未確認**）。
