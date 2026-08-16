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
export const DEFAULT_CLEARANCE_MM = 5;
/** ユーザーが設定できるクリアランスの範囲(mm)。 */
export const MIN_SETTING_CLEARANCE_MM = 1;
export const MAX_SETTING_CLEARANCE_MM = 10;
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
 * shape を有効な軸平行矩形の配列に正規化する。
 * 未知の kind は将来形式として無視し、有効な矩形が残らない場合や shape 自体が
 * 壊れている場合は、外形サイズと同じ矩形1枚へフォールバックする。
 */
export function normalizeShape(shape, widthMm, depthMm) {
  const fallback = [{ x: 0, y: 0, w: widthMm, d: depthMm }];
  if (!Array.isArray(shape?.parts) || shape.parts.length === 0) return fallback;

  const rects = shape.parts.filter((part) => part?.kind === 'rect');
  const hasInvalidRect = rects.some((part) =>
    !Number.isFinite(part.x) ||
    !Number.isFinite(part.y) ||
    !Number.isFinite(part.w) ||
    !Number.isFinite(part.d) ||
    part.w <= 0 ||
    part.d <= 0
  );
  if (hasInvalidRect) return fallback;

  const parts = rects.map((part) => ({ x: part.x, y: part.y, w: part.w, d: part.d }));

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

    return {
      id: placement.id,
      partIndex,
      x: placement.x + transformed.x,
      y: placement.y + transformed.y,
      w: transformed.w,
      d: transformed.d
    };
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

/** 2つの形に、指定間隔を割り込むパーツ対が1組でもあるか。 */
export function shapesOverlap(a, b, gap = 0) {
  return a.parts.some((partA) =>
    b.parts.some((partB) => rectsOverlap(partA, partB, gap))
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
 * @param {{preferredAxis?: 'x'|'y', clearanceMm?: number}} options
 *   preferredAxis は起点の押し出し方向のヒント
 *   （回転で幅が伸びたなら 'x'、奥行きが伸びたなら 'y' を渡す）。
 *   clearanceMm は押し出したあとに空ける隙間。
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

  const queue = [...pinnedIds];
  let iterations = 0;
  let moved = false;
  let truncated = false;

  while (queue.length > 0) {
    if (iterations++ >= MAX_PUSH_ITERATIONS) {
      truncated = true;
      break;
    }

    const pusher = byId.get(queue.shift());
    if (!pusher) continue;

    for (const target of working) {
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
      pushDirection.set(target.id, displacement.axis);
      moved = true;
      queue.push(target.id);
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
      if (rectsOverlap(pusherPart, targetPart, trigger)) {
        overlappingPairs.push([pusherPart, targetPart]);
      }
    }
  }
  if (overlappingPairs.length === 0) return null;

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
  }
}

function movedShape(shape, dx, dy) {
  return {
    ...shape,
    parts: shape.parts.map((part) => ({ ...part, x: part.x + dx, y: part.y + dy }))
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
 * @param {number} clearanceMm 確保すべき隙間。0 を渡すと「実際に重なっているものだけ」を返す
 *   （機材置き場はこれを使う。積み込み前の作業台で、隙間を問う場所ではないため）。
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
    y: part.y - localBounds.y
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
        parts: localParts.map((part) => ({ ...part, x: x + part.x, y: y + part.y }))
      };
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
