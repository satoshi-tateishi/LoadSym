// 荷台上の矩形配置に関する純粋な計算をまとめる。
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
 * ドラッグ中の矩形について、スナップ後の位置を返す。
 *
 * x軸とy軸を独立に評価する。片方の軸だけが壁に吸い付き、もう片方は自由、
 * という動きのほうが実際の積み込み作業の感覚に近いため。
 *
 * 候補は3種類:
 *   1. 壁面    … 壁からクリアランスぶん離れた位置
 *   2. 隣接    … 既存矩形の外側にクリアランスぶん空けて接する位置
 *   3. 整列    … 既存矩形と辺を揃える位置（この候補だけクリアランスを取らない）
 *
 * @param {{x:number,y:number,w:number,d:number}} moving ドラッグ中の矩形（素の位置）
 * @param {Array} others 既に置かれている矩形と障害物
 * @param {{w:number,d:number}} bed 荷台内寸
 * @param {number} thresholdMm この距離以内の候補にだけ吸着する
 * @param {number} clearanceMm 吸着先で確保する隙間。しきい値とは別物なので混同しないこと
 *   （しきい値は画面px基準でズームに追従させ、こちらは実寸mm）。
 */
export function snapPosition(moving, others, bed, thresholdMm, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const xCandidates = [clearanceMm, bed.w - moving.w - clearanceMm];
  const yCandidates = [clearanceMm, bed.d - moving.d - clearanceMm];

  for (const other of others) {
    if (other.id === moving.id) continue;

    // 隣接（クリアランスあり）
    xCandidates.push(other.x - moving.w - clearanceMm);
    xCandidates.push(other.x + other.w + clearanceMm);
    yCandidates.push(other.y - moving.d - clearanceMm);
    yCandidates.push(other.y + other.d + clearanceMm);

    // 整列（クリアランスなし）
    xCandidates.push(other.x);
    xCandidates.push(other.x + other.w - moving.w);
    yCandidates.push(other.y);
    yCandidates.push(other.y + other.d - moving.d);
  }

  return {
    x: nearestCandidate(moving.x, xCandidates, thresholdMm),
    y: nearestCandidate(moving.y, yCandidates, thresholdMm)
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
 * pinnedIds に含まれる矩形（＝ユーザーが今動かした/回転させたもの、および障害物）は
 * 動かさず、それ以外を押し出す。押された矩形はさらに次の押し手になる。
 *
 * 一度押し出した矩形は押し出し方向を記憶し、以降その軸方向にしか動かさない。
 * こうしないとAがBを右に、BがAを左に押し返して振動する。
 *
 * さらに、押された矩形は「自分を押した矩形と同じ軸」に逃げることを優先する。
 * 単純に移動量が最小の向きを選ぶと、一列に並んだ機材を1つ回転させたときに
 * 2つ目以降が横ではなく手前に逃げてしまい、列が崩れて見えるため。
 *
 * @param {Array} rects 全矩形（障害物も pinnedIds に含めて渡す）
 * @param {Array<string>} pinnedIds 動かさない矩形のid
 * @param {{w:number,d:number}} bed 荷台内寸
 * @param {{preferredAxis?: 'x'|'y', clearanceMm?: number}} options
 *   preferredAxis は起点の押し出し方向のヒント
 *   （回転で幅が伸びたなら 'x'、奥行きが伸びたなら 'y' を渡す）。
 *   clearanceMm は押し出したあとに空ける隙間。
 * @returns {{rects: Array, moved: boolean, truncated: boolean}}
 *   rects は座標を更新した新しい配列（入力は破壊しない）。
 *   truncated は反復上限で打ち切ったかどうか。
 */
export function resolveOverlaps(rects, pinnedIds, bed, options = {}) {
  const clearanceMm = options.clearanceMm ?? DEFAULT_CLEARANCE_MM;
  const working = rects.map((rect) => ({ ...rect }));
  const byId = new Map(working.map((rect) => [rect.id, rect]));
  const pinned = new Set(pinnedIds);
  const pinnedRects = working.filter((rect) => pinned.has(rect.id));
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
      if (!rectsOverlap(pusher, target, trigger)) continue;

      const displacement = computePush(pusher, target, {
        lockedAxis: pushDirection.get(target.id),
        preferredAxis: pushDirection.get(pusher.id) ?? options.preferredAxis ?? null,
        bed,
        pinnedRects,
        clearanceMm
      });
      if (!displacement) continue;

      target.x += displacement.dx;
      target.y += displacement.dy;
      pushDirection.set(target.id, displacement.axis);
      moved = true;
      queue.push(target.id);
    }
  }

  return { rects: working, moved, truncated };
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
function computePush(pusher, target, { lockedAxis, preferredAxis, bed, pinnedRects, clearanceMm }) {
  const candidates = [
    { axis: 'x', dx: pusher.x - target.w - clearanceMm - target.x, dy: 0 },
    { axis: 'x', dx: pusher.x + pusher.w + clearanceMm - target.x, dy: 0 },
    { axis: 'y', dx: 0, dy: pusher.y - target.d - clearanceMm - target.y },
    { axis: 'y', dx: 0, dy: pusher.y + pusher.d + clearanceMm - target.y }
  ];

  const usable = lockedAxis
    ? candidates.filter((candidate) => candidate.axis === lockedAxis)
    : candidates;
  if (usable.length === 0) return null;

  let best = null;
  let bestScore = Infinity;

  for (const candidate of usable) {
    const landed = {
      x: target.x + candidate.dx,
      y: target.y + candidate.dy,
      w: target.w,
      d: target.d
    };

    let score = Math.abs(candidate.dx) + Math.abs(candidate.dy);
    if (!isInsideBed(landed, bed)) score += PENALTY_INVALID;
    if (pinnedRects.some((rect) => rect.id !== target.id && rectsOverlap(landed, rect))) {
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
 * @returns {Set<string>} エラーになった矩形のidの集合
 */
export function findInvalidRects(rects, bed, obstacles = [], clearanceMm = DEFAULT_CLEARANCE_MM) {
  const invalid = new Set();

  for (const rect of rects) {
    if (!fitsInBed(rect, bed, clearanceMm)) {
      invalid.add(rect.id);
    }
    for (const obstacle of obstacles) {
      if (rectsOverlap(rect, obstacle, clearanceMm)) {
        invalid.add(rect.id);
      }
    }
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], clearanceMm)) {
        invalid.add(rects[i].id);
        invalid.add(rects[j].id);
      }
    }
  }

  return invalid;
}

