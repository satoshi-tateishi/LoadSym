// 荷台図のJPEG書き出し。
//
// SVGをそのままImageに読ませてcanvasへ描き、toBlobで保存する。
// 描画に使っているのはプレゼンテーション属性（fill / stroke / font-size）だけで
// 外部CSSに依存していないため、シリアライズした文字列だけで再現できる。
//
// 注意: canvasにSVGを描く際、外部リソース（画像やWebフォント）を参照していると
// 汚染されてtoBlobが失敗する。Webフォントは使わず、OS同梱のフォントだけで完結する
// フォントスタックを明示している（下記PAGE_FONT_FAMILY）。
//
// このフォント指定は省略できない。Blob URL経由で読み込むSVGは画面のHTMLとは
// 別ドキュメントとして扱われ、styles.cssのfont-family（html,:host セレクタ）を
// 継承しないため、指定しないとブラウザのSVG既定フォントで描かれてしまい、
// 画面表示と書き出し画像とで機材名の文字サイズ・字形の見え方がずれる。
//
// PNG（ロスレス）だと荷台図のような矩形＋罫線＋テキストが中心の画像でも
// 数MBになってしまうため、JPEGの非可逆圧縮を使ってファイルサイズを抑える。
// 白背景で単色のベタ塗りが多い画像はJPEGの圧縮効率が高く、画面表示程度の
// 用途であれば品質を落としても体感の劣化はほぼない。
//
// viewBoxはmm単位をそのままcanvas pxとして使っているため、長尺トラック
// （例: 11t-Longは奥行き9500mm）は等倍拡大しただけでも数千万pxの巨大な
// canvasになりJPEGでも数MB出てしまう。画面表示用途では印刷向けの解像度は
// 不要なので、長辺のpx数をMAX_LONG_EDGE_PXで頭打ちにしてから書き出す。
//
// レイアウトに複数台のトラックがある場合は、1枚のJPGに縦積みでまとめる
// （荷台図は横長なので、横に並べると非現実的な横幅になる）。トラック間の
// 縮尺（mm→px）は共通の1つに揃える。シミュレーター画面自体がすでに
// REFERENCE_DEPTH_MM（packing.js）でトラックの奥行きを正規化し、同じCSS幅で
// 表示することで共通縮尺になっているため、書き出し画像もそれに合わせる。

const MAX_LONG_EDGE_PX = 3600;
const JPEG_QUALITY = 0.88;

/** 縦積みのとき、あるトラックの図と次のトラックの見出しの間に空ける余白(px)。 */
const MULTI_TRUCK_GAP_PX = 16;

// styles.css の html,:host セレクタ（Tailwind base）と body の font-feature-settings を
// そのまま転記したもの。画面表示中の機材名テキストと同じ見え方になるよう、
// 書き出し用SVGのルートにも同じ値を明示する。
const PAGE_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
const PAGE_FONT_FEATURE_SETTINGS = '"palt"';

// 画像に載せるタイトル行の見た目。SVG側（画面表示・印刷）には手を入れず、
// 書き出し用canvasに白背景の帯を足して文字を描く。
const TITLE_BAR_HEIGHT_PX = 56;
const TITLE_FONT_PX = 30;
const TITLE_PADDING_PX = 18;

/**
 * レイアウトに含まれるトラック（最大3台）の図を1枚のJPEGとしてダウンロードさせる。
 * @param {{svg: SVGElement, label: string}[]} entries トラック1台ぶんのSVGと見出し（トラック名）。1件以上必須。
 * @param {string} fileNameBase 拡張子・トラック名を含まないファイル名の基部（レイアウト名など）
 * @param {string} layoutTitle 画像に載せるレイアウト名（無題の場合のフォールバック込みで呼び出し側が用意する）
 */
export async function downloadTruckImagesAsJpeg(entries, fileNameBase, layoutTitle) {
  if (entries.length === 1) {
    const blob = await renderSingleTruckJpegBlob(entries[0], layoutTitle);
    triggerDownload(blob, `${fileNameBase}_${entries[0].label}.jpg`);
    return;
  }

  const blob = await renderMultiTruckJpegBlob(entries, layoutTitle);
  triggerDownload(blob, `${fileNameBase}.jpg`);
}

/** 1台だけの場合の見た目（複数台対応前の書き出しと完全に同じ）。 */
async function renderSingleTruckJpegBlob(entry, layoutTitle) {
  const { image, width, height } = await loadSvgAsImage(entry.svg);
  const title = `${layoutTitle} : ${entry.label}`;

  const scale = Math.min(2, MAX_LONG_EDGE_PX / Math.max(width, height));
  const drawWidth = Math.round(width * scale);
  const drawHeight = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = drawWidth;
  canvas.height = drawHeight + TITLE_BAR_HEIGHT_PX;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, TITLE_BAR_HEIGHT_PX, drawWidth, drawHeight);
  drawTitle(context, title, canvas.width, { topY: 0 });

  return canvasToJpegBlob(canvas);
}

