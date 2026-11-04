# サンプルデータ

気象庁防災情報 XML の実物を、調査のために保存したものです。どれも取得したまま加工していません。調査の内容は `docs/research/jma_data.md` にあります。

出典：気象庁ホームページ（各ファイルの URL は下の表）

| ファイル | 取得元 URL | 取得日時（応答の Date ヘッダ、UTC） |
| --- | --- | --- |
| `20261103223117_0_VXSE53_270000.xml` | <https://www.data.jma.go.jp/developer/xml/data/20261103223117_0_VXSE53_270000.xml> | 2026-11-03 22:32:03 |
| `20261104083155_0_VPWW53_340000.xml` | <https://www.data.jma.go.jp/developer/xml/data/20261104083155_0_VPWW53_340000.xml> | 2026-11-04 08:33:49 |
| `feed_eqvol_20261104T0834Z.xml` | <https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml> | 2026-11-04 08:34:01 |

注意：

- 調査用の過去のデータです。いま有効な情報ではありません。最新の情報は気象庁の発表を確認してください。
- 地震情報の取得日時（Date ヘッダ）は、このファイルを取得したときの値ではありません。応答は CDN のキャッシュから返っていました（応答ヘッダの `x-cache` が Hit、`age` が約 10 時間）。実際に取得したのは 2026-11-04 の 17:35 ごろ（日本時間）です。
- Atom フィードのファイル名は、取得した時刻（UTC）を付けて変えています。中身は変えていません。
- 利用条件：気象庁ホームページ 利用規約 <https://www.jma.go.jp/jma/kishou/info/coment.html>、XML 形式電文のご利用にあたっての留意事項 <https://xml.kishou.go.jp/considerationforxml.pdf>

## 気象庁防災情報 XML 以外のサンプル

`docs/research/other_data.md` の調査のために保存したものです。どれも取得したまま加工していません（ファイル名だけ、取得元と取得時刻を付けて変えています）。

| ファイル | 出典 | 取得元 URL | 取得日時（応答の Date ヘッダ、UTC） |
| --- | --- | --- | --- |
| `jma_risk_targetTimes_20261104T1921Z.json` | 出典：気象庁ホームページ | <https://www.jma.go.jp/bosai/jmatile/data/risk/targetTimes.json> | 2026-11-04 19:21:16 |
| `env_wbgt_yohou_43056_20261104T1921Z.csv` | 出典：環境省熱中症予防情報サイト（環境省） | <https://www.wbgt.env.go.jp/prev15WG/dl/yohou_43056.csv> | 2026-11-04 19:21:16 |
| `gsi_disaportal_metadata_light.xml` | 出典：「ハザードマップポータルサイト」 | <https://disaportal.gsi.go.jp/hazardmap/copyright/metadata_light.xml> | 2026-11-04 19:21:18 |

注意：

- キキクルの時刻の一覧は、気象庁ホームページの画面が内部で使うデータで、公式の仕様書はありません。形が変わる恐れがあります。
- 暑さ指数の予測値は、令和 8 年度の提供期間（2026 年 10 月 21 日まで）が終わったあとに返った古いファイルです（中身は 10 月 22〜24 日の予測）。電子情報提供サービスの情報は参考情報で、熱中症警戒アラートの正式発表は環境省の熱中症予防情報サイト・報道発表などで確認してください。
- WMTS メタデータは `Last-Modified` が 2024-09-26 で、今のオープンデータ配信のページとそろっているかは確かめていません。
- 利用条件：気象庁ホームページ 利用規約（上と同じ）、環境省熱中症予防情報サイト ご利用にあたって <https://www.wbgt.env.go.jp/tos.php> と電子情報提供サービスの注意事項 <https://www.wbgt.env.go.jp/data_service.php>、ハザードマップポータルサイト 利用規約 <https://disaportal.gsi.go.jp/hazardmapportal/hazardmap/copyright/copyright.html>
