# 試作 C-B で使う電文

気象庁防災情報 XML の実物を、試作 C-B（言い換えと照合）のために保存したものです。どれも取得したまま加工していません。言い換えの例文（`../examples.json`）は、これらの電文に合わせて作っています。

出典：気象庁ホームページ（各ファイルの URL は下の表と `fetched.json`）

| ファイル | 電文 | 取得元 URL |
| --- | --- | --- |
| `20261103054210_0_VXSE51_010000.xml` | 震度速報（千葉県北東部、11 月 3 日 14 時 40 分ころの地震） | <https://www.data.jma.go.jp/developer/xml/data/20261103054210_0_VXSE51_010000.xml> |
| `20261103054323_0_VXSE52_010000.xml` | 震源に関する情報（同じ地震） | <https://www.data.jma.go.jp/developer/xml/data/20261103054323_0_VXSE52_010000.xml> |
| `20261103054436_0_VXSE53_010000.xml` | 震源・震度に関する情報（同じ地震） | <https://www.data.jma.go.jp/developer/xml/data/20261103054436_0_VXSE53_010000.xml> |
| `20261103223117_0_VXSE53_270000.xml` | 震源・震度に関する情報（熊本県熊本地方、11 月 4 日 7 時 28 分ころの地震。`data/samples/` にある同名のファイルと同じ中身） | <https://www.data.jma.go.jp/developer/xml/data/20261103223117_0_VXSE53_270000.xml> |
| `20261104094324_0_VPWW61_220000.xml` | 気象警報・注意報（Ｒ０６）（その他注意報）静岡県雷注意報 | <https://www.data.jma.go.jp/developer/xml/data/20261104094324_0_VPWW61_220000.xml> |
| `20261104083146_0_VPWW61_340000.xml` | 気象警報・注意報（Ｒ０６）（その他注意報）広島県乾燥注意報（解除） | <https://www.data.jma.go.jp/developer/xml/data/20261104083146_0_VPWW61_340000.xml> |
| `20261104072446_0_VPWW58_080000.xml` | 気象警報・注意報（Ｒ０６）（暴風）茨城県暴風（雪）警報・注意報 | <https://www.data.jma.go.jp/developer/xml/data/20261104072446_0_VPWW58_080000.xml> |

- 取得日時：2026-11-04 19:45 ごろ（日本時間）。`fetched.json` の `fetched_at_utc` が取得した時刻（UTC）、`http_date` は応答の Date ヘッダです。応答は CDN のキャッシュから返ることがあるため、`http_date` は取得した時刻より前のことがあります。
- 調査用の過去のデータです。いま有効な情報ではありません。最新の情報は気象庁の発表を確認してください。
- 利用条件：気象庁ホームページ 利用規約 <https://www.jma.go.jp/jma/kishou/info/coment.html>、XML 形式電文のご利用にあたっての留意事項 <https://xml.kishou.go.jp/considerationforxml.pdf>（まとめは `docs/research/jma_data.md` の 4 章）
