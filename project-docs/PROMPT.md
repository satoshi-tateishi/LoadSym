# Phase 3 修正プロンプト（形状エディタ: キャンバスにパーツが描かれない）

Phase 3 の実装のうち、**データ側（`prepareEquipmentShape` / 保存経路 / 両フォームへの組み込み）は正しく動いている**。
キャンバスの描画だけが機能しておらず、そこを直す。

---

## 不具合

**エディタのキャンバスに、矩形パーツが1つも描画されない。**

再現手順（`npm run serve` → Editorでログイン → 機材シンボルの「追加」 → 「形を編集」 → 「＋ 矩形」 → キャンバスをドラッグ）:

- ドラッグ中の破線プレビューは出る
- 離すと**パーツは消える**。右の数値一覧には正しく追加され、外形も `900 × 400 mm` と更新される
- つまり**モデルは正しく、描画だけが出ていない**

確認した事実:

```
モデル上のパーツ数: 3
SVG内のrect要素:   3   ← 内訳は グリッド背景 / 未使用 / ドラッグ中のプレビュー のみ
template.content:  undefined
```

コンソールに毎回出ているエラー:

```
Alpine Expression Error: Cannot read properties of undefined (reading 'children')   Expression: "parts"
Alpine Expression Error: index is not defined   Expression: "selectedIndex === index ? '#93c5fd' : '#cbd5e1'"
```

## 原因

`<svg>` の内側に置いた `<template x-for="(part, index) in parts">` が効いていない。

HTMLパーサはSVGの内側の `<template>` を**SVG名前空間の要素**として作る。`HTMLTemplateElement` ではないので `.content` が存在せず（上の `undefined`）、Alpineの `x-for` はテンプレートの中身を読めずに失敗する。パーツ用の `<rect>` が生成されないため、次がすべて成立していない。

- パーツが見えない（作っている形を確認できない）
- `partPointerDown` を持つ要素が存在しないので、**キャンバス上での選択・移動ができない**（「選択・移動」ツールが無反応）
- 選択中のパーツのハイライトも出ない

`simulator.html` と `admin.html` の**両方**が同じ markup なので、両方で起きている。

## 直し方

`<template x-for>` をSVGの内側で使うのを諦め、**マークアップ文字列を組み立てて `x-html` で流し込む**。`renderer.js` が既に同じやり方（文字列でSVGを組む）をしているので、書き味も揃う。

### 1. `docs/assets/js/shape-editor.js` に描画用のgetterを足す

```js
get partsMarkup() {
  return this.parts.map((part, index) => {
    const box = viewRect(part, this.widthExtent);
    const selected = this.selectedIndex === index;
    return `<rect data-part-index="${index}" x="${box.x}" y="${box.y}"` +
      ` width="${box.w}" height="${box.h}"` +
      ` fill="${selected ? '#93c5fd' : '#cbd5e1'}" fill-opacity="0.8"` +
      ` stroke="${selected ? '#1d4ed8' : '#475569'}" stroke-width="8"/>`;
  }).join('');
}
```

### 2. 両方のHTMLで、`<template x-for>` のブロックを1行に置き換える

```html
<g x-html="partsMarkup"></g>
```

ドラッグ中のプレビュー（`<rect x-show="draft">`）は素の要素なので**そのまま**でよい。

### 3. パーツのクリック判定をイベント委譲にする

要素ごとの `@pointerdown` が無くなるので、`canvasPointerDown` の先頭で当たりを見る。

```js
canvasPointerDown(event) {
  if (event.button !== 0) return;
  const hit = event.target.closest?.('[data-part-index]');
  if (hit) {
    this.partPointerDown(event, Number(hit.dataset.partIndex));
    return;
  }
  ...  // 以降は現行のまま
}
```

`partPointerDown` から `event.stopPropagation()` は外してよい（委譲元から直接呼ぶため）。

## あわせて直すもの

### 4. 最初のキャンバスが小さすぎて、実寸の機材を描けない

`MIN_CANVAS_MM = 1000` なので、新規機材（600×400）でキャンバスは 1000×1000mm。**1770mm の卓を一筆で描けない**。パーツを足すたびに広がる作りだが、最初の一手が制限されるのは不便。

`MIN_CANVAS_MM` を **2500** に上げる。現場の機材はほぼ収まり、100mmグリッドも読める粗さのまま。それより大きいものは数値欄で直せるので、キャンバス脇の説明文に一言添えておくとよい。

### 5. テストの書き方を既存に揃える

`tests/shape-editor.test.mjs` だけ `node:assert` を使い、出力が `shape-editor tests: ok` の1行になっている。他の2ファイルは、
ケースごとに `ok 名前` を出して最後に `N passed, 0 failed` を出す**自前の小さなハーネス**で書かれており、`npm test` の出力もその形で揃っている。

同じ `eq()` の形に書き直すこと。テストの内容（bbox原点への正規化 / 矩形1枚なら `shape=null` / 重なりの棄却 / 寸法上限）は今のままでよい。

> `package.json` に `"type": "module"` を足して警告を消そうとしないこと。`tailwind.config.js` が CommonJS（`module.exports`）なので、CSSビルドが壊れる。

---

## 完了条件

### 自動テスト

- `npm test` が通ること（3ファイルとも、既存と同じ形式で件数が出ること）

### 手動確認（`npm run serve` + `test-account.json`）

**今回の不具合は「モデルは正しいが描画されない」ものだったので、モデルではなくDOMを見て確認すること。**

1. 「＋ 矩形」でキャンバスをドラッグ → **離した後もパーツが残って見える**
   - 確認方法: キャンバスSVGの中に、グリッドとプレビュー以外の `<rect>` が**パーツの数だけ**存在すること
2. **コンソールにAlpineのエラーが1件も出ないこと**
3. 「選択・移動」でキャンバス上のパーツをクリック → 選択色に変わり、ドラッグで動く
4. パーツを2つ並べてL字を作り、「形を反映」→ 機材を保存
5. 保存した機材を荷台に置くと、**エディタで描いたとおりの向き・形**で出る（回転0）
6. その凹みに別の機材が入る
7. パーツを重ねて「形を反映」→ 「重なっています」で止まる
8. 「矩形に戻す」で通常の矩形に戻る
9. **Adminアカウントで `admin.html` のテンプレート機材でも 1〜8 が同じように動く**
10. Viewerでは機材の追加・編集ボタンが無効のまま
11. **既存レイアウトを開いて図が以前と同じ**
    （`0e44f14e-e28b-429f-bd1b-5e66f90ee57f` は スロット1が 機材5点 / 配置率 11.8% / 総重量 150kg / 要確認 0）

### そのほか

- Tailwindのクラスを増減したら `npm run build:css` を実行する
- 確認用に作った機材を削除する

## 報告に含めること

- 手動確認1と2の結果（**パーツの `<rect>` が実際にDOMにある**こと、コンソールが無警告であること）
- 手動確認11の数値
- 確認用データを削除したこと
