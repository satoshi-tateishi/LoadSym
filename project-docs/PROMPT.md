# Phase 0 実装プロンプト（多角形シンボル: データモデル）

このファイルは、`IMPLEMENT_PHASE.md` の **Phase 0** を単独で実行するための作業指示書。
新しいセッションでそのまま渡せるように、必要な情報を自己完結でまとめてある。

---

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトのルール）
2. `project-docs/IMPLEMENT_PHASE.md`（全体のフェーズ分割。前提と設計の芯）
3. `project-docs/SPECIFICATION.md` の 5.1 / 6.2 / 6.3（機材データと配置計算）

## このフェーズのゴール

機材に**形（矩形パーツの集合）**を保存できるようにし、その形を配置のスナップショットまで運ぶ。

**判定と描画は一切変えない。** このフェーズが終わった時点で、画面の見た目・当たり判定・集計は**すべて今までどおり**であること。形を使い始めるのは Phase 1 以降。

## 守るルール

- ユーザーとのやり取り、コード内のコメントは**日本語**
- DBマイグレーションは `project-docs/sql/NNN_snake_case.sql` の連番ファイル。**Supabase CLI は使わない**（ユーザーがダッシュボードのSQL Editorに貼って実行する）。ファイル先頭に「なぜこの変更をするか」を日本語で書く
- `docs/assets/css/styles.css` は生成物。直接編集しない（今回はCSS変更なしのはず）
- コードを直したら**必ず動作検証する**（ローカルサーバ or 公開ページ）
- コミット・pushはユーザーの指示があるまで行わない

---

## 作業1: マイグレーション `project-docs/sql/007_equipment_shape.sql`（新規）

```sql
alter table public.equipments add column shape jsonb;
```

`null` = 従来どおりの1枚矩形。先頭コメントに以下を日本語で書くこと。

- L字（袖付き卓）やコの字（ラック）を外形矩形で判定すると、凹みに入るはずの機材が入らない
- 形は「軸平行な矩形パーツの集合」として持つ。辺が軸平行なら既存の吸着・押し出し・空き探索がそのまま使える
- `width_mm` / `depth_mm` は**外形bboxとして残す**（一覧表示・CSV・並び替え・空き探索の初期サイズが動き続ける）
- `parts[].kind` を最初から持たせるので、将来の多角形・円はマイグレーション不要

形式（外形bboxの左前を原点とするローカル座標、単位mm、整数）:

```json
{ "parts": [
  { "kind": "rect", "x": 0,    "y": 0, "w": 1370, "d": 460 },
  { "kind": "rect", "x": 1370, "y": 0, "w": 400,  "d": 250 }
]}
```

制約はDBに書かず、アプリ側（`normalizeShape`）で吸収する。壊れた形が入っていても図が出せなくなるより、矩形にフォールバックするほうがよい。

**適用はユーザーが行う。** ファイルを作ったら、貼って実行するよう伝えること。

## 作業2: `docs/assets/js/equipments.js`

`COLUMNS` に `shape` を足すだけ。

```js
const COLUMNS =
  'id, user_id, name, category_id, width_mm, depth_mm, height_mm, weight_kg, color, note, sort_order,' +
  ' shape, equipment_categories (id, name, sort_order)';
```

## 作業3: `docs/assets/js/geometry.js`

`toParts()` を追加する。**既存の `toRect()` は残す**（描画と寸法パネルがまだ使っている）。

```js
/**
 * 配置を当たり判定用のパーツ（軸平行な矩形）の配列にする。
 * shape を持たない機材は1枚の矩形として扱うので、呼び出し側は形の有無を意識しなくてよい。
 * 返る座標は荷台の絶対座標。
 */
export function toParts(placement) { ... }
```

中身の要点:

