# Phase 5 修正プロンプト（多角形シンボル: レビュー指摘の対応）

Phase 5 の実装をレビューした結果の修正指示。**未コミット・未pushの状態から続ける。**

判定ロジック（`geometry.js`）・集計・仕様書・テストは意図どおりで、`npm test` は 222件すべて通っている。
`npm run build:css` も実行済み。修正が必要なのは以下。

---

## 必須修正1: 円・多角形の外周線がマスクで切り落とされている（描画バグ）

**現象**: 円や多角形を含む機材の外周線が、下端の一部（およそ 254mm ぶん）しか描かれない。
L字など**矩形だけの形は正常**（従来の `unionOutline` 経路のため）。

実際のレンダラー（`renderTruck`）で再現済み。1700 × 4400mm の荷台に φ900 の円と台形を置くと、
円は下側の弧だけ、台形は下辺付近だけに線が出て、上半分には線が出ない。

**原因**: `docs/assets/js/renderer.js` の `outlineMask()` が `<mask>` に
`maskUnits="userSpaceOnUse"` を指定しているのに **`x` / `y` / `width` / `height` を指定していない**。

SVGの `<mask>` は、この4つを省略すると既定値 `-10% / -10% / 120% / 120%` になる。
`maskUnits="userSpaceOnUse"` のときこのパーセントは**ビューポート基準**で解決されるため、
マスク領域が `y ≥ -0.1 × ビューポート高さ`（2tロングなら -254mm）に限られる。

機材のローカル座標は `y ∈ [-機材の幅, 0]` の負の領域に伸びるので、
**幅が 254mm を超える機材は、外周線の大部分が領域外として消える**。塗り（`fill`）はマスクを
参照していないため無事で、線だけが欠ける。

**修正**: マスク領域を明示する。白い矩形に渡している値がそのまま使えるので、**同じ数値を
`<mask>` 要素にも書く**だけでよい。

