// 荷台上の形状配置に関する純粋な計算をまとめる。
// SupabaseもDOMも参照しない。将来の2.5D（段積み）対応で手を入れるのもここだけに
// 収まるよう、状態を持たず入力から出力を返す関数だけで構成している。
//
// 座標系: 荷台の左前を原点(0,0)、xが幅方向、yが奥行き方向。単位はすべて整数mm。

// クリアランス（壁面および他オブジェクトとの間に確保する隙間）はレイアウトごとの
// 設定で、この層では引数として受け取る。既定値と設定範囲だけをここに持つ。
//
// 吸着先・押し出し先・空き探索の目標であると同時に、エラー判定の基準でもある。
// 設定を変えると、その隙間を確保できていない機材がその場で赤くなる（配置は動かさない）。
/** クリアランスの既定値(mm)。 */
export const DEFAULT_CLEARANCE_MM = 10;
/** ユーザーが設定できるクリアランスの範囲(mm)。 */
export const MIN_SETTING_CLEARANCE_MM = 1;
export const MAX_SETTING_CLEARANCE_MM = 20;
// エラー判定にも同じ設定値を使う。かつては「吸着の目標値」と「エラーの下限」を
// 別々に持っていたが、数字が2つあると挙動を説明しきれない。設定値ひとつにして
// 「設定した隙間を確保できていないものは赤」と一文で言い切れる形にしてある。

/** 連鎖押し出しの反復上限。密に詰まった状態で振動して止まらなくなるのを防ぐ。 */
const MAX_PUSH_ITERATIONS = 100;

/**
 * 回転を反映した外形サイズを返す。90度刻みなので幅と奥行きの入れ替えで済む。
 */
export function rotatedSize(widthMm, depthMm, rotation) {
  const turned = rotation === 90 || rotation === 270;
  return {
    w: turned ? depthMm : widthMm,
    d: turned ? widthMm : depthMm
  };
}

/**
 * 配置(placement)から当たり判定用の矩形を作る。
 * placement: { id, x, y, rotation, snapshot: { widthMm, depthMm } }
 * 本番コードでは使わず、テストでマスタ寸法から求めた従来の外形bboxとの比較基準にだけ使う。
 */
export function toRect(placement) {
  const { w, d } = rotatedSize(
    placement.snapshot.widthMm,
    placement.snapshot.depthMm,
    placement.rotation
  );
  return { id: placement.id, x: placement.x, y: placement.y, w, d };
}

/**
 * shape を kind と bbox を必ず持つパーツ配列へ正規化する。
 * 壊れたパーツが1つでもあれば、図を出せなくしないため外形矩形1枚へフォールバックする。
 */
