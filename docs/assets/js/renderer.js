// 荷台のSVG描画。
//
// Canvasではなく SVG を使う理由は、機材1個を1つの <g> として持てるため
// ヒットテストとポインタイベントをブラウザに任せられること、テキストの機材名が
// そのまま印刷とPNG書き出しに乗ることの2点。
//
// viewBox を実寸mmに取り、CSSの幅でスケールする。つまり「ズーム」は
// viewBox の操作だけで済み、描画側は常にmmで考えればよい。

import { toRect } from './geometry.js';
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
  const invalidIds = options.invalidIds ?? new Set();
  const selectedId = options.selectedId ?? null;

  svg.setAttribute(
    'viewBox',
    `${-MARGIN_MM} ${-MARGIN_MM} ${bed.w + MARGIN_MM * 2} ${bed.d + MARGIN_MM * 2}`
  );
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  svg.innerHTML = [
    renderRuler(bed),
    `<rect x="0" y="0" width="${bed.w}" height="${bed.d}" fill="#ffffff" stroke="#334155" stroke-width="12"/>`,
    renderGrid(bed),
    renderObstacles(slot),
    slot.placements
      .map((placement) => renderPlacement(placement, invalidIds, selectedId))
      .join('')
  ].join('');
}

function renderGrid(bed) {
  const lines = [];
  for (let x = GRID_MM; x < bed.w; x += GRID_MM) {
    const major = x % LABEL_MM === 0;
    lines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${bed.d}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 5 : 3}"/>`
    );
  }
  for (let y = GRID_MM; y < bed.d; y += GRID_MM) {
    const major = y % LABEL_MM === 0;
    lines.push(
      `<line x1="0" y1="${y}" x2="${bed.w}" y2="${y}" stroke="${major ? '#cbd5e1' : '#e2e8f0'}" stroke-width="${major ? 5 : 3}"/>`
    );
  }
  return `<g class="grid">${lines.join('')}</g>`;
}

function renderRuler(bed) {
  const parts = [];
  const fontSize = 110;

  // 上端（幅方向）
  for (let x = 0; x <= bed.w; x += LABEL_MM) {
    parts.push(`<line x1="${x}" y1="-70" x2="${x}" y2="-20" stroke="#94a3b8" stroke-width="6"/>`);
    parts.push(
      `<text x="${x}" y="-110" font-size="${fontSize}" fill="#64748b" text-anchor="middle">${x}</text>`
    );
  }
  // 左端（奥行き方向）
  for (let y = 0; y <= bed.d; y += LABEL_MM) {
    parts.push(`<line x1="-70" y1="${y}" x2="-20" y2="${y}" stroke="#94a3b8" stroke-width="6"/>`);
    parts.push(
      `<text x="-100" y="${y + fontSize * 0.35}" font-size="${fontSize}" fill="#64748b" text-anchor="end">${y}</text>`
    );
  }

  // 荷台の全体寸法。図だけ見て何tクラスか分かるように隅に出す。
  parts.push(
    `<text x="${bed.w}" y="${bed.d + 150}" font-size="${fontSize}" fill="#94a3b8" text-anchor="end">${bed.w} × ${bed.d} mm</text>`
  );

  return `<g class="ruler" pointer-events="none">${parts.join('')}</g>`;
}

function renderObstacles(slot) {
  const rects = obstacleRects(slot);
  if (rects.length === 0) return '';

  const items = rects.map((rect, index) => {
    const label = slot.obstacles[index]?.label ?? '';
    return [
      `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.d}"`,
      ` fill="#cbd5e1" stroke="#64748b" stroke-width="6" stroke-dasharray="40 30"/>`,
      label
        ? `<text x="${rect.x + rect.w / 2}" y="${rect.y + rect.d / 2}" font-size="${fitFontSize(label, rect)}"` +
          ` fill="#475569" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>`
        : ''
    ].join('');
  });

  return `<g class="obstacles" pointer-events="none">${items.join('')}</g>`;
}

