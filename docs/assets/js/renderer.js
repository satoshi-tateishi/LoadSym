// 荷台のSVG描画。
//
// Canvasではなく SVG を使う理由は、機材1個を1つの <g> として持てるため
// ヒットテストとポインタイベントをブラウザに任せられること、テキストの機材名が
// そのまま印刷とPNG書き出しに乗ることの2点。
//
// ■ 横向き表示について
// 荷台は幅より奥行きのほうが長いため（2tロングなら 1700 × 4400mm）、実寸の向きで
// 描くと縦長になって画面の左右を持て余す。そこで「進行方向の前方を画面左」にした
// 横向きで描く。
//
// データ側の座標系は変えない（x = 幅方向、y = 奥行き方向）。描画するときだけ
// 90度回した“ビュー座標”へ写す。こうすれば geometry.js / packing.js は一切影響を
// 受けず、回転をSVGのtransformでかけたときのように文字が寝てしまうこともない。
//
//     ビューX = 荷台の y（奥行き）        … 画面左が進行方向の前方
//     ビューY = 荷台の w - 荷台の x       … 画面下が荷台の左側
//
// viewBox は実寸mmで取り、CSSの幅でスケールする。つまり「ズーム」は viewBox の
// 操作だけで済み、描画側は常にmmで考えればよい。

import { partArea, toParts, unionOutline } from './geometry.js';
import { bedOf, obstacleRects } from './packing.js';

/**
 * 尺規（目盛り）を描くために荷台の外側に確保する余白(mm)。
 * 左端は "4000" のような4桁の数値が入るため、font-size 110mm では
 * 260mm では足りず文字が切れる。実測に合わせて余裕を持たせている。
 * 画面側の縦横比計算と揃える必要があるため export する。
 */
export const MARGIN_MM = 420;
/** グリッドの間隔(mm)。 */
const GRID_MM = 100;
/** 目盛りに数値を入れる間隔(mm)。 */
const LABEL_MM = 500;

const COLOR_INVALID = '#ef4444';

/** 荷台の実寸から、横向きに描いたときの描画領域の実寸を返す。 */
export function viewSize(bed) {
  return { w: bed.d, d: bed.w };
}

/** 荷台座標の矩形をビュー座標の矩形へ写す。 */
function toViewRect(bed, rect) {
  return {
    x: rect.y,
    y: bed.w - (rect.x + rect.w),
    w: rect.d,
    h: rect.w
  };
}

/**
 * 荷台1台分を描画する。呼び出すたびに中身を作り直す。
 * ドラッグ中の追従には updatePlacementPosition を使い、確定時にこちらを呼ぶ。
 *
 * @param {SVGElement} svg 描画先
 * @param {object} slot packing.js の slot
 * @param {{invalidIds?: Set<string>, selectedId?: string|null}} options
 */
export function renderTruck(svg, slot, options = {}) {
  const bed = bedOf(slot);
  const view = viewSize(bed);
  const invalidIds = options.invalidIds ?? new Set();
  const selectedId = options.selectedId ?? null;

  svg.setAttribute(
    'viewBox',
    `${-MARGIN_MM} ${-MARGIN_MM} ${view.w + MARGIN_MM * 2} ${view.d + MARGIN_MM * 2}`
  );
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // ビュー座標と荷台座標を往復するのに荷台の寸法が要る。描画のたびに要素へ控えて
  // おき、clientToBed / updatePlacementPosition から引けるようにする
  // （呼び出し側に毎回 slot を渡させるより取り違えが起きにくい）。
  svg.dataset.bedWidthMm = bed.w;
  svg.dataset.bedDepthMm = bed.d;
  svg.dataset.maskNamespace = `slot-${slot.slot}-${slot.id ?? 'local'}`;

  // 機材置き場はトラックの荷台と取り違えないよう、破線のグレー枠にする。
  const staging = slot.truck?.kind === 'staging';
  const frame = staging
    ? `<rect x="0" y="0" width="${view.w}" height="${view.d}" fill="#f8fafc" stroke="#94a3b8" stroke-width="12" stroke-dasharray="120 80"/>`
    : `<rect x="0" y="0" width="${view.w}" height="${view.d}" fill="#ffffff" stroke="#334155" stroke-width="12"/>`;

  svg.innerHTML = [
    renderRuler(bed, staging),
    frame,
    renderGrid(bed),
    renderObstacles(slot, bed),
    slot.placements
      .map((placement) => renderPlacement(placement, bed, invalidIds, selectedId, svg.dataset.maskNamespace))
      .join('')
  ].join('');
}