export function normalizeShape(shape, widthMm, depthMm) {
  const fallback = [{ kind: 'rect', x: 0, y: 0, w: widthMm, d: depthMm }];
  if (!Array.isArray(shape?.parts) || shape.parts.length === 0) return fallback;

  const parts = [];
  for (const part of shape.parts) {
    if (part?.kind === 'rect') {
      if (![part.x, part.y, part.w, part.d].every(Number.isFinite) || part.w <= 0 || part.d <= 0) {
        return fallback;
      }
      parts.push({ kind: 'rect', x: part.x, y: part.y, w: part.w, d: part.d });
      continue;
    }
    if (part?.kind === 'circle') {
      if (![part.cx, part.cy, part.r].every(Number.isFinite) || part.r <= 0) return fallback;
      parts.push({ kind: 'circle', x: part.cx - part.r, y: part.cy - part.r, w: part.r * 2, d: part.r * 2 });
      continue;
    }
    if (part?.kind === 'polygon') {
      const points = Array.isArray(part.points)
        ? part.points.map((point) => ({ x: point?.x, y: point?.y }))
        : [];
      if (points.length < 3 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
          !isConvex(points)) return fallback;
      const minX = Math.min(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxX = Math.max(...points.map((point) => point.x));
      const maxY = Math.max(...points.map((point) => point.y));
      if (maxX <= minX || maxY <= minY) return fallback;
      parts.push({ kind: 'polygon', x: minX, y: minY, w: maxX - minX, d: maxY - minY, points });
      continue;
    }
    return fallback;
  }
  return parts.length > 0 ? parts : fallback;
}

/**
 * 配置を当たり判定用のパーツ（軸平行な矩形）の配列にする。
 * shape を持たない機材は1枚の矩形として扱うので、呼び出し側は形の有無を意識しなくてよい。
 * 返る座標は荷台の絶対座標。
 */
export function toParts(placement) {
  const { widthMm, depthMm, shape } = placement.snapshot;
  const rotation = placement.rotation;
  const parts = normalizeShape(shape, widthMm, depthMm);
  // shape がある場合はマスタの width/depth ではなく、形そのものの外形を回転基準にする。
  // 手入力やCSVで両者がずれても、回転によってパーツが外形の中を飛ばないため。
  const localBounds = boundsOf(parts);
  const w0 = localBounds.w;
  const d0 = localBounds.d;

  return parts.map((part, partIndex) => {
    const px = part.x - localBounds.x;
    const py = part.y - localBounds.y;
    const { w: pw, d: pd } = part;
    let transformed;

    switch (rotation) {
      case 90:
        transformed = { x: d0 - py - pd, y: px, w: pd, d: pw };
        break;
      case 180:
        transformed = { x: w0 - px - pw, y: d0 - py - pd, w: pw, d: pd };
        break;
      case 270:
        transformed = { x: py, y: w0 - px - pw, w: pd, d: pw };
        break;
      default:
        transformed = { x: px, y: py, w: pw, d: pd };
    }

    const result = {
      id: placement.id,
      partIndex,
      kind: part.kind,
      x: placement.x + transformed.x,
      y: placement.y + transformed.y,
      w: transformed.w,
      d: transformed.d
    };
    if (part.kind === 'polygon') {
      result.points = part.points.map((point) => {
        const pointX = point.x - localBounds.x;
        const pointY = point.y - localBounds.y;
        let mapped;
        switch (rotation) {
          case 90: mapped = { x: d0 - pointY, y: pointX }; break;
          case 180: mapped = { x: w0 - pointX, y: d0 - pointY }; break;
          case 270: mapped = { x: pointY, y: w0 - pointX }; break;
          default: mapped = { x: pointX, y: pointY };
        }
        return { x: placement.x + mapped.x, y: placement.y + mapped.y };
      });
    }
    return result;
  });
}

/** 配置を、同じidを持つ絶対座標パーツの集合にする。 */
export function toShape(placement) {
  return { id: placement.id, parts: toParts(placement) };
}

/** 障害物などの矩形1枚を形として同じ判定経路に乗せる。 */
export function rectToShape(rect) {
  return { id: rect.id, parts: [{ ...rect }] };
}

/** 軸平行な矩形パーツ群を囲む外形bboxを返す。 */
export function boundsOf(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return null;

  const minX = Math.min(...parts.map((part) => part.x));
  const minY = Math.min(...parts.map((part) => part.y));
  const maxX = Math.max(...parts.map((part) => part.x + part.w));
  const maxY = Math.max(...parts.map((part) => part.y + part.d));
  return { id: parts[0].id, x: minX, y: minY, w: maxX - minX, d: maxY - minY };
}

/**
 * 軸平行な矩形パーツ群を塗り合わせたときの外周線だけを返す。
 *
 * 全境界座標で平面を細分し、各区間の両側を0.5mmずつサンプリングする。
 * 片側だけがパーツ内部なら、その区間はunionの外周である。全パーツの境界座標で
 * 分割するため、パーツが重なっていて途中から内部線になる場合も正しく除ける。
 *
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function unionOutline(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return [];

  const xs = sortedUnique(parts.flatMap((part) => [part.x, part.x + part.w]));
  const ys = sortedUnique(parts.flatMap((part) => [part.y, part.y + part.d]));
  const vertical = [];
  const horizontal = [];

  for (const x of xs) {
    for (let i = 0; i < ys.length - 1; i++) {
      const y1 = ys[i];
      const y2 = ys[i + 1];
      const midY = (y1 + y2) / 2;
      const leftInside = pointInsideParts(x - 0.5, midY, parts);
      const rightInside = pointInsideParts(x + 0.5, midY, parts);
      if (leftInside !== rightInside) vertical.push({ x1: x, y1, x2: x, y2 });
    }
  }

  for (const y of ys) {
    for (let i = 0; i < xs.length - 1; i++) {
      const x1 = xs[i];
      const x2 = xs[i + 1];
      const midX = (x1 + x2) / 2;
      const aboveInside = pointInsideParts(midX, y - 0.5, parts);
      const belowInside = pointInsideParts(midX, y + 0.5, parts);
      if (aboveInside !== belowInside) horizontal.push({ x1, y1: y, x2, y2: y });
    }
  }

  // 分割点をまたいで状態が変わらない外周は1本に戻す。L字の直線部分などを
  // 不要に細切れにせず、SVGのpathとテスト結果を読みやすく保つため。
  return [...mergeOutlineSegments(vertical), ...mergeOutlineSegments(horizontal)];
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function pointInsideParts(x, y, parts) {
  return parts.some((part) =>
    x > part.x && x < part.x + part.w && y > part.y && y < part.y + part.d
  );
}

function mergeOutlineSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    const sameVerticalLine = previous && segment.x1 === segment.x2 &&
      previous.x1 === previous.x2 && previous.x1 === segment.x1 && previous.y2 === segment.y1;
    const sameHorizontalLine = previous && segment.y1 === segment.y2 &&
      previous.y1 === previous.y2 && previous.y1 === segment.y1 && previous.x2 === segment.x1;
    if (sameVerticalLine || sameHorizontalLine) {
      previous.x2 = segment.x2;
      previous.y2 = segment.y2;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * 2つの矩形が重なっているか。gapを渡すと「gap未満しか離れていない」ことを重なりとみなす。
 * 辺どうしがちょうどgapだけ離れている状態は重なりではない（＝スナップの正解位置）。
 */
export function rectsOverlap(a, b, gap = 0) {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.d + gap &&
    b.y < a.y + a.d + gap
  );
}