function renderPlacement(placement, invalidIds, selectedId) {
  const rect = toRect(placement);
  const invalid = invalidIds.has(placement.id);
  const selected = placement.id === selectedId;

  const fill = invalid ? COLOR_INVALID : placement.snapshot.color;
  const stroke = selected ? '#1d4ed8' : invalid ? '#991b1b' : '#334155';
  const strokeWidth = selected ? 18 : 8;

  const label = fitLabel(placement.snapshot.name, rect);
  const name = label.text;
  const fontSize = label.fontSize;

  return [
    `<g class="placement" data-placement-id="${escapeXml(placement.id)}" style="cursor:grab">`,
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.d}"`,
    ` fill="${escapeXml(fill)}" fill-opacity="${invalid ? 0.85 : 0.7}"`,
    ` stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
    `<text x="${rect.x + rect.w / 2}" y="${rect.y + rect.d / 2}" font-size="${fontSize}"`,
    ` fill="#0f172a" text-anchor="middle" dominant-baseline="middle" pointer-events="none">`,
    escapeXml(name),
    '</text>',
    `<text x="${rect.x + rect.w / 2}" y="${rect.y + rect.d / 2 + fontSize * 1.15}" font-size="${fontSize * 0.75}"`,
    ` fill="#334155" text-anchor="middle" dominant-baseline="middle" pointer-events="none">`,
    `${rect.w}×${rect.d}`,
    '</text>',
    '</g>'
  ].join('');
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
 * 機材の枠に収まる文字サイズと表示文字列を求める。
 * 幅は文字幅の見積もりから、高さは矩形の短辺から決め、小さいほうを採る。
 * 下限を下回る場合は文字を切り詰めて「…」を付ける。
 */
function fitLabel(text, rect) {
  const byHeight = rect.d / 3.4;
  const available = rect.w * 0.9;
  const fontSize = Math.min(available / textWidthEm(text), byHeight, MAX_FONT_MM);

  if (fontSize >= MIN_FONT_MM) {
    return { text, fontSize: Math.max(fontSize, MIN_FONT_MM) };
  }

  // 下限の文字サイズで入るところまで切り詰める
  const budget = available / MIN_FONT_MM;
  let used = textWidthEm('…');
  let clipped = '';
  for (const char of text) {
    const width = char.charCodeAt(0) < 0x100 ? 0.55 : 1;
    if (used + width > budget) break;
    clipped += char;
    used += width;
  }

  return {
    text: clipped ? `${clipped}…` : '',
    fontSize: Math.max(Math.min(byHeight, MIN_FONT_MM), 30)
  };
}

/** 障害物のラベルなど、切り詰めが不要な場面向けの簡易版。 */
function fitFontSize(text, rect) {
  return fitLabel(text, rect).fontSize;
}

/**
 * ドラッグ中の軽量な位置更新。innerHTMLを作り直すとポインタキャプチャが
 * 切れてしまうため、動かしている要素の座標だけを書き換える。
 */
export function updatePlacementPosition(svg, placement) {
  const group = svg.querySelector(`[data-placement-id="${CSS.escape(placement.id)}"]`);
  if (!group) return;

  const rect = toRect(placement);
  const box = group.querySelector('rect');
  const [nameText, sizeText] = group.querySelectorAll('text');

  box.setAttribute('x', rect.x);
  box.setAttribute('y', rect.y);
  box.setAttribute('width', rect.w);
  box.setAttribute('height', rect.d);

  const fontSize = Number(nameText.getAttribute('font-size'));
  nameText.setAttribute('x', rect.x + rect.w / 2);
  nameText.setAttribute('y', rect.y + rect.d / 2);
  if (sizeText) {
    sizeText.setAttribute('x', rect.x + rect.w / 2);
    sizeText.setAttribute('y', rect.y + rect.d / 2 + fontSize * 1.15);
    sizeText.textContent = `${rect.w}×${rect.d}`;
  }
}

/**
 * 画面座標(clientX/clientY)を荷台のmm座標に変換する。
 * getScreenCTMを使うので、CSSによる拡大縮小やスクロール位置に依存しない。
 */
export function clientToBed(svg, clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };

  const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: point.x, y: point.y };
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