```js
function outlineMask(id, drawing, strokeWidth) {
  const margin = strokeWidth * 2;
  const x = drawing.bounds.x - margin;
  const y = drawing.bounds.y - margin;
  const width = drawing.bounds.right - drawing.bounds.x + margin * 2;
  const height = drawing.bounds.bottom - drawing.bounds.y + margin * 2;
  // maskUnits="userSpaceOnUse" では x/y/width/height を省略すると既定値がビューポートの
  // 百分率で解決され、ローカル座標が負の側へ伸びる機材の外周線が切り落とされる。
  // マスク領域は必ず形の外形（＋線幅ぶんの余白）で明示すること。
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse"` +
    ` x="${x}" y="${y}" width="${width}" height="${height}">` +
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fff"/>` +
    `<path d="${drawing.fillPath}" fill="#000"/></mask></defs>`;
}
```

**この修正で正しく描かれることは確認済み。** 上のコメントは必ず残すこと。同じ罠を次に踏む。

**検証**: `renderTruck` を直接叩く使い捨てのページを `docs/` に置き、円・台形・L字を1台に並べて
目視する（確認後そのファイルは消すこと）。加えて**移動先ゴースト**（`showDropGhost`、線幅28）と
**選択枠**（線幅36）でも線が全周に出ることを見ること。

---

## 必須修正2: `shape-editor.js` と機材フォームのHTMLを、読める書き方に戻す

現在の `shape-editor.js` は、ほぼすべてのメソッドが1行に詰め込まれている
（`applyChamfer` は1行で約700文字）。HTML側も1行が400文字を超える塊になっている。
このリポジトリの既存コードは複数行＋日本語コメントで「なぜそうしているか」を残す書き方で揃っており、
`CLAUDE.md` の方針からも外れる。

- **メソッドを複数行に戻す。** 特に `applyChamfer` / `pointerMove` / `canvasPointerDown` /
  `addPolygonPoint` / `finishPolygon` / `partsMarkup` / `draftMarkup`
- **HTMLのパーツ一覧と角落としパネルを、1要素1行に近い形へ戻す。** 直前の版
  （`git show HEAD:docs/simulator.html` のエディタ部分）の書き方に合わせる
- **消えたコメントを復活させる。** 特に `partsMarkup` の上にあった次の説明は、
  これが無いと後から `x-for` に「整理」されて壊れる:

  ```
  /**
   * SVG内のtemplate要素はHTMLTemplateElementにならずAlpineのx-forで扱えないため、
   * renderer.jsと同様にSVGマークアップを文字列で組み立てる。
   */
  ```

  ファイル冒頭の「データ座標は x=幅、y=奥行のまま保ち、SVGへ描くときだけ荷台と同じ横向きへ写す」と、
  `prepareEquipmentShape` の「通常の矩形1枚なら shape=null に戻して、従来データと同じ表現にする」も同様に戻す
- 新しく入った非自明な判断にもコメントを足す。少なくとも次の3つ:
  - 円の作成でドラッグ量の**短いほう**を直径に採る理由
  - 頂点ドラッグ・数値入力で**凸を保てない操作を弾く**理由
  - `chamfers` を状態として持ち、`applyChamfer` で矩形を多角形へ**置き換える**設計（kindを増やさないため）

**動作は変えないこと。** 見た目・操作・保存結果は現状のままで、書き方だけを直す。

---

## 修正3: 多角形パーツの外形表示が別のパーツの値を出しうる

`docs/simulator.html` / `docs/admin.html` の多角形行で `normalized[index]` を参照しているが、
`normalized` ゲッターは `normalizedParts()` の中で `.filter(Boolean)` を使っており、
**不正なパーツがあると添字が `parts` とずれる**。前のパーツが一時的に不正な状態
（頂点を消している途中など）だと、隣のパーツの寸法が表示される。

そのパーツ自身から外形を出すこと。`shapeEditor` に

```js
partBounds(part) { const normalized = normalizedPart(part); return normalized ?? { w: 0, d: 0 }; }
```

のようなメソッドを足し、HTML からは `partBounds(part).w` を呼ぶ。
（`normalizedPart` は現在モジュール内のローカル関数なので、そのまま使える位置に置くこと。）

## 修正4: 「角落とし」ボタンが無反応に見える

`applyChamfer()` は落とし量が全部0だと黙って `return` する。ツールバーのボタンを押しても
何も起きないため、壊れているように見える。次のどちらかにすること。

- 落とし量が全部0なら `this.error = '角落とし量を入力してください。'` を出す、**または**
- 落とし量が全部0のあいだはボタンを `disabled` にする（`:disabled="!chamfers.some(v => v > 0)"`）

あわせて、角落としパネルの見出しに **「量を入れてから『角落とし』を押す」** と分かる語を足すこと。
現状の「角落とし量（左上 / 右上 / 右下 / 左下）」だけでは手順が読み取れない。

## 修正5: `computePush` のフォールバックのコメントが実態と合っていない

`geometry.js` の `computePush` は、重なりペアの収集を `partsOverlap` に変えてある。
`resolveOverlaps` のトリガも同じ `partsOverlap` なので、コメントにある
「厳密形状が干渉してもbbox対がトリガ条件に入らないことがある」という状況は**もう起きない**。

フォールバック自体は保険として残してよいので、コメントを実態に合わせること。例:

```js
// 呼び出し元と同じ partsOverlap で拾うため通常は空にならないが、
// 空のまま null を返すと押し出しが止まって重なりが残る。保険として bbox 全体を1組にする。
```

## 修正6: 多角形ツール中の Enter が数値入力欄でも効いてしまう

`editorKey` は `tool === 'polygon'` のとき Enter を無条件に `finishPolygon()` へ回している。
`deleteByKey` と同様に、`['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)` なら
何もしないようにすること。数値欄で Enter を押しただけで多角形が閉じる（または赤いエラーが出る）のを防ぐ。

---

## やらないこと

- 判定ロジック（`partsOverlap` / `isConvex` / SAT / 距離計算）の作り直し。**現状で正しい**
- 矩形どうしの判定を L∞ からユークリッドへ揃えること。**意図的に揃えていない**（コメントのとおり）
- `unionOutline` の削除。矩形だけの形は従来経路のままにする方針は正しい
- 仕様書の書き直し。5.1 / 6.2 / 6.3 / 6.5 / 4.4 の更新内容は正確
- テストの作り直し。追加分は妥当

---

## 完了条件

- `npm test` が通ること（222件。修正3〜6でテストを足す必要はないが、足しても良い）
- 円・台形を含む荷台で、**外周線が全周に出る**こと（PNG書き出しと印刷でも同じ）
- `shape-editor.js` と機材フォームのHTMLが、既存ファイルと同じ粒度で読めること
- 消えていたコメントが戻っていること
- Tailwindのクラスを増減した場合は `npm run build:css` を実行したこと
- 確認用に置いたファイル・機材・レイアウトを消したこと

## 報告に含めること

- 変更したファイルと、修正1〜6のどれに対応したか
- 修正1の確認方法と結果（どの形で全周に線が出たか）
- 動作を変えていないこと（修正2は書き方だけの変更であること）