// グリッドは荷台座標で数えてからビューへ写す。こうしないと荷台の幅が500mmの
// 倍数でないときに、尺規の目盛りとグリッド線がずれる。
function renderGrid(bed) {
  const view = viewSize(bed);
  const lines = [];

  for (let y = GRID_MM; y < bed.d; y += GRID_MM) {
    const major = y % LABEL_MM === 0;
    lines.push(
      `<line x1="${y}" y1="0" x2="${y}" y2="${view.d}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 5 : 3}"/>`
    );
  }
  for (let x = GRID_MM; x < bed.w; x += GRID_MM) {
    const major = x % LABEL_MM === 0;
    const viewY = bed.w - x;
    lines.push(
      `<line x1="0" y1="${viewY}" x2="${view.w}" y2="${viewY}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 5 : 3}"/>`
    );
  }
  return `<g class="grid">${lines.join('')}</g>`;
}

function renderRuler(bed, staging = false) {
  const view = viewSize(bed);
  const parts = [];
  const fontSize = 110;

  // 上端は奥行き方向（進行方向）。左が前、右が後ろ。
  for (let y = 0; y <= bed.d; y += LABEL_MM) {
    parts.push(`<line x1="${y}" y1="-70" x2="${y}" y2="-20" stroke="#94a3b8" stroke-width="6"/>`);
    parts.push(
      `<text x="${y}" y="-110" font-size="${fontSize}" fill="#64748b" text-anchor="middle">${y}</text>`
    );
  }
  // 左端は幅方向。画面下が荷台の左側（x = 0）。
  for (let x = 0; x <= bed.w; x += LABEL_MM) {
    const viewY = bed.w - x;
    parts.push(`<line x1="-70" y1="${viewY}" x2="-20" y2="${viewY}" stroke="#94a3b8" stroke-width="6"/>`);
    parts.push(
      `<text x="-100" y="${viewY + fontSize * 0.35}" font-size="${fontSize}" fill="#64748b" text-anchor="end">${x}</text>`
    );
  }

  // 進行方向が分かるように前方を明示する。横向きにすると前後が一目で分からないため。
  if (!staging) {
    parts.push(
      `<text x="0" y="${view.d + 150}" font-size="${fontSize}" fill="#94a3b8" text-anchor="start">◀ 前方（運転席側）</text>`
    );
  }

  // 荷台の全体寸法。図だけ見て何tクラスか分かるように隅に出す。
  // 置き場は実車の寸法ではないので、寸法ではなく用途を書く。
  const caption = staging ? '機材置き場（積み込み前の仮置き）' : `幅 ${bed.w} × 奥行 ${bed.d} mm`;
  parts.push(
    `<text x="${view.w}" y="${view.d + 150}" font-size="${fontSize}" fill="#94a3b8" text-anchor="end">${escapeXml(caption)}</text>`
  );

  return `<g class="ruler" pointer-events="none">${parts.join('')}</g>`;
}

function renderObstacles(slot, bed) {
  const rects = obstacleRects(slot);
  if (rects.length === 0) return '';

  const items = rects.map((rect, index) => {
    const label = slot.obstacles[index]?.label ?? '';
    const box = toViewRect(bed, rect);
    return [
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"`,
      ` fill="#cbd5e1" stroke="#64748b" stroke-width="6" stroke-dasharray="40 30"/>`,
      label
        ? `<text x="${box.x + box.w / 2}" y="${box.y + box.h / 2}" font-size="${fitLabel(label, box).fontSize}"` +
          ` fill="#475569" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>`
        : ''
    ].join('');
  });

  return `<g class="obstacles" pointer-events="none">${items.join('')}</g>`;
}