/**
 * パーツ形状を厳密に比較する。矩形どうしだけは既存どおり軸ごとの隙間（L∞）を使う。
 * 曲線や斜辺を含む組はユークリッド距離になるが、矩形の経路まで変えると既存の
 * 吸着位置とエラー判定がずれるため、意図して揃えていない。
 */
export function partsOverlap(a, b, gap = 0) {
  const kindA = a.kind ?? 'rect';
  const kindB = b.kind ?? 'rect';
  if (kindA === 'rect' && kindB === 'rect') return rectsOverlap(a, b, gap);
  if (!rectsOverlap(a, b, gap)) return false;

  if (kindA === 'circle' && kindB === 'circle') {
    const ac = circleOf(a), bc = circleOf(b);
    return Math.hypot(ac.x - bc.x, ac.y - bc.y) - ac.r - bc.r < gap;
  }
  if (kindA === 'circle' || kindB === 'circle') {
    const circle = kindA === 'circle' ? a : b;
    const polygon = toConvexPoints(kindA === 'circle' ? b : a);
    const center = circleOf(circle);
    return pointToPolygonDistance(center, polygon) - center.r < gap;
  }

  const polyA = toConvexPoints(a);
  const polyB = toConvexPoints(b);
  if (polygonsIntersect(polyA, polyB)) return true;
  let distance = Infinity;
  for (let i = 0; i < polyA.length; i += 1) {
    for (let j = 0; j < polyB.length; j += 1) {
      distance = Math.min(distance, segmentDistance(
        polyA[i], polyA[(i + 1) % polyA.length], polyB[j], polyB[(j + 1) % polyB.length]
      ));
    }
  }
  return distance < gap;
}

function circleOf(part) {
  return { x: part.x + part.w / 2, y: part.y + part.d / 2, r: part.w / 2 };
}

function toConvexPoints(part) {
  if ((part.kind ?? 'rect') === 'polygon') return part.points;
  return [
    { x: part.x, y: part.y }, { x: part.x + part.w, y: part.y },
    { x: part.x + part.w, y: part.y + part.d }, { x: part.x, y: part.y + part.d }
  ];
}

export function isConvex(points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  if (new Set(points.map((point) => `${point.x},${point.y}`)).size !== points.length) return false;
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const current = Math.sign(cross);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return sign !== 0;
}

