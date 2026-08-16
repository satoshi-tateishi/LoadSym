# Phase 1 実装プロンプト（多角形シンボル: 幾何エンジン）

このファイルは、`IMPLEMENT_PHASE.md` の **Phase 1** を単独で実行するための作業指示書。

---

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトのルール）
2. `project-docs/IMPLEMENT_PHASE.md`（全体のフェーズ分割。**設計の芯「二層に分ける」は必ず読むこと**）
3. `docs/assets/js/geometry.js` 全体（コメントに設計判断の理由が書いてある。消さないこと）

## Phase 0 で入っているもの（前提）

- `equipments.shape jsonb`（`007_equipment_shape.sql` 適用済み。既存データはすべて `null`）
- `docs/assets/js/geometry.js` に `toParts(placement)` / `boundsOf(parts)` / `normalizeShape(shape, w, d)`
- `placements.equipment_snapshot` に `shape` が乗る（保存時に形を固定する）
- 実データに形を持つ機材は**まだ1件も無い**

## このフェーズのゴール

**判定・吸着・押し出し・空き探索をパーツ単位にする。** ここが本体。

描画は Phase 2、形状エディタは Phase 3。**このフェーズでは `renderer.js` を触らない。**
実データに形を持つ機材が無いので、画面の見た目は変わらない。検証は `shape` を手で入れた機材で行う。

## 守るルール

- コメントは**日本語**。既存コメントの「なぜそうしているか」を消さない
- 動作検証は必須（`npm test` ＋ ローカルサーバでの手動確認）
- コミット・pushはユーザーの指示があるまで行わない
- `docs/assets/css/styles.css` は生成物（今回はCSS変更なしのはず）

---

## 共通の表現を決める（最初にやること）

判定系の関数は、矩形の配列ではなく**形の配列**を受け取るようにする。

```js
// 形 = { id, parts }   parts は絶対座標の軸平行矩形 [{ x, y, w, d }, ...]
export function toShape(placement)   // { id, parts: toParts(placement) の座標部分 }
export function rectToShape(rect)    // 障害物など1枚の矩形を形にする
```

障害物も「1パーツの形」として同じ経路に乗せる（障害物自体は矩形のまま。Phase 1 で形を持たせるのは機材だけ）。

## 作業1: `toParts` の回転基準を形自身のbboxにする

現在は回転の基準に `snapshot.widthMm / depthMm` を使っている。これが形のbboxとずれていると、回転したときにパーツが枠の中で飛ぶ。

**shape がある場合は、パーツ群のbboxから `w0 / d0` を求めて回転させること。** 形が真であり、`width_mm` / `depth_mm` は一覧表示用の値と位置づける（形状エディタは両者を揃えて保存するが、手入力やCSVでずれる余地がある）。

テスト: `width_mm` がbboxより大きい形でも、`toParts` の結果が0/90/180/270 で形の外形を保つこと。

## 作業2: `shapesOverlap(a, b, gap)`

パーツ総当たりで `rectsOverlap` が1組でも真なら真。`rectsOverlap` は**下位プリミティブとして残す**（既存の意味論そのまま）。

計算量は 20配置 × 数パーツの総当たりで数千ペア。実用上問題にならないので、素直に二重ループでよい。

## 作業3: `findInvalidRects` を形状対応にする

- 機材どうし … `shapesOverlap(a, b, clearanceMm)`
- 壁 … `fitsInBed(boundsOf(shape.parts), bed, clearanceMm)`
  - **壁判定をbboxのままにするのは意図的**。「荷台幅いっぱいの機材は両側にクリアランスを取れないので、収まっていれば良しとする」という逃がし方が `clampToBed` と揃えてあり、ここを崩すと直しようのない赤が残る
- 障害物 … `shapesOverlap`（障害物は1パーツの形）

関数名は `findInvalidShapes` に改名してよい。呼び出し元は `packing.js` の2か所だけ。

## 作業4: `snapPosition` の候補をパーツ基準にする

x軸とy軸を独立に評価する構造は**現行のまま**。候補の作り方だけ変える。
移動側パーツの原点オフセットを `mp.dx / mp.dy`（＝パーツのローカル位置）として:

- 隣接（クリアランスあり）: `other.x + other.w + clearance - mp.dx` / `other.x - mp.w - clearance - mp.dx`
- 整列（クリアランスなし）: `other.x - mp.dx` / `other.x + other.w - mp.w - mp.dx`