function renderPlacement(placement, bed, invalidIds, selectedId, maskNamespace) {
  const drawing = placementDrawing(placement);
  const invalid = invalidIds.has(placement.id);
  const selected = placement.id === selectedId;

  const fill = invalid ? COLOR_INVALID : placement.snapshot.color;
  const stroke = selected ? '#1d4ed8' : invalid ? '#991b1b' : '#334155';
  const strokeWidth = selected ? 18 : 8;
  const maskId = maskIdentifier(`${maskNamespace}-${placement.id}`);

  // 寸法はシンボルには書かない。枠が小さいと機材名を押しのけて枠からはみ出すうえ、
  // 選択すれば下部の集計パネルに出るため二重に持つ意味がない。
  const label = chooseLabel(placement.snapshot.name, drawing.labelBox);
  const cx = drawing.labelBox.x + drawing.labelBox.w / 2;
  const cy = drawing.labelBox.y + drawing.labelBox.h / 2;
  const transform = label.vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';

  return [
    `<g class="placement" data-placement-id="${escapeXml(placement.id)}"`,
    ` transform="${placementTransform(placement, bed)}" style="cursor:grab">`,
    drawing.hasCurves ? outlineMask(maskId, drawing, strokeWidth) : '',
    `<path class="fill" d="${drawing.fillPath}" fill="${escapeXml(fill)}"`,
    ` fill-opacity="${invalid ? 0.85 : 0.7}"/>`,
    `<path class="outline" d="${drawing.outlinePath}" fill="none"`,
    ` stroke="${stroke}" stroke-width="${drawing.hasCurves ? strokeWidth * 2 : strokeWidth}"`,
    drawing.hasCurves ? ` mask="url(#${maskId})"/>` : '/>',
    `<text x="${cx}" y="${cy}" font-size="${label.fontSize}"${transform}`,
    ` fill="#0f172a" text-anchor="middle" dominant-baseline="middle" pointer-events="none">`,
    escapeXml(label.text),
    '</text>',
    '</g>'
  ].join('');
}

/**
 * 配置の各パーツを、配置原点からのローカルなビュー座標へ写す。
 * 絶対位置は親gのtranslateに持たせるので、ドラッグ中はtransformだけを更新できる。
 */
function placementDrawing(placement) {
  const parts = toParts(placement);
  const boxes = parts.map((part) => ({
    x: part.y - placement.y,
    y: -(part.x - placement.x + part.w),
    w: part.d,
    h: part.w
  }));
  const outlineParts = boxes.map((box) => ({
    x: box.x,
    y: box.y,
    w: box.w,
    d: box.h
  }));
  const largestIndex = parts.reduce(
    (best, part, index) => partArea(part) > partArea(parts[best]) ? index : best,
    0
  );
  const fillPath = parts.map((part, index) => partSubpath(part, boxes[index], placement)).join(' ');
  const hasCurves = parts.some((part) => part.kind !== 'rect');
  const rawLabelBox = boxes[largestIndex];
  const labelBox = parts[largestIndex].kind === 'rect' ? rawLabelBox : {
    x: rawLabelBox.x + rawLabelBox.w * 0.1,
    y: rawLabelBox.y + rawLabelBox.h * 0.1,
    w: rawLabelBox.w * 0.8,
    h: rawLabelBox.h * 0.8
  };

  return {
    fillPath,
    outlinePath: hasCurves ? fillPath : unionOutline(outlineParts).map(lineSubpath).join(' '),
    labelBox,
    hasCurves,
    bounds: boxes.reduce((result, box) => ({
      x: Math.min(result.x, box.x), y: Math.min(result.y, box.y),
      right: Math.max(result.right, box.x + box.w), bottom: Math.max(result.bottom, box.y + box.h)
    }), { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity })
  };
}

