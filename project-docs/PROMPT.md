# Phase 2 実装プロンプト（多角形シンボル: 描画）

このファイルは、`IMPLEMENT_PHASE.md` の **Phase 2** を単独で実行するための作業指示書。

---

## 最初に読むもの

1. `CLAUDE.md`（プロジェクトのルール）
2. `project-docs/IMPLEMENT_PHASE.md`
3. `docs/assets/js/renderer.js` 全体（**横向き表示の座標変換**の説明が冒頭にある。ここを理解してから手を入れること）

## Phase 0 / 1 で入っているもの（前提）

- `equipments.shape jsonb`、`placements.equipment_snapshot.shape`（形は保存時に固定される）
- `geometry.js` … `toParts(placement)` / `toShape(placement)` / `boundsOf(parts)` / `shapesOverlap(a,b,gap)` / `findInvalidShapes` / `rectToShape`
- 判定・吸着・押し出し・空き探索は**すべて形（パーツ集合）で動いている**
- **`renderer.js` だけが `toRect()`（外形bbox）のまま。** L字を置いても四角く描かれる

## このフェーズのゴール

**L字がL字に見えること。かつ、1個の機材として見えること。**

形状エディタは Phase 3。このフェーズでは形の入力手段を作らない（確認は下のスニペットで作る機材で行う）。

## 守るルール

- コメントは**日本語**。既存コメントの「なぜそうしているか」を消さない
- 動作検証は必須（`npm test` ＋ ローカルサーバでの目視確認）
- コミット・pushはユーザーの指示があるまで行わない
- `docs/assets/css/styles.css` は生成物（今回はCSS変更なしのはず）

---

## 作業1: 機材1個を「2つのpath + text」で描く

現在は `<g>` の中に `<rect>` 1枚と `<text>`。これを次の構成にする。

```
<g class="placement" data-placement-id="..." transform="translate(vx, vy)">
  <path class="fill"    d="M... 各パーツの矩形をサブパスで並べる ..." fill="色" fill-opacity="0.7"/>
  <path class="outline" d="M... 外周だけの線分 ..." fill="none" stroke="..." stroke-width="..."/>
  <text .../>
</g>
```

**塗りを1枚のpathにまとめる理由**: パーツごとに `<rect fill-opacity="0.7">` を並べると、パーツが重なった部分だけ色が濃くなる。1つのpathにサブパスとして入れれば、塗りは一度しか乗らない。

**当たり判定が形に沿うようになる副次効果**もある。`onStagePointerDown` は `closest('[data-placement-id]')` で拾っているので、L字の凹みをクリックしたときに**L字ではなく凹みに入っている機材**が選ばれる。これは正しい挙動なので、そのまま活かす。

座標は `toParts(placement)` を使い、各パーツを `toViewRect(bed, part)` でビュー座標へ写す（`toRect` からの置き換え）。

## 作業2: 外周線（union outline）を求める

パーツ境界の内側に線が出ると1個の機材に見えない。**unionの境界だけ**を線分として描く。

パーツは重ならない前提だが、重なっていても正しく動くアルゴリズムにしておくこと（手入力のデータが来る）。

```
1. 全パーツから辺を集める
   垂直辺: x = part.x と x = part.x + part.w、区間 [part.y, part.y + part.d]
   水平辺: y = part.y と y = part.y + part.d、区間 [part.x, part.x + part.w]
2. 同じ座標値を持つ辺の区間の端点をすべて集め、区間を分割する
3. 各サブ区間について、辺の両側（座標 ±0.5mm）の中点がパーツ集合の内部にあるかを判定する
4. 片側だけが内部のサブ区間＝境界。両側とも内部＝内部線なので描かない
5. 残った線分を1つのpathにまとめる（隣接する線分の結合は不要）
```

座標は整数mmなので ±0.5mm のサンプリングで判定が壊れることはない。パーツ数は数個なので総当たりでよい。

線の色と太さは現行の矩形と同じ規則にする（選択中: `#1d4ed8` / 18、エラー: `#991b1b` / 8、通常: `#334155` / 8）。

## 作業3: ラベル

**最大面積のパーツの中心**に置き、そのパーツのボックスで `chooseLabel()` を呼ぶ。縦横どちらに寝かせるかの判定は現行のロジックをそのまま使う。

外形bboxの中心に置くと、L字では文字が機材の外（凹みの空間）に浮くことがある。

## 作業4: ドラッグ中の更新を transform に変える

