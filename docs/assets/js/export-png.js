// 荷台図のPNG書き出し。
//
// SVGをそのままImageに読ませてcanvasへ描き、toBlobで保存する。
// 描画に使っているのはプレゼンテーション属性（fill / stroke / font-size）だけで
// 外部CSSに依存していないため、シリアライズした文字列だけで再現できる。
//
// 注意: canvasにSVGを描く際、外部リソース（画像やWebフォント）を参照していると
// 汚染されてtoBlobが失敗する。フォントは指定せず、閲覧環境の既定フォントに任せている。

const SCALE = 2;

/**
 * SVG要素をPNGとしてダウンロードさせる。
 * @param {SVGElement} svg 対象のSVG
 * @param {string} fileName 拡張子を含むファイル名
 */
export async function downloadSvgAsPng(svg, fileName) {
  const blob = await renderSvgToPngBlob(svg);
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

async function renderSvgToPngBlob(svg) {
  const viewBox = svg.viewBox.baseVal;
  const width = Math.round(viewBox.width);
  const height = Math.round(viewBox.height);

  // 元のDOMを触らないよう複製し、ラスタライズに必要な寸法と名前空間を与える。
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);

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
    const canvas = document.createElement('canvas');
    canvas.width = width * SCALE;
    canvas.height = height * SCALE;

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNGの生成に失敗しました。'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('図の読み込みに失敗しました。'));
    image.src = url;
  });
}
