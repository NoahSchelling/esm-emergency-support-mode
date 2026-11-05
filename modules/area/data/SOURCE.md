# shizuoka.json の出典と作り方

## 出典

出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）

気象庁「予報区等GISデータ」（<https://www.data.jma.go.jp/developer/gis.html>）と、気象庁防災情報 XML の「個別コード表」（<https://xml.kishou.go.jp/tec_material.html>）を加工して作成。加工したのは本プロジェクト（hackathon_tomato）で、加工したものの編集責任は本プロジェクトにあります。気象庁が作ったものではありません。

GIS データのページには次の記載があり、そのまま書き写します。

> この地図の作成に当たっては、国土地理院長の承認を得て、同院発行の数値地図25000（空間データ基盤）、数値地図（国土基本情報）、電子国土基本図（地図情報）を使用した。
> （承認番号　平30情使 第401号・令２情使 第125号・令３情使 第90号・令３情使 第123号・令３情使 第648号・令４情使 第437号・令５情使 第71号・令６情使 第382号・令７情使 第395号）

利用条件：気象庁ホームページ 利用規約 <https://www.jma.go.jp/jma/kishou/info/coment.html>（公共データ利用規約 第 1.0 版に準拠）。調べた内容は `docs/research/jma_data.md` の 9 章。

## 元にしたファイル

どれも 2026-11-05 14:31（日本時間）ごろに取得した。ファイルが大きい（100〜150MB）ので、リポジトリには入れていない。

| 使い道 | ファイル | 取得元 URL |
| --- | --- | --- |
| 警報・注意報の「市町村等」の境界とコード・名前（`layers.city`） | `20260226_AreaInformationCity_weather_GIS.zip`（市町村等（気象警報等）。2026 年 5 月下旬以降の体系整理に伴う発表区域変更後のデータ） | <https://www.data.jma.go.jp/developer/gis/20260226_AreaInformationCity_weather_GIS.zip> |
| 市町村（政令指定都市は区）の境界とコード・名前（`layers.municipality`） | `20241128_AreaInformationCity_quake_GIS.zip`（市町村等（地震津波関係）） | <https://www.data.jma.go.jp/developer/gis/20241128_AreaInformationCity_quake_GIS.zip> |
| 県の外形（`layers.prefecture`） | `20190125_AreaForecastLocalM_prefecture_GIS.zip`（府県予報区等） | <https://www.data.jma.go.jp/developer/gis/20190125_AreaForecastLocalM_prefecture_GIS.zip> |
| 上位の区域の確認だけに使用（JSON には入れていない） | `20230517_AreaForecastLocalM_matome_GIS.zip`（市町村等をまとめた地域等）、`20190125_AreaForecastLocalM_1saibun_GIS.zip`（一次細分区域等） | 同じページ |
| 「市町村等」から上位の区域への対応（`layers.city.features[].group` と `groups`） | `jmaxml_20261104_Code.zip` の中の `20261019_AreaInformationCity-AreaForecastLocalM.xlsx`（シート「AreaInformationCity」の「属する『市町村等をまとめた地域等』」の列と、シート「AreaForecastLocalM（関係表　警報・注意報）」） | <https://xml.kishou.go.jp/jmaxml_20261104_Code.zip> |

## 加工の内容

変換は `modules/area/tools/build_area_data.py`（Python 標準ライブラリだけ）で行った。

1. 各 zip のシェープファイル（.shp・.dbf）を読み、コードが静岡県（22）で始まるものだけを取り出す。dbf の文字コードは UTF-8 だった。
2. 名前とコードは dbf の値をそのまま使う（`regioncode`→`code`、`name`→`name`、`regionname`→`region_name`、`namekana`→`kana`）。言い換えや統一はしていない。
3. 上位の区域（市町村等をまとめた地域等・一次細分区域等・府県予報区等）は、コード表の値をそのまま使う。GIS の「市町村等（気象警報等）」のコードの集合とコード表の集合が一致すること、名前が一致することを変換のときに確かめ、違えば止める。
4. 確認として、各「市町村等」の内側に置いた点（計 555 点）が、GIS の「市町村等をまとめた地域等」「一次細分区域等」のどの区域に入るかを調べた。すべてコード表の対応と一致した。
5. 形状を簡略化した（下）。
6. 座標を 10 万分の 1 度（約 1m）の整数に丸め、差分で並べた。

## 簡略化の程度と、誤判定の恐れ

| 項目 | 値 |
| --- | --- |
| 方法 | Douglas-Peucker 法（輪ごと。北緯 35 度を基準にした平面に置き換えて計算） |
| 許容誤差 | 30m |
| 座標の丸めによる誤差 | 最大約 0.8m |
| 合計の最大誤差（`simplification.max_error_m`） | 30.79m |
| 頂点の数（市町村等（気象警報等）） | 477,103 → 13,276 |
| 輪の数（同） | 1,730 → 86 |
| 落とした小さな輪 | 1,644 個、合計約 0.45km²（簡略化のあとに面積 2,000m² 未満になるもの。岩礁や小島。一番大きいもので約 5,100m²）。初島は残っている |
| 大きさ | 約 270KB（gzip で約 110KB） |

誤判定の恐れと、その手当て：

- 区域の境界は、もとの位置から最大で約 31m ずれている。そのため、判定する関数は、利用者が渡した誤差の半径に `max_error_m` を足した範囲で調べる。境界から約 31m 以内の点は、誤差が 0 でも、必ず両側の区域を候補として返す（1 つに決めない）。
- 変換のときに、ランダムな 3,000 点（半分は境界の近く）で、もとの形と簡略化した形の内外の判定を比べた。食い違いは 73 点。そのうち 15 点は落とした小さな輪の上で、残りはどれも簡略化した境界から 22.1m 以内だった（許容 30.79m 以内）。
- 落とした岩礁や小島の上の点は「県の外（海上など）」と判定される。区域を間違えて返すのではなく、「判定できない」側に倒れる。
- 海岸線は GIS データの線をもとにしている。海岸や港、河口の近くでは、陸の上でも「海上」、海の上でも「陸」と判定されることがある（誤差の範囲内なら候補と「県の外の可能性」を返す）。
- 境界はこの GIS データの時点のもの。市町村の合併、区の再編、警報の発表区域の変更があると古くなる。気象庁の GIS データのページとコード表の更新を確かめて作り直す必要がある。
- 座標は JGD2011（世界測地系）。端末の GPS（WGS84）との差は小さいと考えて、この用途では無視している（**未確認**：ずれの大きさを文書で確かめていない）。

## 作り直し方

```bash
python3 -I modules/area/tools/build_area_data.py \
  --weather 20260226_AreaInformationCity_weather_GIS.zip \
  --quake 20241128_AreaInformationCity_quake_GIS.zip \
  --prefecture 20190125_AreaForecastLocalM_prefecture_GIS.zip \
  --group 20230517_AreaForecastLocalM_matome_GIS.zip \
  --primary 20190125_AreaForecastLocalM_1saibun_GIS.zip \
  --codes jmaxml_20261104_Code.zip \
  --out modules/area/data/shizuoka.json
```

ダウンロードしたファイルは信頼できない入力として扱い、専用の空のディレクトリに置き、Python は `-I` で動かしてください。乱数の種は固定（`--seed`）なので、同じ入力からは同じ JSON ができます。