function polygonsIntersect(a, b) {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p1 = polygon[i], p2 = polygon[(i + 1) % polygon.length];
      const axis = { x: -(p2.y - p1.y), y: p2.x - p1.x };
      const pa = a.map((point) => point.x * axis.x + point.y * axis.y);
      const pb = b.map((point) => point.x * axis.x + point.y * axis.y);
      // 接するだけなら重なりではない。矩形の既存挙動と揃える。
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

function pointToPolygonDistance(point, polygon) {
  let inside = true;
  let sign = 0;
  let distance = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) > 1e-9) {
      if (!sign) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) inside = false;
    }
    distance = Math.min(distance, pointToSegmentDistance(point, a, b));
  }
  return inside ? 0 : distance;
}

function pointToSegmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function segmentDistance(a1, a2, b1, b2) {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointToSegmentDistance(a1, b1, b2), pointToSegmentDistance(a2, b1, b2),
    pointToSegmentDistance(b1, a1, a2), pointToSegmentDistance(b2, a1, a2)
  );
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  const onSegment = (p, q, r) => Math.abs(cross(p, q, r)) < 1e-9 &&
    r.x >= Math.min(p.x, q.x) && r.x <= Math.max(p.x, q.x) &&
    r.y >= Math.min(p.y, q.y) && r.y <= Math.max(p.y, q.y);
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/**
 * 凸多角形を外側へdistanceだけ膨らませた頂点列を返す（クリアランス表示用）。
 *
 * 各辺を外向き法線方向へdistanceだけ平行移動し、隣り合う辺どうしの交点を新しい
 * 頂点にする。凸多角形を外側へ広げる変換は自己交差を起こさないため、この方法で
 * 常に妥当な凸多角形が得られる（内側へ縮める場合はこの限りではない）。
 *
 * 外向きの向きは巻き順に依存させず、重心から各辺の中点への方向と同じ側を採る。
 * 入力の頂点が時計回り／反時計回りのどちらでも同じ結果になる。
 */
