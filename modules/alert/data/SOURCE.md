# coast.json の出典と作り方

## 出典

出典：気象庁ホームページ（<https://www.data.jma.go.jp/developer/gis.html>）

気象庁「予報区等GISデータ」の「津波予報区」をもとに本プロジェクトが作成（予報区の抽出、線の簡略化、座標の丸め）。気象庁が作成したものではありません。加工したものの編集責任は本プロジェクトにあります。利用条件は気象庁ホームページ利用規約（公共データ利用規約 第 1.0 版に準拠。`docs/research/jma_data.md` の 4 章と 9 章）。GIS データの国土地理院の承認の記載は `modules/area/data/SOURCE.md` と同じページにあります。

## 元にしたファイル

`20240520_AreaTsunami_GIS.zip`（約 89MB、2026-11-07 に取得）<https://www.data.jma.go.jp/developer/gis/20240520_AreaTsunami_GIS.zip>。リポジトリには入れていない（JSON に SHA-256 を記録）。

## 作り直す手順

```bash
python3 -I modules/alert/tools/build_coast_data.py --zip /path/to/20240520_AreaTsunami_GIS.zip --retrieved 2026-11-07 --out modules/alert/data/coast.json
```

- Python 標準ライブラリだけ。手元で 9 分ほどかかる（簡略化の誤差を全頂点で測るため）。
- 同じ入力から同じ JSON ができる（2 回作って比べた）。

## 加工の内容

1. dbf（UTF-8）から、コード 380（静岡県）・250（福島県）・310（千葉県九十九里・外房）・311（千葉県内房）・312（東京湾内湾）を選ぶ。名前とコードは書き換えない。
2. 線（ポリライン）を Douglas-Peucker 法で簡略化（許容誤差 20m）。頂点 486,260 → 21,439。
3. 座標を 10 万分の 1 度の整数の差分にする。最大の誤差は約 21m（`simplification.max_error_m`）。

## 使い方の注意

- 線は津波予報区の境界として引かれた海岸線で、細かな入り江や港の形は簡略化で失われている。海岸線からの距離は、誤差（約 21m）の分ずれる。
- 島（伊豆諸島など）は入れていない。
