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
