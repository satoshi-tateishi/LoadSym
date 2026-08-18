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

const MAX_LONG_EDGE_PX = 3600;
const JPEG_QUALITY = 0.88;

// styles.css の html,:host セレクタ（Tailwind base）と body の font-feature-settings を
// そのまま転記したもの。画面表示中の機材名テキストと同じ見え方になるよう、
// 書き出し用SVGのルートにも同じ値を明示する。
const PAGE_FONT_FAMILY =
  'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';
const PAGE_FONT_FEATURE_SETTINGS = '"palt"';

// 画像の左上に載せるタイトル行の見た目。SVG側（画面表示・印刷）には手を入れず、
// 書き出し用canvasの最上部に白背景の帯を足して文字を描く。
const TITLE_BAR_HEIGHT_PX = 56;
const TITLE_FONT_PX = 30;
const TITLE_PADDING_PX = 18;

/**
 * SVG要素をJPEGとしてダウンロードさせる。
 * @param {SVGElement} svg 対象のSVG
 * @param {string} fileName 拡張子を含むファイル名
 * @param {string} [title] 画像左上に載せる見出し（レイアウト名 : トラック名など）
 */
export async function downloadSvgAsJpeg(svg, fileName, title) {
  const blob = await renderSvgToJpegBlob(svg, title);
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

async function renderSvgToJpegBlob(svg, title) {
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

    // 小さいトラックまで無闇に引き伸ばさないよう、最大2倍までに留める。
    const scale = Math.min(2, MAX_LONG_EDGE_PX / Math.max(width, height));
    const drawWidth = Math.round(width * scale);
    const drawHeight = Math.round(height * scale);
    const titleBarHeight = title ? TITLE_BAR_HEIGHT_PX : 0;

    const canvas = document.createElement('canvas');
    canvas.width = drawWidth;
    canvas.height = drawHeight + titleBarHeight;

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, titleBarHeight, drawWidth, drawHeight);

    if (title) {
      drawTitle(context, title, canvas.width);
    }

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('JPEGの生成に失敗しました。'));
      }, 'image/jpeg', JPEG_QUALITY);
    });
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** タイトル帯に見出しを描く。幅に収まらなければ省略記号で切り詰める。 */
function drawTitle(context, title, canvasWidth) {
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

  context.fillText(text, TITLE_PADDING_PX, TITLE_BAR_HEIGHT_PX / 2);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('図の読み込みに失敗しました。'));
    image.src = url;
  });
}