function partSubpath(part, box, placement) {
  if (part.kind === 'circle') {
    const r = part.w / 2;
    const cx = part.y - placement.y + r;
    const cy = -(part.x - placement.x + r);
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  if (part.kind === 'polygon') {
    return part.points.map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.y - placement.y} ${-(point.x - placement.x)}`
    ).join(' ') + ' Z';
  }
  return rectSubpath(box);
}

function maskIdentifier(value) {
  return `outline-${String(value).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

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

function rectSubpath(box) {
  return `M ${box.x} ${box.y} h ${box.w} v ${box.h} h ${-box.w} Z`;
}

function lineSubpath(line) {
  return `M ${line.x1} ${line.y1} L ${line.x2} ${line.y2}`;
}

function placementTransform(placement, bed) {
  return `translate(${placement.y} ${bed.w - placement.x})`;
}

/** これより小さい文字は読めないので、代わりに文字列を切り詰める。 */
const MIN_FONT_MM = 55;
const MAX_FONT_MM = 220;

/**
 * 文字列の見た目の幅をem単位で見積もる。
 * 日本語（全角）はほぼ1em、ASCIIは半分強。ここを文字数で代用すると
 * 全角の機材名が枠から大きくはみ出す。
 */
function textWidthEm(text) {
  let em = 0;
  for (const char of text) {
    em += char.charCodeAt(0) < 0x100 ? 0.55 : 1;
  }
  return Math.max(em, 1);
}

/**
 * 機材名をどちら向きに置くか決める。
 *
 * 荷台に対して機材が縦長に載ると枠も画面上で縦長になり、横書きのままでは
 * 短辺に文字幅を押し込むことになって、極端に小さくなるか切り詰められる。
 * そこで縦横それぞれで見積もり、明確に有利なほうへ寝かせる。
 * 首を傾けて読ませる不便があるので、僅差では横書きのままにする。
 */
function chooseLabel(text, box) {
  const flat = fitLabel(text, box);
  const turned = fitLabel(text, { w: box.h, h: box.w });

  const better = flat.clipped
    ? !turned.clipped || turned.fontSize > flat.fontSize * 1.15
    : !turned.clipped && turned.fontSize > flat.fontSize * 1.15;

  return better ? { ...turned, vertical: true } : { ...flat, vertical: false };
}

/**
 * 枠に収まる文字サイズと表示文字列を求める。
 * 引数はビュー座標の矩形（画面上の見た目の縦横）を渡すこと。
 * 文字を寝かせる場合は縦横を入れ替えて渡す。
 * 幅は文字幅の見積もりから、高さは矩形の高さから決め、小さいほうを採る。
 * 下限を下回る場合は文字を切り詰めて「…」を付ける（clipped で知らせる）。
 */
function fitLabel(text, box) {
  // 1行しか置かないので、行の高さは枠の高さの半分強まで許せる。
  const byHeight = box.h / 1.8;
  const available = box.w * 0.9;
  const fontSize = Math.min(available / textWidthEm(text), byHeight, MAX_FONT_MM);

  if (fontSize >= MIN_FONT_MM) {
    return { text, fontSize: Math.max(fontSize, MIN_FONT_MM), clipped: false };
  }

  // 下限の文字サイズで入るところまで切り詰める。
  // 実際に使う文字サイズを先に決めてから切り詰め幅を計算すること。下限の
  // MIN_FONT_MM を基準にすると、枠が薄くて文字を縮めたときに幅が余る。
  const size = Math.min(byHeight, MIN_FONT_MM);

  // 下限を割り込む枠は、何を書いても読めないうえ枠から溢れる。文字は諦める。
  if (size < 30) return { text: '', fontSize: 30, clipped: true };

  const budget = available / size;
  let used = textWidthEm('…');
  let clipped = '';
  for (const char of text) {
    const width = char.charCodeAt(0) < 0x100 ? 0.55 : 1;
    if (used + width > budget) break;
    clipped += char;
    used += width;
  }

  return { text: clipped ? `${clipped}…` : '', fontSize: size, clipped: true };
}

/** 描画時に控えた荷台の実寸を読み出す。 */
function bedOfSvg(svg) {
  return {
    w: Number(svg.dataset.bedWidthMm),
    d: Number(svg.dataset.bedDepthMm)
  };
}

/**
 * ドラッグ中の軽量な位置更新。innerHTMLを作り直すとポインタキャプチャが
 * 切れてしまうため、動かしている要素の座標だけを書き換える。
 */
export function updatePlacementPosition(svg, placement) {
  const group = svg.querySelector(`[data-placement-id="${CSS.escape(placement.id)}"]`);
  if (!group) return;
  movePlacementGroup(group, placement, bedOfSvg(svg));
}

/** 荷台座標の移動(dx, dy)をビュー座標(dy, -dx)へ写して親gだけを動かす。 */
function movePlacementGroup(group, placement, bed) {
  group.setAttribute('transform', placementTransform(placement, bed));
}

/**
 * 別のエリアへドラッグしている最中に、移動先の「ここに載る」位置を示すゴースト。
 *
 * ドラッグ中の機材は掴んだエリアの中でしか動かせない（ポインタキャプチャを
 * 維持するため、また壁で止める必要があるため）ので、エリアをまたぐ移動では
 * 落とすまで着地点が分からない。そこで移動先に破線の影を出して先に見せる。
 *
 * 実物ではないことが一目で分かるよう、塗りは薄く枠は破線にする。
 * placement は移動先の荷台座標に直したものを渡すこと。
 */
export function showDropGhost(svg, placement) {
  const bed = bedOfSvg(svg);
  const existing = svg.querySelector('g.drop-ghost');

  // 同じ機材のゴーストが既にあるなら座標だけ動かす。作り直すと
  // 1回のドラッグで何十回もDOMを組み立てることになる。
  if (existing && existing.dataset.placementId === placement.id) {
    movePlacementGroup(existing, placement, bed);
    return;
  }
  existing?.remove();

  const drawing = placementDrawing(placement);
  const maskId = maskIdentifier(`ghost-${svg.dataset.maskNamespace}-${placement.id}`);
  const label = chooseLabel(placement.snapshot.name, drawing.labelBox);
  const cx = drawing.labelBox.x + drawing.labelBox.w / 2;
  const cy = drawing.labelBox.y + drawing.labelBox.h / 2;
  const transform = label.vertical ? ` transform="rotate(-90 ${cx} ${cy})"` : '';

  svg.insertAdjacentHTML('beforeend', [
    `<g class="drop-ghost" data-placement-id="${escapeXml(placement.id)}"`,
    ` transform="${placementTransform(placement, bed)}" pointer-events="none">`,
    drawing.hasCurves ? outlineMask(maskId, drawing, 14) : '',
    `<path class="fill" d="${drawing.fillPath}" fill="${escapeXml(placement.snapshot.color)}"`,
    ` fill-opacity="0.35"/>`,
    `<path class="outline" d="${drawing.outlinePath}" fill="none" stroke="#1d4ed8"`,
    ` stroke-width="${drawing.hasCurves ? 28 : 14}" stroke-dasharray="90 60"`,
    drawing.hasCurves ? ` mask="url(#${maskId})"/>` : '/>',
    `<text x="${cx}" y="${cy}" font-size="${label.fontSize}"${transform}`,
    ` fill="#1e293b" fill-opacity="0.7" text-anchor="middle" dominant-baseline="middle">`,
    escapeXml(label.text),
    '</text>',
    '</g>'
  ].join(''));
}

/** 移動先のゴーストを消す。ドラッグが終わったときと、移動先が変わったときに呼ぶ。 */
export function clearDropGhost(svg) {
  svg.querySelector('g.drop-ghost')?.remove();
}

/**
 * 移動元の機材を薄くする。移動先にゴーストを出している間、どちらが実体か
 * 迷わないよう「こちらは出ていく」と示すために使う。
 */
export function dimPlacement(svg, placementId, dimmed) {
  const group = svg.querySelector(`[data-placement-id="${CSS.escape(placementId)}"]`);
  if (group) group.style.opacity = dimmed ? '0.3' : '';
}

/**
 * 画面座標(clientX/clientY)を荷台のmm座標に変換する。
 * getScreenCTMを使うので、CSSによる拡大縮小やスクロール位置に依存しない。
 * 得られるのはビュー座標なので、最後に荷台座標へ戻す。
 */
export function clientToBed(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };

  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  const bed = bedOfSvg(svg);
  return { x: bed.w - point.y, y: point.x };
}

/**
 * 画面上の1pxが何mmに相当するかを返す。スナップのしきい値を
 * 「画面上でおよそ何px」という感覚で決めるために使う。
 */
export function mmPerPixel(svg) {
  const ctm = svg.getScreenCTM();
  if (!ctm || ctm.a === 0) return 1;
  return 1 / ctm.a;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