/**
 * 複数台ぶんを縦積みで1枚にまとめる。全トラックへ同じスケール（mm→px）を使うことで、
 * 実寸の大小関係を画像内でも保つ（小さいトラックが相対的に小さく描かれる）。
 */
async function renderMultiTruckJpegBlob(entries, layoutTitle) {
  const prepared = await Promise.all(
    entries.map(async (entry) => ({ ...(await loadSvgAsImage(entry.svg)), label: entry.label }))
  );

  const maxWidthMm = Math.max(...prepared.map((item) => item.width));
  const sumHeightMm = prepared.reduce((sum, item) => sum + item.height, 0);
  const scale = Math.min(2, MAX_LONG_EDGE_PX / Math.max(maxWidthMm, sumHeightMm));

  const drawn = prepared.map((item) => ({
    ...item,
    drawWidth: Math.round(item.width * scale),
    drawHeight: Math.round(item.height * scale)
  }));

  const canvasWidth = Math.round(maxWidthMm * scale);
  // 長辺をMAX_LONG_EDGE_PXへ収めるのは荷台図そのもの（scaleの対象）だけで、
  // タイトルバーぶんの高さはその上に単純加算する。1台書き出し時も同じ扱い
  // （タイトルバーぶんだけ長辺が超過する）なので、ここだけの特別対応ではない。
  const canvasHeight =
    TITLE_BAR_HEIGHT_PX +
    drawn.reduce((sum, item) => sum + TITLE_BAR_HEIGHT_PX + item.drawHeight, 0) +
    MULTI_TRUCK_GAP_PX * (drawn.length - 1);

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawTitle(context, layoutTitle, canvasWidth, { topY: 0 });

  let y = TITLE_BAR_HEIGHT_PX;
  drawn.forEach((item, index) => {
    drawTitle(context, item.label, canvasWidth, { topY: y });
    y += TITLE_BAR_HEIGHT_PX;
    context.drawImage(item.image, 0, y, item.drawWidth, item.drawHeight);
    y += item.drawHeight;
    if (index < drawn.length - 1) y += MULTI_TRUCK_GAP_PX;
  });

  return canvasToJpegBlob(canvas);
}

/**
 * SVG要素を、書き出しに使える状態のImageへ変換する。
 * 1台用・複数台用のどちらの経路でも必ずこの関数を通し、フォント指定や
 * Alpineディレクティブの除去といった前処理を分岐させないようにする。
 * @returns {Promise<{image: HTMLImageElement, width: number, height: number}>} width/heightはviewBox由来のmm整数
 */
async function loadSvgAsImage(svg) {
  const viewBox = svg.viewBox.baseVal;
  const width = Math.round(viewBox.width);
  const height = Math.round(viewBox.height);

  // 元のDOMを触らないよう複製し、ラスタライズに必要な寸法と名前空間を与える。
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  // font-familyはテキストへ継承されるので、ルートへ1回設定すれば足りる。
  clone.setAttribute(
    'style',
    `font-family: ${PAGE_FONT_FAMILY}; font-feature-settings: ${PAGE_FONT_FEATURE_SETTINGS};`
  );

  // 画面用SVGには Alpine の :style / @pointerdown などが残っている。
  // HTML上では有効でもXMLの属性名としては不正で、ImageがSVGを読み込めなくなるため、
  // ラスタライズに不要なディレクティブを複製側から除く。
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.startsWith(':') || attribute.name.startsWith('@') ||
          attribute.name.startsWith('x-')) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  // 背景を白で塗る。透過のままだと現場でそのまま印刷したとき文字が読めない。
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', viewBox.x);
  background.setAttribute('y', viewBox.y);
  background.setAttribute('width', width);
  background.setAttribute('height', height);
  background.setAttribute('fill', '#ffffff');
  clone.insertBefore(background, clone.firstChild);

  const source = new XMLSerializer().serializeToString(clone);
  const svgUrl = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = await loadImage(svgUrl);
    return { image, width, height };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** タイトル帯に見出しを描く。幅に収まらなければ省略記号で切り詰める。 */
function drawTitle(context, title, canvasWidth, { topY = 0, barHeight = TITLE_BAR_HEIGHT_PX } = {}) {
  context.fillStyle = '#0f172a';
  context.font = `bold ${TITLE_FONT_PX}px sans-serif`;
  context.textBaseline = 'middle';

  const maxWidth = canvasWidth - TITLE_PADDING_PX * 2;
  let text = title;
  if (context.measureText(text).width > maxWidth) {
    while (text.length > 0 && context.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    text = text ? `${text}…` : '';
  }

  context.fillText(text, TITLE_PADDING_PX, topY + barHeight / 2);
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('JPEGの生成に失敗しました。'));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // revokeが早すぎるとSafariでダウンロードが始まらないことがあるため少し待つ。
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('図の読み込みに失敗しました。'));
    image.src = url;
  });
}
