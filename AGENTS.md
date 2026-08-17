# AGENTS.md

## 言語

ユーザーとのやり取りは日本語で対応すること。

## 仕様書

`project-docs/SPECIFICATION.md` がパイロット版の確定仕様。実装方針を変えた場合は仕様書も更新すること。
DBマイグレーションは `project-docs/sql/NNN_snake_case.sql` の連番ファイルで管理し、Supabaseダッシュボードの
SQL Editorに貼って実行する（Supabase CLIは使わない）。各ファイル先頭に「なぜこの変更をするか」を日本語で記す。

## 公開環境

このプロジェクトはGitHub Pagesで公開されている（公開ルートは`main`ブランチの`docs/`）。
コードを修正した後は、以下のいずれかの方法で必ず動作検証すること。

- ローカルでサーバーを立てて動作確認する
- 変更をpushし、公開されたページ（GitHub Pages）で動作確認する

## ローカルサーバー

**ポートは8090に固定**。毎回違うポートで立てると、ブラウザに残ったセッションやキャッシュが混ざるため。
起動は必ず次のコマンドを使い、`python3 -m http.server`を直接叩かないこと。

```
npm run serve     # http://localhost:8090/ で docs/ を配信
```

ESモジュール（`docs/assets/js/**`）はブラウザに強くキャッシュされる。JSを直したのに挙動が変わらないときは、
HTMLにクエリを付けるだけでは不十分で、モジュール自体を再取得させる必要がある
（開発者ツールのハードリロード、または「キャッシュを無効化」）。

## テスト

`npm test` で geometry / packing / shape-editor のユニットテストが動く。
`docs/assets/js/`のロジックを変更したら、動作確認の前にこれを通すこと。

## テストアカウント

動作確認用のログイン情報はリポジトリ直下の`test-account.json`（gitignore済み、非公開）を参照。
ロールごとの権限差分を確認する際は、Admin/Editor/Viewerの各アカウントでログインして比較すること。

## Tailwind CSS

`docs/assets/css/styles.css`はTailwind CLIのビルド生成物であり、直接編集しない。
Tailwindのクラスを追加・変更したら、以下を実行してから commit すること
（GitHub Pagesはビルドを行わず、コミットされた静的ファイルをそのまま配信するため）。

```
npm install   # 初回のみ
npm run build:css
```

編集対象は`docs/assets/css/tailwind.src.css`（カスタムCSS）と`tailwind.config.js`（content対象パス）。

## Supabase JS SDK

`docs/assets/vendor/supabase-js.esm.js`は`@supabase/supabase-js`をesbuildで単一ファイルにバンドルした自己ホスト版（CDN依存を避けるため）。
バージョンを上げる場合は以下を実行する。

```
npm install --save-dev @supabase/supabase-js@<version>
npm run build:vendor
```

## リポジトリは公開（public）

`docs/assets/js/supabase-config.js`に書けるのはSupabaseの**anon key のみ**（クライアントに埋め込まれる前提のキーで、
保護はRLSが担う）。`service_role`キーやパスワードの類は絶対にコミットしないこと。