移動側の全パーツ × 相手の全パーツで候補を作る。壁の候補は bbox 基準（`clearance - bounds.dx` など）。

## 作業5: `resolveOverlaps` / `computePush`

- 押し出しの起動判定は `shapesOverlap`
- 押し出し量は、**重なっているパーツ対それぞれの必要移動量を4方向について求め、方向ごとに最大値**を取る（1組だけ見ると別のパーツがまだ食い込む）
- そのあとのスコア評価（はみ出し・不動オブジェクトとの重なり・軸切り替えのペナルティ）と `lockedAxis` による振動防止は**現行のまま**
- `isInsideBed` の判定は bbox で行う

## 作業6: `findFreeSpot` を形で探す

引数を `size {w, d}` から**形（parts）**に変える。候補は既存パーツの辺＋壁ぎわ（`edgeCandidates` をパーツ単位に）、判定は `shapesOverlap`。
「辺を基準に候補を作る」理由（固定間隔の格子だと隙間を見落とす）は現行コメントのとおりなので維持する。

呼び出し元（`createPlacement` / `duplicatePlacement`）は、回転後のパーツを渡すように直す。

## 作業7: `packing.js` の追随

- `placementRects(slot)` → `placementShapes(slot)`、`obstacleRects(slot)` → 形を返す
- `settle` / `invalidIdsOf` / `summarize` / `rejects` は呼び出しの差し替えのみ。**棄却の考え方（2系統に分ける理由）は変えない**
- `summarize.floorAreaRatio` … **パーツ面積の合計**にする（凹み分が引かれ、配置率が実態に近づく）。矩形しか無い既存データでは値が変わらないことをテストで担保する
- `clampToBed` / `clearances` … bbox基準のまま（壁で止める挙動と寸法パネルの表示を維持）

---

## 完了条件

### 自動テスト（`npm test` が通ること）

**既存テストが1つも壊れないこと**（矩形は1パーツの特殊ケースとして通るはず）。そのうえで追加する:

- L字の凹みに別の機材が入る（外形矩形なら弾かれる配置が、辺基準では通る）
- L字と別機材が1mm重なったら両方が赤くなる
- L字の袖の辺に吸着する / 本体の辺に吸着する
- L字を押し出したとき、凹み側へ逃げられる
- 複数パーツが同時に食い込んでいるとき、**深いほうの必要量だけ**押し出される
- `findFreeSpot` がL字の凹みを空きとして見つける
- 配置率がパーツ面積の合計になる（矩形のみの構成では従来と同値）

### 手動確認（`npm run serve` + `test-account.json`）

形を持つ機材がまだ無いので、確認用に1件だけ作る。**確認が終わったら消すこと。**

```js
// ブラウザのコンソール（シミュレーター画面）で実行
const { createEquipment } = await import('./assets/js/equipments.js');
const c = Alpine.$data(document.querySelector('main'));
await createEquipment({
  name: '【テスト】L字卓', category_id: c.defaultCategoryId,
  width_mm: 1770, depth_mm: 460, height_mm: 800, weight_kg: 40, color: '#63a1e4',
  shape: { parts: [
    { kind: 'rect', x: 0,    y: 0, w: 1370, d: 460 },
    { kind: 'rect', x: 1370, y: 0, w: 400,  d: 250 }
  ] }
}, c.session.user.id);
```

1. **既存レイアウトを開いて、配置率・要確認件数が以前と変わらないこと**
   （`0e44f14e-e28b-429f-bd1b-5e66f90ee57f` は Phase 0 時点で スロット1が 機材5点 / 配置率 11.8% / 総重量 150kg / 要確認 0）
2. L字を置き、凹みの位置に別の機材をドラッグ → **入ること**（描画は矩形のままなので、判定結果は要確認件数と `toParts` の値で確かめる）
3. L字を回転（R）しても凹みの向きが正しく追従すること
4. 密に詰めた状態でL字を押し込み、押し出しが振動せず収束すること

## やらないこと

- `renderer.js`（Phase 2）
- 形状エディタ（Phase 3）
- 仕様書の更新（Phase 4。ただし**配置率の意味が変わる**ことは報告に含めること）

## 報告に含めること

- 追加・変更した関数の一覧と、既存テストが全数通ったこと
- 上記の手動確認1の数値（変化が無いこと）
- 作った確認用機材を削除したこと