- `placement.snapshot.shape` が無ければ `[{ x: 0, y: 0, w: widthMm, d: depthMm }]`
- 回転は90度刻み。外形が `w0 × d0`（**回転前**）のとき、ローカル座標のパーツ `(px, py, pw, pd)` は次のように写す:

  | rotation | 変換後 |
  |---|---|
  | 0 | `(px, py, pw, pd)` |
  | 90 | `(d0 - py - pd, px, pd, pw)` |
  | 180 | `(w0 - px - pw, d0 - py - pd, pw, pd)` |
  | 270 | `(py, w0 - px - pw, pd, pw)` |

- 最後に `placement.x` / `placement.y` を足す
- 各パーツに `id`（＝placementのid）と `partIndex` を持たせる。Phase 1 で押し出し対象を特定するのに使う
- 併せて `boundsOf(parts)`（外形bbox）も追加する。`toRect(placement)` と一致することを必ずテストで確かめる

`normalizeShape(shape, widthMm, depthMm)` を用意して、次を弾いて矩形にフォールバックする。

- `parts` が配列でない / 空
- `w` または `d` が 0以下、数値でない
- `kind` が `'rect'` 以外（**将来の多角形・円が入ってきても落ちないように**、未知のkindは無視する）

## 作業4: `docs/assets/js/packing.js`

`createPlacement()` が作る `snapshot` に `shape` を含める。

```js
snapshot: {
  name: equipment.name,
  widthMm: equipment.width_mm,
  depthMm: equipment.depth_mm,
  heightMm: equipment.height_mm,
  weightKg: Number(equipment.weight_kg ?? 0),
  color: equipment.color,
  shape: equipment.shape ?? null
}
```

保存時の図を固定するのがスナップショットの目的なので、**形もここで固める**（マスタの形を後から変えても、保存済みのレイアウトは変わらない）。`duplicatePlacement()` はスナップショットをそのままコピーしているので変更不要。

## 触らないもの（重要）

- **機材フォーム（`simulator.html` / `admin.html` と各 `saveEquipment()`）は変更しない。**
  PostgRESTのPATCHは渡した列だけ更新するので、`values` に `shape` が無くても既存の形は消えない。形の編集UIは Phase 3。
- `docs/assets/js/layouts.js` … `equipment_snapshot` はjsonbを丸ごと出し入れしているので変更不要
- `renderer.js` / 判定系（`findInvalidRects` など）… Phase 1・2で扱う

---

## 完了条件

### 自動テスト（`tests/geometry.test.mjs` に追加、`npm test` が通ること）

- shape が無い配置の `toParts()` が、`toRect()` と同じ矩形1枚を返す
- L字（上の例の2パーツ）の `toParts()` が、回転 0 / 90 / 180 / 270 で上の変換表どおりの座標を返す
- 回転後の `boundsOf(toParts(p))` が `toRect(p)` と一致する（外形の整合）
- `normalizeShape` が壊れた形（空配列 / 負の幅 / 未知のkind）で矩形にフォールバックする
- **既存のテストが1つも壊れないこと**

### 手動確認（`npm run serve` + `test-account.json` のアカウント）

1. `007_equipment_shape.sql` の適用をユーザーに依頼する
2. **既存レイアウトを開いて、図・配置率・要確認件数が以前とまったく同じであること**（ここが本フェーズの肝）
3. 機材の追加・編集・複製・保存・開き直しが今までどおり動くこと
4. ダッシュボードから1件だけ手で L字の `shape` を入れ、その機材を配置して保存 → 開き直したとき、`placement.snapshot.shape` に形が入っていること（画面はまだ矩形で描かれる。これで正しい）

## 成果物

- `project-docs/sql/007_equipment_shape.sql`（新規・ユーザーが適用）
- `docs/assets/js/equipments.js` / `geometry.js` / `packing.js`
- `tests/geometry.test.mjs`

見た目の変更が無いフェーズなので、**「何も変わっていないこと」を確認した結果を具体的な数値で報告する**こと（開いたレイアウト名、配置率、要確認件数の変化なし、など）。
