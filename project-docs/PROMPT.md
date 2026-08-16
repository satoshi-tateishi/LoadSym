# Phase 3 修正プロンプト その2（形状エディタ: viewBox が設定されない）

前回の修正（`x-html` によるパーツ描画）は**正しく入っている**。パーツの `<rect>` はDOMに生成され、Alpineのエラーも消えた。

しかし**キャンバスには依然としてパーツが表示されない**。原因は別にあり、そこを直す。

---

## 不具合

エディタのキャンバスに矩形パーツが表示されない（前回と同じ症状、別の原因）。

実測した事実:

```
svg の属性一覧:
  :viewbox="viewBox"            ← Alpineのバインド（属性名が小文字になっている）
  viewbox="0 0 2500 2800"       ← Alpineが書き込んだ結果。これも小文字
  preserveAspectRatio="xMidYMid meet"   ← 静的属性なので正しい大小文字のまま

svg.getAttribute('viewBox') → null
svg.viewBox.baseVal          → { w: 0, h: 0 }     ← 座標系が確立していない
```

その結果、パーツはmm値がそのままpxとして描かれる:

```
キャンバス実寸: 488 × 244 px
パーツ0の描画: x=326, y=2597, w=400, h=600 px   ← キャンバスのはるか下
パーツ1の描画: x=526, y=697,  w=200, h=100 px   ← 同じく画面外
```

## 原因

`:viewBox="viewBox"` というバインドが効かない。

HTMLパーサは属性名を小文字化するので、ソースに `:viewBox` と書いても DOM上は `:viewbox` になる。Alpineはその名前のまま `el.setAttribute('viewbox', ...)` を呼ぶが、**SVGの属性名は大文字小文字を区別する**ため `viewBox` は設定されない。

静的に書いた `preserveAspectRatio` が無事なのは、HTMLパーサがSVG要素の既知属性について大小文字を補正するため（"adjust SVG attributes"）。この補正は**パース時の静的属性にしか効かず、実行時の `setAttribute` には効かない**。

`renderer.js` が `svg.setAttribute('viewBox', ...)` とJSから正しい大小文字で書いているのは、この理由による。

該当箇所は2つ:

- `docs/simulator.html` 311行目付近
- `docs/admin.html` 368行目付近

（バインドでcamelCaseのSVG属性を使っているのはこの `:viewBox` だけ。他は小文字属性か静的属性なので問題ない）

## 直し方

バインドをやめ、**JSから正しい大小文字で設定する**。`x-effect` を使えば `viewBox` ゲッターの変化に追従できる。

```html
<svg x-ref="canvas" x-effect="$el.setAttribute('viewBox', viewBox)"
     class="block aspect-[2/1] w-full touch-none bg-slate-50"
     preserveAspectRatio="xMidYMid meet"
     @pointerdown="canvasPointerDown($event)" ...>
```

`:viewBox="viewBox"` は削除すること。**両方のHTMLに同じ修正を入れる。**

---

## 完了条件

前回と同じ轍を踏まないよう、**「DOMに要素がある」では合格にしない**。実際に画面上のどこに、どんな大きさで描かれているかを測ること。

### 1. 座標系と描画位置（最初に必ずこれを確認する）

```js
// エディタを開いてパーツを1つ描いたあと、コンソールで実行
const svg = document.querySelector('form svg[x-ref="canvas"]');
const canvas = svg.getBoundingClientRect();
console.log('viewBox属性', svg.getAttribute('viewBox'));        // → "0 0 ..." が入ること
console.log('baseVal', svg.viewBox.baseVal.width, svg.viewBox.baseVal.height); // → どちらも 0 より大きいこと
[...svg.querySelectorAll('[data-part-index]')].forEach(r => {
  const b = r.getBoundingClientRect();
  console.log(r.dataset.partIndex, Math.round(b.width), Math.round(b.height),
    '画面内:', b.width > 0 && b.height > 0 &&
      b.left >= canvas.left - 1 && b.right <= canvas.right + 1 &&
      b.top >= canvas.top - 1 && b.bottom <= canvas.bottom + 1);
});
```

**すべてのパーツが「画面内: true」になること。**

### 2. 目視（スクリーンショットを撮って確認すること）

- 描いた矩形がキャンバス上に残って見える
- 選択中のパーツが青くハイライトされる
- コンソールにエラー・警告が1件も出ない

### 3. ここから先は前回のプロンプトで一度も到達できていない項目

1. 「選択・移動」でキャンバス上のパーツをクリック → 選択され、ドラッグで動く
2. パーツを2つ並べてL字を作り、「形を反映」→ 名前を付けて機材を保存
3. 保存した機材を荷台に置くと、**エディタで描いたとおりの向き・形**で出る（回転0）
   - エディタと荷台のスクリーンショットを並べて、向きが一致していることを確認する
4. その凹みに別の機材が入る
5. パーツを重ねて「形を反映」→ 「重なっています」で止まる
6. 「矩形に戻す」で通常の矩形に戻る
7. **Adminアカウントで `admin.html` のテンプレート機材でも 1〜6 が同じように動く**
8. Viewerでは機材の追加・編集ボタンが無効のまま
9. **既存レイアウトを開いて図が以前と同じ**
   （`0e44f14e-e28b-429f-bd1b-5e66f90ee57f` は スロット1が 機材5点 / 配置率 11.8% / 総重量 150kg / 要確認 0）

### そのほか

- `npm test` が通ること（今回はロジックを変えないので既存の187件が通ればよい）
- Tailwindのクラスを増減したら `npm run build:css`
- 確認用に作った機材を削除する

## 報告に含めること

- 完了条件1の出力（`viewBox` 属性の値、`baseVal` の値、各パーツの「画面内: true」）
- 完了条件3-3のスクリーンショット2枚（エディタ／荷台）で向きが一致していること
- 完了条件9の数値
- 確認用データを削除したこと