`updatePlacementPosition()` は現在 rect の x/y/width/height を書き換えている。パーツと外周線に増えるので、**`<g>` の `transform="translate(...)"` を書き換える方式**にする。書き換えは1属性で済み、パーツ数が増えても変わらない。

**座標変換に注意**（`renderer.js` 冒頭の説明のとおり）:

```
ビューX = 荷台の y
ビューY = 荷台の w - 荷台の x
```

したがって荷台座標の移動 `(dx, dy)` は、**ビュー座標では `(dy, -dx)`** になる。ここを間違えると、ドラッグ中だけ機材が90度ずれた方向へ動く。

初期描画時にパーツをどの原点で描くか（絶対座標で描いて transform は差分にするか、ローカル座標で描いて transform を絶対位置にするか）は実装者が決めてよいが、**`renderTruck` の再描画結果とドラッグ中の見た目が一致すること**を必ず確認すること。

## 作業5: 移動先ゴースト（`showDropGhost`）

同じくパーツ塗り＋外周線（破線）にする。ゴーストの見た目の規則（塗り 0.35 / 青の破線 / ラベル薄め）は現行を踏襲する。
`clearDropGhost` / `dimPlacement` はそのまま使える。

## 作業6: 障害物

障害物は矩形のまま（Phase 1 の決定どおり）。`renderObstacles` は変更不要。

## 作業7: あわせて片付ける（Phase 1 の置き土産）

Phase 1 で入った**テストのためだけの互換コード**が残っている。アプリ本体はどこからも使っていないので、この機会に消す。

- `geometry.js` の `snapPosition` 内の `boundsOffset`（`movingBounds.x - origin.x` は常に 0。読む人を迷わせる）
- 矩形を受け付ける互換経路: `findInvalidRects`、`resolveOverlaps` の `receivedRects` / `result.rects`、`snapPosition` と `findFreeSpot` の矩形受け入れ
- 上を消すために、`tests/geometry.test.mjs` の矩形ベースのテストを**形（`rectToShape`）ベースへ移す**。テスト内容は変えない

テストだけのための互換層を残すと、次に触る人が「本番でも使われている」と誤解する。

---

## 完了条件

### 自動テスト（`npm test` が通ること）

`renderer.js` はDOMに依存するので単体テストは書かない。作業7の移行後、**既存テストが全数通ること**を確認する。

外周線の計算だけは純粋関数として切り出せるので、可能なら `geometry.js` 側に置いてテストを書く:

- 単独の矩形 → 4辺すべてが外周
- L字（2パーツ）→ 共有辺が消え、外周が6本の線分になる
- 田の字に4パーツを並べた場合 → 内側の十字が消える

### 手動確認（`npm run serve` + `test-account.json`）

確認用のL字機材を作る。**終わったら必ず消すこと。**

```js
// シミュレーター画面のコンソールで実行
const { createEquipment } = await import('./assets/js/equipments.js');
const c = Alpine.$data(document.querySelector('main'));
await createEquipment({
  name: '【テスト】L字卓', category_id: c.defaultCategoryId,
  width_mm: 1770, depth_mm: 900, height_mm: 800, weight_kg: 40, color: '#63a1e4',
  shape: { parts: [
    { kind: 'rect', x: 0, y: 0,   w: 1770, d: 460 },
    { kind: 'rect', x: 0, y: 460, w: 600,  d: 440 }
  ] }
}, c.session.user.id);
```

1. L字が**L字に描かれ、内部に線が出ない**こと
2. 選択枠の青、エラーの赤（クリアランス設定を広げて赤くする）が外周に沿うこと
3. **ドラッグ中の追従がずれないこと**（作業4の座標変換。斜めにドラッグして確かめる）
4. エリアをまたぐドラッグで、移動先のゴーストもL字であること
5. 90度ずつ4回転させて、1周で元に戻ること
6. 凹みに別の機材を置き、**凹みの部分をクリックすると中の機材が選ばれる**こと
7. PNG書き出しと印刷で同じ見た目になること（`export-png.js` はSVGをそのまま描くので、pathでも問題ないはず）
8. **既存レイアウトを開いて、図が以前とまったく同じであること**
   （`0e44f14e-e28b-429f-bd1b-5e66f90ee57f` は スロット1が 機材5点 / 配置率 11.8% / 総重量 150kg / 要確認 0）

## やらないこと

- 形状エディタ（Phase 3）
- 仕様書の更新（Phase 4）

## 報告に含めること

- 変更した関数の一覧
- 上記の手動確認8の数値（変化が無いこと）
- 作った確認用機材を削除したこと
- 作業7で消した互換コードの一覧