export function offsetConvexPolygon(points, distance) {
  const n = points.length;
  if (n < 3 || distance === 0) return points;

  const centerX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const centerY = points.reduce((sum, point) => sum + point.y, 0) / n;

  const lines = points.map((a, index) => {
    const b = points[(index + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    let nx = dy / length;
    let ny = -dx / length;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (nx * (midX - centerX) + ny * (midY - centerY) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { px: a.x + nx * distance, py: a.y + ny * distance, dx, dy };
  });

  return points.map((_, index) => {
    const prev = lines[(index - 1 + n) % n];
    const current = lines[index];
    const denom = prev.dx * current.dy - prev.dy * current.dx;
    // 隣り合う辺が平行（denom = 0）になるのは、入力に重複頂点があるような壊れた
    // 多角形だけ。normalizeShape の isConvex チェックを通った形では起こらない。
    if (Math.abs(denom) < 1e-9) return { x: current.px, y: current.py };
    const t = ((current.px - prev.px) * current.dy - (current.py - prev.py) * current.dx) / denom;
    return { x: prev.px + t * prev.dx, y: prev.py + t * prev.dy };
  });
}

/** パーツの実面積を返す。 */
export function partArea(part) {
  if ((part.kind ?? 'rect') === 'circle') return Math.PI * (part.w / 2) ** 2;
  if (part.kind === 'polygon') {
    const twice = part.points.reduce((sum, point, index) => {
      const next = part.points[(index + 1) % part.points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0);
    return Math.abs(twice) / 2;
  }
  return part.w * part.d;
}

/** 2つの形に、指定間隔を割り込むパーツ対が1組でもあるか。 */
export function shapesOverlap(a, b, gap = 0) {
  return a.parts.some((partA) =>
    b.parts.some((partB) => partsOverlap(partA, partB, gap))
  );
}

/** 矩形が荷台の内側に完全に収まっているか。 */
export function isInsideBed(rect, bed) {
  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= bed.w &&
    rect.y + rect.d <= bed.d
  );
}

/**
 * ドラッグ中の形について、スナップ後の位置を返す。
 *
 * x軸とy軸を独立に評価する。片方の軸だけが壁に吸い付き、もう片方は自由、
 * という動きのほうが実際の積み込み作業の感覚に近いため。
 *
 * 候補は3種類:
 *   1. 壁面    … 壁からクリアランスぶん離れた位置
 *   2. 隣接    … 既存矩形の外側にクリアランスぶん空けて接する位置
 *   3. 整列    … 既存矩形と辺を揃える位置（この候補だけクリアランスを取らない）
 *
 * @param {{id:string,parts:Array}} moving ドラッグ中の形（素の位置）
 * @param {Array} others 既に置かれている形と障害物
 * @param {{w:number,d:number}} bed 荷台内寸
 * @param {number} thresholdMm この距離以内の候補にだけ吸着する
 * @param {number} clearanceMm 吸着先で確保する隙間。しきい値とは別物なので混同しないこと
 *   （しきい値は画面px基準でズームに追従させ、こちらは実寸mm）。
 */
export function snapPosition(moving, others, bed, thresholdMm, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const movingBounds = boundsOf(moving.parts);
  const origin = { x: movingBounds.x, y: movingBounds.y };
  const xCandidates = [
    clearanceMm,
    bed.w - movingBounds.w - clearanceMm
  ];
  const yCandidates = [
    clearanceMm,
    bed.d - movingBounds.d - clearanceMm
  ];

  for (const other of others) {
    if (other.id === moving.id) continue;
    for (const movingPart of moving.parts) {
      const dx = movingPart.x - origin.x;
      const dy = movingPart.y - origin.y;
      for (const otherPart of other.parts) {
        // 隣接（クリアランスあり）
        xCandidates.push(otherPart.x - movingPart.w - clearanceMm - dx);
        xCandidates.push(otherPart.x + otherPart.w + clearanceMm - dx);
        yCandidates.push(otherPart.y - movingPart.d - clearanceMm - dy);
        yCandidates.push(otherPart.y + otherPart.d + clearanceMm - dy);

        // 整列（クリアランスなし）
        xCandidates.push(otherPart.x - dx);
        xCandidates.push(otherPart.x + otherPart.w - movingPart.w - dx);
        yCandidates.push(otherPart.y - dy);
        yCandidates.push(otherPart.y + otherPart.d - movingPart.d - dy);
      }
    }
  }

  return {
    x: nearestCandidate(origin.x, xCandidates, thresholdMm),
    y: nearestCandidate(origin.y, yCandidates, thresholdMm)
  };
}

function nearestCandidate(value, candidates, thresholdMm) {
  let best = Math.round(value);
  let bestDistance = thresholdMm;

  for (const candidate of candidates) {
    const rounded = Math.round(candidate);
    const distance = Math.abs(rounded - value);
    if (distance < bestDistance) {
      best = rounded;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 重なりを連鎖的に解消する（押し出し / スライド）。
 *
 * pinnedIds に含まれる形（＝ユーザーが今動かした/回転させたもの、および障害物）は
 * 動かさず、それ以外を押し出す。押された形はさらに次の押し手になる。
 *
 * 一度押し出した形は押し出し方向を記憶し、以降その軸方向にしか動かさない。
 * こうしないとAがBを右に、BがAを左に押し返して振動する。
 *
 * さらに、押された矩形は「自分を押した矩形と同じ軸」に逃げることを優先する。
 * 単純に移動量が最小の向きを選ぶと、一列に並んだ機材を1つ回転させたときに
 * 2つ目以降が横ではなく手前に逃げてしまい、列が崩れて見えるため。
 *
 * @param {Array} shapes 全形状（障害物も pinnedIds に含めて渡す）
 * @param {Array<string>} pinnedIds 動かさない形のid
 * @param {{w:number,d:number}} bed 荷台内寸
 * @param {{preferredAxis?: 'x'|'y', clearanceMm?: number, queueIds?: Array<string>}} options
 *   preferredAxis は起点の押し出し方向のヒント
 *   （回転で幅が伸びたなら 'x'、奥行きが伸びたなら 'y' を渡す）。
 *   clearanceMm は押し出したあとに空ける隙間。
 *   queueIds は最初に押し出しを始める形のid。省略時は pinnedIds と同じ。
 * @returns {{shapes: Array, moved: boolean, truncated: boolean}}
 *   shapes は座標を更新した新しい配列（入力は破壊しない）。
 *   truncated は反復上限で打ち切ったかどうか。
 */
export function resolveOverlaps(shapes, pinnedIds, bed, options = {}) {
  const clearanceMm = options.clearanceMm ?? DEFAULT_CLEARANCE_MM;
  const working = shapes.map((shape) => ({
    ...shape,
    parts: shape.parts.map((part) => ({ ...part }))
  }));
  const byId = new Map(working.map((shape) => [shape.id, shape]));
  const pinned = new Set(pinnedIds);
  const pinnedShapes = working.filter((shape) => pinned.has(shape.id));
  const pushDirection = new Map();

  const queue = (options.queueIds ?? pinnedIds).map((id) => ({ id, targetId: null }));
  let iterations = 0;
  let moved = false;
  let truncated = false;

  while (queue.length > 0) {
    if (iterations++ >= MAX_PUSH_ITERATIONS) {
      truncated = true;
      break;
    }

    const queued = queue.shift();
    const pusher = byId.get(queued.id);
    if (!pusher) continue;

    const targets = queued.targetId ? working.filter((shape) => shape.id === queued.targetId) : working;
    for (const target of targets) {
      if (target.id === pusher.id) continue;
      if (pinned.has(target.id)) continue;
      // 押し出しを始める条件は、押し手がユーザーの操作対象かどうかで変える。
      //
      //   操作対象（pinned） … クリアランス未満まで近づいていたら押す。
      //                        これで落とした先・回した先がきちんと隙間を取って収まる。
      //   連鎖の先           … 実際に重なったときだけ押す。
      //
      // 連鎖側までクリアランス基準にすると、クリアランス設定を広げたときに、
      // 既に詰めて置いてある対まで「解消すべき干渉」とみなして荷台全体の再配置を
      // 始めてしまう。密な荷台では収束せず（反復上限で打ち切り）、結果が壊れる。
      // 押し出す距離は下の computePush がクリアランスぶん取るので、連鎖の先でも
      // 隙間は確保される。
      const trigger = pinned.has(pusher.id) ? clearanceMm : 0;
      if (!shapesOverlap(pusher, target, trigger)) continue;

      const displacement = computePush(pusher, target, {
        lockedAxis: pushDirection.get(target.id),
        preferredAxis: pushDirection.get(pusher.id) ?? options.preferredAxis ?? null,
        bed,
        pinnedShapes,
        trigger,
        clearanceMm
      });
      if (!displacement) continue;

      translateShape(target, displacement.dx, displacement.dy);
      // 一度決めた軸を固定して往復振動を防ぐ。密集時に別軸しか空いていない場合は
      // 解消できないことがあるが、呼び出し側の最終検証が操作全体を棄却するため、
      // 不正な配置を確定させることはない。利用者報告が出るまでは安全性を優先する。
      pushDirection.set(target.id, displacement.axis);
      moved = true;
      queue.push({ id: target.id, targetId: null });
      // 連鎖で動いた機材が障害物へ近づいた場合だけ、その障害物から当該機材を
      // 押し返す。障害物を無条件にキューへ入れると、操作と無関係な機材まで動く。
      for (const fixed of pinnedShapes) {
        if (fixed.id !== pusher.id && shapesOverlap(fixed, target, clearanceMm)) {
          queue.push({ id: fixed.id, targetId: target.id });
        }
      }
    }
  }

  return { shapes: working, moved, truncated };
}

/** 押し出し先がエラー状態（荷台外／不動オブジェクトと重なる）になるときの重み。 */
const PENALTY_INVALID = 1e6;
/** 押し出しの軸が連鎖の向きと変わるときの重み。移動量より優先するが、エラーよりは軽い。 */
const PENALTY_AXIS_SWITCH = 1e3;

/**
 * pusherから離れる向きにtargetをずらす量を求める。
 * 4方向の候補をスコアで評価する。スコアは移動量に、
 *   - 荷台外に出る／不動オブジェクトに重なる  → 大きなペナルティ
 *   - 連鎖の向き（preferredAxis）と軸が変わる → 中くらいのペナルティ
 * を加えたもの。既に押し出されている矩形はその軸の候補だけに絞る（振動防止）。
 */
function computePush(pusher, target, {
  lockedAxis, preferredAxis, bed, pinnedShapes, trigger, clearanceMm
}) {
  const overlappingPairs = [];
  for (const pusherPart of pusher.parts) {
    for (const targetPart of target.parts) {
      if (partsOverlap(pusherPart, targetPart, trigger)) {
        overlappingPairs.push([pusherPart, targetPart]);
      }
    }
  }
  // 呼び出し元と同じ partsOverlap で拾うため通常は空にならないが、
  // 空のまま null を返すと押し出しが止まって重なりが残る。保険として bbox 全体を1組にする。
  if (overlappingPairs.length === 0) overlappingPairs.push([boundsOf(pusher.parts), boundsOf(target.parts)]);

  // 1組だけを基準にすると別のパーツが食い込んだまま残る。各方向について、
  // 重なっている全パーツ対を抜けるのに必要な最大の移動量を採る。
  const candidates = [
    {
      axis: 'x',
      dx: Math.min(...overlappingPairs.map(([pp, tp]) => pp.x - tp.w - clearanceMm - tp.x)),
      dy: 0
    },
    {
      axis: 'x',
      dx: Math.max(...overlappingPairs.map(([pp, tp]) => pp.x + pp.w + clearanceMm - tp.x)),
      dy: 0
    },
    {
      axis: 'y',
      dx: 0,
      dy: Math.min(...overlappingPairs.map(([pp, tp]) => pp.y - tp.d - clearanceMm - tp.y))
    },
    {
      axis: 'y',
      dx: 0,
      dy: Math.max(...overlappingPairs.map(([pp, tp]) => pp.y + pp.d + clearanceMm - tp.y))
    }
  ];

  const usable = lockedAxis
    ? candidates.filter((candidate) => candidate.axis === lockedAxis)
    : candidates;
  if (usable.length === 0) return null;

  let best = null;
  let bestScore = Infinity;

  for (const candidate of usable) {
    const landed = movedShape(target, candidate.dx, candidate.dy);

    let score = Math.abs(candidate.dx) + Math.abs(candidate.dy);
    if (!isInsideBed(boundsOf(landed.parts), bed)) score += PENALTY_INVALID;
    if (pinnedShapes.some((shape) => shape.id !== target.id && shapesOverlap(landed, shape))) {
      score += PENALTY_INVALID;
    }
    if (preferredAxis && candidate.axis !== preferredAxis) score += PENALTY_AXIS_SWITCH;

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best || (best.dx === 0 && best.dy === 0)) return null;
  return { axis: best.axis, dx: Math.round(best.dx), dy: Math.round(best.dy) };
}

function translateShape(shape, dx, dy) {
  for (const part of shape.parts) {
    part.x += dx;
    part.y += dy;
    if (part.points) part.points = part.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
  }
}

function movedShape(shape, dx, dy) {
  return {
    ...shape,
    parts: shape.parts.map((part) => ({
      ...part,
      x: part.x + dx,
      y: part.y + dy,
      points: part.points?.map((point) => ({ x: point.x + dx, y: point.y + dy }))
    }))
  };
}

/**
 * エラー状態（赤色表示の対象）を判定する。
 * 荷台からはみ出しているもの、障害物や他の機材との隙間がクリアランスに
 * 足りていないものを返す。
 *
 * 判定にも設定値をそのまま使う。設定を広げた瞬間に、その隙間を確保できていない
 * 機材が赤くなる。配置は動かさないので、どこを直せばよいかだけが伝わる。
 *
 * @param {number} clearanceMm 確保すべき隙間。0 を渡すと「実際に重なっているものだけ」を返す。
 * @returns {Set<string>} エラーになった形のidの集合
 */
export function findInvalidShapes(shapes, bed, obstacles = [], clearanceMm = DEFAULT_CLEARANCE_MM) {
  const invalid = new Set();

  for (const shape of shapes) {
    if (!fitsInBed(boundsOf(shape.parts), bed, clearanceMm)) {
      invalid.add(shape.id);
    }
    for (const obstacle of obstacles) {
      if (shapesOverlap(shape, obstacle, clearanceMm)) {
        invalid.add(shape.id);
      }
    }
  }

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (shapesOverlap(shapes[i], shapes[j], clearanceMm)) {
        invalid.add(shapes[i].id);
        invalid.add(shapes[j].id);
      }
    }
  }

  return invalid;
}

/**
 * 壁との間にクリアランスを確保できているか。
 *
 * 荷台の幅いっぱいに近い機材では、両側にクリアランスを取ると物理的に入らなくなる。
 * その場合は荷台に収まっているかだけを見る。clampToBed の逃がし方と揃えてあり、
 * こうしないと「動かしても直しようがない赤」が residue として残ってしまう。
 */
function fitsInBed(rect, bed, clearanceMm) {
  if (!isInsideBed(rect, bed)) return false;

  const roomX = bed.w - rect.w >= clearanceMm * 2;
  const roomY = bed.d - rect.d >= clearanceMm * 2;
  const okX = !roomX || (rect.x >= clearanceMm && rect.x + rect.w <= bed.w - clearanceMm);
  const okY = !roomY || (rect.y >= clearanceMm && rect.y + rect.d <= bed.d - clearanceMm);
  return okX && okY;
}

/**
 * 荷台内で、指定形状の機材を置ける空き位置を左前から探す。
 * リストからクリックで追加するときや複製するときの初期位置に使う。
 * 見つからなければ null を返す（呼び出し側で「置けなかった」と伝える）。
 *
 * 候補は「壁ぎわ」と「既にあるパーツの右／後ろにクリアランスを空けて接する位置」に限る。
 * 固定間隔の格子で走査すると、格子の目からわずかに外れた隙間を丸ごと見落とす。
 * 例えば内寸 2363mm の荷台に幅 1160mm を2つ並べる位置は x = 1180 だが、
 * 50mm 刻みでは 1160 の次が 1210 で上限を超えるため、2つ目が永久に置けなくなる。
 * 辺を基準にすれば必ず詰めて置ける。
 */
export function findFreeSpot(parts, occupied, bed, obstacles = [], clearanceMm = DEFAULT_CLEARANCE_MM) {
  const blockers = [...occupied, ...obstacles];
  const localBounds = boundsOf(parts);
  const localParts = parts.map((part) => ({
    ...part,
    x: part.x - localBounds.x,
    y: part.y - localBounds.y,
    points: part.points?.map((point) => ({ x: point.x - localBounds.x, y: point.y - localBounds.y }))
  }));
  const blockerParts = blockers.flatMap((shape) => shape.parts);
  const xs = edgeCandidates(
    blockerParts.flatMap((blocker) =>
      localParts.map((part) => blocker.x + blocker.w - part.x)
    ),
    clearanceMm
  );
  const ys = edgeCandidates(
    blockerParts.flatMap((blocker) =>
      localParts.map((part) => blocker.y + blocker.d - part.y)
    ),
    clearanceMm
  );

  for (const y of ys) {
    if (y + localBounds.d > bed.d) continue;
    for (const x of xs) {
      if (x + localBounds.w > bed.w) continue;
      const candidate = {
        id: '__candidate__',
        parts: localParts.map((part) => ({
          ...part,
          x: x + part.x,
          y: y + part.y,
          points: part.points?.map((point) => ({ x: x + point.x, y: y + point.y }))
        }))
      };
      // 左前の候補は clearanceMm から始まるが、右・奥側も同じ基準で確かめる。
      // 枠内だけを見て返すと、大きな複合ブロックが壁から数mmの位置に入り、
      // 呼び出し側の最終検証で同じ候補が不正扱いになる。
      if (!fitsInBed(boundsOf(candidate.parts), bed, clearanceMm)) continue;
      const collides = blockers.some((other) => shapesOverlap(candidate, other, clearanceMm));
      if (!collides) return { x, y };
    }
  }
  return null;
}

/** 壁ぎわと各辺の外側を、左前から順に並べた候補にする。 */
function edgeCandidates(edges, clearanceMm) {
  const values = [clearanceMm, ...edges.map((edge) => edge + clearanceMm)];
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
}
