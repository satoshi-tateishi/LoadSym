# リファクタリング必要性レビュー（2026-08-17）

対象: `docs/assets/js/**`（全21ファイル、約6,300行）、`docs/*.html`（4画面、約1,430行）、`tests/**`。
方法: 全JSファイルと主要HTMLを通読し、重複・複雑度・テストカバレッジを確認した。

## 総評

**「壊れていて直すべきコード」はほとんど無い。** `geometry.js` / `packing.js` / `shape-editor.js` を中心に、
- 状態を持たない純粋関数に計算ロジックを閉じ込める（DOM/Supabaseに触れない）
- 「なぜそうしたか」を説明するコメント（過去の不具合・トレードオフの理由）が丁寧に残っている
- 座標系・命名・エラー処理のパターンが全ファイルで一貫している

という設計方針が保たれており、直近のコミット（クリアランス目安線、テールゲート仮置きゾーンなど）でもこの品質は崩れていない。着手中の機能追加を止めてまで構造を作り直す理由は見当たらない。

一方で、**同じロジックを2箇所に手で書き写している箇所**がいくつかあり、これは今後の変更で「片方だけ直して他方を直し忘れる」事故につながる。以下、実際に見つかった重複箇所を優先度順に挙げる。想定読者は今後このリポジトリを触る開発者（自分自身を含む）。

---

## 優先度: 高 — 実害が出やすい重複

### 1. 機材フォームがJS・HTML両方で丸ごと二重管理されている

`simulator.js` と `pages/admin.js` の両方に、ほぼ同一のロジックが存在する。

- `defaultCategoryId`（getter）
- `categoryDefaultColor(categoryId)`
- `applyCategoryColor(categoryId)`
- `openEquipmentForm(item)` — 初期値の組み立て
- `saveEquipment()` — `prepareEquipmentShape` → values組み立て → create/update → `reload()`
- `removeEquipment()`

該当: `docs/assets/js/pages/simulator.js:139-158,797-861` と `docs/assets/js/pages/admin.js:308-326,339-402`

HTML側も同様で、`docs/admin.html:345-480` と `docs/simulator.html:233-400` の機材フォーム（形状エディタのSVG込み、約130〜170行）はほぼ1文字単位で一致している（`diff`で確認した差分は見出し文言など数行のみ）。

**リスク**: 形状エディタや機材フォームの仕様変更（例: 新しいパーツ種類の追加、バリデーションルールの変更）をどちらか一方にしか反映せず、admin側とsimulator側で挙動が食い違う。実際、simulator側だけに存在する `withOwnerChange` / `ownerIdForCreate`（テンプレート化の切替）はadmin側には無く、両者が完全に同一ではない分、差分を目視で追うコストも高い。

**提案**:
- HTML: 既に `partials/nav.html` を `hx-get` で読み込む仕組みがあるので（`docs/assets/js/layout.js:13-17`）、同じパターンで `partials/equipment-form.html` を切り出す。管理画面固有の注記（「カテゴリの追加・並び替えは管理画面で」）は `x-show="isAdmin"` 相当のガードで両画面から出し分ければよい。
- JS: `equipments.js` に隣接する形で `equipment-form.js`（あるいは既存の `shape-editor.js` 付近）に、`defaultCategoryId` / `categoryDefaultColor` / `applyCategoryColor` / `buildEquipmentValues(form)` を切り出し、両ページから import する。`saveEquipment` 自体は「テンプレート限定かどうか」の差があるため無理に一本化せず、共通部分（values組み立てとバリデーション）だけ関数化するのが安全。

この2点は変更頻度も高い箇所（機材フォームは仕様変更が入りやすい）なので、優先度を高くしている。

### 2. 保存系メソッドの try/catch/finally が15箇所同じ形で繰り返されている

```js
this.saving = true;
this.errorMessage = '';
try {
  ...
} catch (error) {
  console.error(error);
  this.errorMessage = translateError(error);
} finally {
  this.saving = false;
}
```

この形が `pages/simulator.js` に5箇所、`pages/admin.js` に7箇所、`pages/layouts.js` に3箇所ある（`saveEquipment` / `removeEquipment` / `saveTruck` / `removeTruck` / `saveLayoutNow` / `saveCategory` / `removeCategory` / `applyUserChange` / `confirmImport` / `saveRename` / `remove` / `duplicate` など）。

**リスク**: 実害は小さいが、「保存中はエラーメッセージを消す」「失敗したらconsole.errorしてtranslateError」という規約を守り忘れる余地が15箇所ある。実際 `admin.js` の `applyUserChange`（`admin.js:116-132`）だけは失敗時に追加で `this.users = await listUsers()` を呼んでおり、これが意図的な例外なのか書き忘れの派生なのか、コードだけでは判別しづらい。

**提案**: 各ページの `init()` 付近に、次のような小さな共有ヘルパーを1つ足す（Alpineコンポーネントのメソッドとしてもプレーン関数としても書ける）。

```js
async function withSaving(self, task) {
  self.saving = true;
  self.errorMessage = '';
  try {
    return await task();
  } catch (error) {
    console.error(error);
    self.errorMessage = translateError(error);
  } finally {
    self.saving = false;
  }
}
```

3ページ共通で使うなら `error-messages.js` か新規 `async-task.js` に置き、`import` する。呼び出し側は `await withSaving(this, async () => { ... })` になり、finally漏れの心配がなくなる。ただし「失敗時にリストを再取得して画面を正の状態に戻す」ような処理（`admin.js:127-128`, `admin.js:299-300`）は task 内かオプション引数で表現する必要がある。

---

## 優先度: 中 — 気づきにくいが直せば読みやすくなる重複

### 3. `sort_order` の並び替え保存ロジックが equipments.js / categories.js で重複

