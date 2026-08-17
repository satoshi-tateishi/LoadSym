# 修正プロンプト（機材フォーム共通化リファクタの権限バグ）

直前のリファクタ（機材フォームのHTML/JS共通化・保存処理の共通化）をレビューした結果、**1件の権限バグ**を
ブラウザでの実動作確認（Editorアカウントでログインし、機材フォームを実際に開く）で確認した。
それ以外の変更（`equipment-form.js` / `equipment-form.html` / `withSaving` / `swapAdjacent` /
15箇所の保存処理の置き換え）は正しく動作しており、修正不要。**このバグ1点だけを直す。**

## 見つかったバグ

`docs/assets/js/pages/simulator.js` の `showTemplateOwnershipControl` が、`isAdmin` に連動しない
**固定値 `true`** になっている。

```js
equipmentFormLabel: '機材',
showTemplateOwnershipControl: true,   // ← ここが常に true
```

このフラグは `docs/partials/equipment-form.html` 内の「共通テンプレートとして登録する（全ユーザーが
利用できます）」チェックボックスの表示・非表示を制御する（`<template x-if="showTemplateOwnershipControl">`）。

リファクタ前は `docs/simulator.html` 側で `<template x-if="isAdmin">` として直接ガードしており、
**Admin以外（Editor）には表示されなかった。** 今回の共通化で `isAdmin` を見るgetterに置き換えるべきところを
固定 `true` にしてしまったため、**Editorでログインしてもこのチェックボックスが見えるようになっている。**

### 実際に確認した再現手順

1. `npm run serve` でローカルサーバーを起動
2. `test-account.json` の `test2`（Editor）でログインし、`simulator.html` を開く
3. 「機材シンボル」タブの「追加」を押してフォームを開く
4. フォーム下部に「共通テンプレートとして登録する（全ユーザーが利用できます）」チェックボックスが
   **表示されてしまう**（Admin専用のはずが出ている）

参考として、同じ手順をAdminアカウント（`test1`）で行うと正しく表示される。`admin.html` 側は
`showTemplateOwnershipControl: false`（固定）になっており、こちらは元々チェックボックス自体が
存在しなかった画面なので正しい。

### 実害の補足（深刻度の参考情報。直す理由が変わるわけではない）

`ownerIdForCreate` / `withOwnerChange`（同じ `simulator.js` 内）は依然として `this.isAdmin` を
条件にしているため、Editorがこのチェックボックスを操作しても保存結果（`user_id`）には影響しない
（実際に保存して確認済み）。**データの整合性は壊れていない。** ただし、Editorから見ると
「チェックしても何も起きない謎のチェックボックス」が出ている状態であり、UIとして誤り。
権限によって出し分けるという元の仕様に反するため、実害の有無にかかわらず修正すること。

## 直し方

`docs/assets/js/pages/simulator.js` の該当プロパティを、`isAdmin` に連動するgetterへ変更する。

```js
get showTemplateOwnershipControl() {
  return this.isAdmin;
},
```

`isAdmin` は同ファイル内に既にgetterとして定義済み（`this.profile?.role === 'Admin'`）なので、
新しく参照を追加するだけでよい。`docs/assets/js/pages/admin.js` 側の
`showTemplateOwnershipControl: false` は元々の挙動（admin.htmlにはこのチェックボックス自体が
存在しなかった）と一致しているため**変更しないこと**。

`docs/partials/equipment-form.html` 側は変更不要（`x-if="showTemplateOwnershipControl"` のまま）。

## やらないこと

- 他のプロパティ（`equipmentFormLabel`、`categoryManagementHint`）は実際に動作確認済みで問題ないため
  触らない
- `equipment-form.js` の関数群、`withSaving`、`swapAdjacent` は動作確認済みで問題ないため触らない
- 機能追加・見た目の変更はしない。今回はこの1点のバグ修正のみ

## 完了条件

- `npm test` が通ること（今回の修正はロジックテスト対象外の1行なので、通ることの確認のみでよい）
- `npm run serve` で以下をブラウザで再確認すること（ブラウザのキャッシュを必ず無効化すること。
  ES モジュールはキャッシュされやすく、無効化しないと古いコードのまま確認してしまう）
  - Editor（`test2`）でログインし、機材追加フォームを開いたとき「共通テンプレートとして登録する」
    チェックボックスが**表示されない**こと
  - Admin（`test1`）でログインし、`simulator.html` の機材追加フォームでは同チェックボックスが
    **表示される**こと
  - `admin.html` のテンプレート機材フォームでは元々どおり同チェックボックスが**存在しない**こと
- Viewer（`test3`）は元々フォーム自体を開けないので確認不要

## 報告に含めること

- 修正した行（diff）
- 上記3ロール分のブラウザ確認結果