/**
 * 荷台からはみ出している矩形のidを返す。
 *
 * クリアランス不足とは別に見る。はみ出しは「物理的に積めない」ので絶対に作らせないが、
 * クリアランス不足は「設定した余裕が足りない」だけで、設定を広げれば一斉に発生しうる。
 * 両者を一緒に扱うと、設定を広げて全機材が赤くなった状態で、はみ出しを作る操作まで
 * 通ってしまう（どれも既に赤いので「悪化した」と判定できないため）。
 */
export function findOutsideRects(rects, bed) {
  return new Set(rects.filter((rect) => !isInsideBed(rect, bed)).map((rect) => rect.id));
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
 * 荷台内で、指定サイズの機材を置ける空き位置を左前から探す。
 * リストからクリックで追加するときや複製するときの初期位置に使う。
 * 見つからなければ null を返す（呼び出し側で「置けなかった」と伝える）。
 *
 * 候補は「壁ぎわ」と「既にある矩形の右／後ろにクリアランスを空けて接する位置」に限る。
 * 固定間隔の格子で走査すると、格子の目からわずかに外れた隙間を丸ごと見落とす。
 * 例えば内寸 2363mm の荷台に幅 1160mm を2つ並べる位置は x = 1180 だが、
 * 50mm 刻みでは 1160 の次が 1210 で上限を超えるため、2つ目が永久に置けなくなる。
 * 辺を基準にすれば必ず詰めて置ける。
 */
export function findFreeSpot(size, occupied, bed, obstacles = [], clearanceMm = DEFAULT_CLEARANCE_MM) {
  const blockers = [...occupied, ...obstacles];
  const xs = edgeCandidates(blockers.map((rect) => rect.x + rect.w), clearanceMm);
  const ys = edgeCandidates(blockers.map((rect) => rect.y + rect.d), clearanceMm);

  for (const y of ys) {
    if (y + size.d > bed.d) continue;
    for (const x of xs) {
      if (x + size.w > bed.w) continue;
      const candidate = { x, y, w: size.w, d: size.d };
      const collides = blockers.some((other) => rectsOverlap(candidate, other, clearanceMm));
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