`updateEquipmentOrder`（`equipments.js:67-88`）と `updateCategoryOrder`（`categories.js:55-75`）は、テーブル名以外ほぼ同一（現在値を取得→差分だけ抽出→1件ずつ更新→変更件数を返す）。

**提案**: 優先度は中程度に留める。差分更新のロジック自体は難しくないため、`(tableName, orderedIds) => Promise<number>` の形で1つの関数に抽出してもよいが、2箇所だけの重複であり、無理に共通化すると「テーブル名を文字列で渡す」抽象化コストの方が高くつく可能性もある。3つ目の対象（例えばトラックにも並び替えが要る）が出た時点で共通化するので十分。

### 4. `admin.js` の `moveCategory` / `moveTemplate` が同一パターン

`admin.js:203-211` と `admin.js:329-337` は「配列内で1つ隣と入れ替えて永続化する」という同一の処理を、対象配列とpersist関数だけ変えて2回書いている。`bindSortable` / `saveOrder` は既に共通ヘルパー化されているので、この2つも同様に

```js
function swapAndPersist(items, item, direction, persist) { ... }
```

としてまとめれば一貫性が増す。実害は小さいので、次にこのあたりを触る機会に合わせて直す程度でよい。

---

## 優先度: 低 / 経過観察でよいもの

### 5. `equipments.js` / `trucks.js` / `categories.js` のCRUD雛形

3ファイルとも `list/create/update/delete` の形が同じ（`supabase.from(table).select(COLUMNS)...` のラップ）。教科書的には「汎用CRUDファクトリ」に統合できるが、

- 各テーブルで `COLUMNS` の結合先（`equipment_categories` の join、`truck_obstacles` の同時取得）が微妙に異なる
- `equipments.js` だけ `withCategoryName` という後処理が挟まる

という差異があり、無理に共通化すると分岐だらけの汎用関数になりかねない。**現状の「薄いラッパーを3つ並べる」形の方が読みやすいので、これは重複ではなく妥当なコピペと判断し、着手しないことを推奨する。**

### 6. `simulator.js` が1,025行の単一コンポーネント

行数だけ見ると大きいが、中身は
`マスタ` → `機材の配置` → `ドラッグ` → `キーボード` → `履歴` → `描画` → `機材/トラックフォーム` → `レイアウトの保存・読込` → `書き出し`
とコメントで明確にセクション分けされており、1メソッドが長大というわけではない（最長でも `onStagePointerDown` の約120行で、これはポインタイベントのクロージャ構造上自然な長さ）。

Alpineの `x-data` はコンポーネントの状態を1つのプレーンオブジェクトとして持つ設計のため、複数ファイルに分割すると `this` 経由の相互参照が複雑になり、かえって追いにくくなる可能性がある。**行数だけを理由にした分割は勧めない。** 将来2.5D対応（`SPECIFICATION.md` に記載の段積み機能）で `packing.js` / `renderer.js` 側の複雑度が増したときに、改めてこのファイルの責務を見直すのが自然なタイミング。

### 7. `window.shapeEditor = shapeEditor;` の重複代入

`simulator.js:34` と `admin.js:22` の両方で同じグローバル代入がある。Alpineの `x-data="shapeEditor(...)"` を各HTMLのテンプレート内から直接参照するための仕組みで、ページごとに実行されるモジュールが別なので重複自体はほぼ避けられない（意図的なコピペ）。実害はないため対応不要。

---

## テストカバレッジについて

`npm test` は `geometry.js` / `packing.js` / `shape-editor.js` のみを対象にしている（`tests/geometry.test.mjs` 443行、`tests/packing.test.mjs` 839行、`tests/shape-editor.test.mjs` 102行）。これは妥当な線引きで、DOM/Supabaseに依存する部分（`renderer.js`, `pages/*.js`, データアクセス層）はCLAUDE.mdの方針どおりブラウザでの手動確認でカバーする想定と考えられる。

ただし以下の2ファイルは **DOM/Supabaseに依存しない純粋関数でありながら、テストが無い**:

- `csv.js` — 引用符・改行・カンマを含むフィールドのパース、UTF-8/Shift_JISのフォールバック、「赤系色」判定など、境界条件の多いロジックがテスト無しで存在する。CSVインポート機能の劣化に気づく手段が「手でCSVを作って画面で試す」しかない。
- `history.js` — Undo/Redoの深さ上限（`MAX_DEPTH = 50`）やRedo履歴の破棄タイミングなど、境界条件がある。

**提案**: 優先度は上記の重複解消より低いが、コストが小さい（DOM不要、既存の自前アサーション形式をそのまま流用できる）わりに、壊れたときの影響（データ取り込み・操作履歴）が大きいので、余裕があれば `tests/csv.test.mjs` を追加することを推奨する。

---

## まとめ（優先順位）

| # | 内容 | 優先度 | 目安工数 |
|---|---|---|---|
| 1 | 機材フォーム（JS+HTML）の重複解消 | 高 | 中（HTML分割+import整理） |
| 2 | 保存系 try/catch/finally の共通化 | 高 | 小〜中（15箇所の書き換え） |
| 3 | `sort_order` 並び替えロジックの共通化 | 中 | 小（今すぐでなくてよい） |
| 4 | `moveCategory`/`moveTemplate` の共通化 | 中 | 小 |
| 5 | equipments/trucks/categories のCRUD統合 | 対応不要 | — |
| 6 | simulator.js のファイル分割 | 対応不要（現状） | — |
| — | `csv.js` / `history.js` のユニットテスト追加 | 中 | 小 |

大規模な設計変更ではなく、#1・#2から着手し、動作確認（`npm test` + `npm run serve` での手動確認）を挟みながら小さく直していくのが妥当。
