# 公開の前後にやること

リポジトリは 11/8 に公開する予定です。公開の前後に人が行う作業を、ここにまとめます。終わった項目は `[x]` にして、結果をその回の開発ログに書いてください。

## 公開の前

- [ ] **リポジトリ名を変える**（公開の前に行う）。変えた後に、次を確かめる。
  - 手元のクローンの送り先を新しい名前に直す（`git remote set-url origin <新しい URL>`）。`git remote -v` で確かめ、`git fetch` が通ることを確かめる。
  - GitHub の「Claude」アプリの許可（インストール先のリポジトリ）が、新しい名前のリポジトリで続いているか確かめる（Settings → Integrations → Applications、または Organization の設定）。
  - README・ドキュメントの中の古い名前やリンクを直す。
- [ ] **個人語の全履歴の検査（BW-U15）**：下の項目。すべてのブランチとタグの全履歴が対象です。
- [ ] 実際の禁止語ファイルを `ESM_DENYLIST_FILE` で指定して、`scripts/check-secrets.sh --all --require-denylist` を実行する。停止が 0 件で、「個人語の検査を実施」と表示されることを確かめる。
- [ ] GitHub の設定が、`docs/devlog/2026-11-04_s06.md` の「次にやること」のとおりになっていることを確かめる（Environment `personal-words` と、その Secrets、ブランチ保護）。main への push の CI で、`personal-words` の job が成功していることも確かめる。

## 公開した直後（最初にやる）

- [ ] **Secret scanning（Secret Protection）を有効にする。** Settings → Advanced Security（「Code security」と表示される場合もある）。
- [ ] **Push protection を有効にする。** 同じ画面。
- [ ] 有効にしたあと、Security タブの Secret scanning の警告を見る。有効にすると全履歴が調べられるので、警告が出ていれば、すぐに対応する（鍵を無効にする、履歴から消すかを決める）。

この 2 つの設定は、非公開のあいだは画面に表示されなかった（2026-11-04 に確かめた）。そのため、公開した直後に行う。

この 2 つが必要な理由：手元の検査（`scripts/check-secrets.sh`）では、2 つに分けて書いたキーや逆順にしたキーなど、拾いきれない形がある。また push protection は、GitHub の側でプッシュそのものを止められる。手元のフックや CI とは別の層になる（詳しくは `docs/review/check-secrets_review.md` の CS-07、CS-08、CS-11）。
