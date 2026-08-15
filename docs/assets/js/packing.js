// レイアウトの状態モデルと集計。geometry.js と同じく純粋な計算だけを持ち、
// SupabaseもDOMも参照しない。
//
// 画面が扱う状態の形:
//   slot = {
//     id, slot, truckId,
//     truck: { name, bedWidthMm, bedDepthMm, bedHeightMm, maxPayloadKg },
//     obstacles: [{ id, label, x, y, w, d, heightMm }],
//     placements: [{ id, equipmentId, snapshot, x, y, rotation }]
//   }
//   snapshot = { name, widthMm, depthMm, heightMm, weightKg, color }

import {
  toRect, rotatedSize, resolveOverlaps, findInvalidRects, snapPosition, findFreeSpot,
  DEFAULT_CLEARANCE_MM
} from './geometry.js';

// 機材置き場（ステージングエリア）の寸法。
// 「その現場に必要な機材を先に並べてから積む」という実際の作業手順を画面上でも
// なぞれるよう、トラックの下に常設する。マスタ登録はせず固定寸法とする。
//
// 荷台と同じく x = 幅方向 / y = 奥行き方向。描画時に90度回して横向きに描く
// （renderer.js）ため、画面上では 8000mm の辺が横に伸びる。トラックと座標系を
// 揃えておかないと、エリアをまたいでドラッグしたときに機材の向きが変わってしまう。
export const STAGING_SLOT = 0;
export const STAGING_WIDTH_MM = 2000;
export const STAGING_DEPTH_MM = 8000;

/** 空の機材置き場を作る。トラックが未読込でも先に機材を並べられるよう常に存在させる。 */
export function createStagingSlot() {
  return {
    slot: STAGING_SLOT,
    truckId: null,
    truck: {
      kind: 'staging',
      name: '機材置き場',
      bedWidthMm: STAGING_WIDTH_MM,
      bedDepthMm: STAGING_DEPTH_MM,
      // 置き場には高さ・積載重量の制限がない。null を「制限なし」として扱う。
      bedHeightMm: null,
      maxPayloadKg: null
    },
    obstacles: [],
    placements: []
  };
}

export function isStaging(slot) {
  return slot?.truck?.kind === 'staging';
}

/** 荷台内寸を geometry.js が使う {w, d} 形式にする。 */
export function bedOf(slot) {
  return { w: slot.truck.bedWidthMm, d: slot.truck.bedDepthMm };
}

/** 障害物を当たり判定用の矩形にする。idは機材と衝突しないよう接頭辞を付ける。 */
export function obstacleRects(slot) {
  return (slot.obstacles ?? []).map((obstacle) => ({
    id: `obstacle:${obstacle.id}`,
    x: obstacle.x,
    y: obstacle.y,
    w: obstacle.w,
    d: obstacle.d
  }));
}

/** 機材の配置を当たり判定用の矩形にする。 */
export function placementRects(slot) {
  return slot.placements.map(toRect);
}

/**
 * 荷台に収まる位置へ座標を丸める。壁を押しても機材が壁で止まるようにするため、
 * ドラッグ中とナッジで使う。回転後の外形で計算するので rotation を見る必要はない。
 *
 * 機材置き場は素通しする。ここは積み込み前の作業台で、収まらない機材の逃がし先を
 * 兼ねているため、壁で止めると置き場所が無くなって操作に詰まる。
 */
export function clampToBed(placement, slot, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const x = Math.round(placement.x);
  const y = Math.round(placement.y);
  if (isStaging(slot)) return { x, y };

  const bed = bedOf(slot);
  const rect = toRect(placement);
  return {
    x: clampAxis(x, bed.w - rect.w, clearanceMm),
    y: clampAxis(y, bed.d - rect.d, clearanceMm)
  };
}

/**
 * 壁からクリアランスぶん内側の範囲へ丸める。
 * 荷台の幅いっぱいに近い機材ではその範囲が消える（下限が上限を上回る）ので、
 * そのときはクリアランスを諦めて荷台内に収めることを優先する。
 */
function clampAxis(value, max, clearanceMm) {
  if (max - clearanceMm < clearanceMm) return Math.max(0, Math.min(value, Math.max(max, 0)));
  return Math.max(clearanceMm, Math.min(value, max - clearanceMm));
}

/**
 * 機材マスタから新しい配置を作る。
 * 荷台に空きが無ければ null を返す。重ねて仮置きすると、収まらない配置を
 * 作らせないという方針に反するため、呼び出し側で「置けなかった」と伝えさせる。
 * 機材置き場だけは作業台なので、空きが無くても左前に置く。
 */
export function createPlacement(equipment, slot, idFactory, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const size = { w: equipment.width_mm, d: equipment.depth_mm };
  const free = findFreeSpot(
    size, placementRects(slot), bedOf(slot), obstacleRects(slot), clearanceMm
  );
  if (!free && !isStaging(slot)) return null;
  const spot = free ?? { x: 10, y: 10 };

  return {
    id: idFactory(),
    equipmentId: equipment.id,
    snapshot: {
      name: equipment.name,
      widthMm: equipment.width_mm,
      depthMm: equipment.depth_mm,
      heightMm: equipment.height_mm,
      weightKg: Number(equipment.weight_kg ?? 0),
      color: equipment.color
    },
    x: spot.x,
    y: spot.y,
    rotation: 0
  };
}

/**
 * 配置を複製する。斜めにずらすだけでは荷台の後端にある機材が必ずはみ出すので、
 * createPlacement と同じように空きを探して置く。空きが無ければ null を返す。
 */
export function duplicatePlacement(slot, placementId, idFactory, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const source = slot.placements.find((placement) => placement.id === placementId);
  if (!source) return null;

  const rect = toRect(source);
  const free = findFreeSpot(
    { w: rect.w, d: rect.d },
    placementRects(slot),
    bedOf(slot),
    obstacleRects(slot),
    clearanceMm
  );
  if (!free && !isStaging(slot)) return null;
  const spot = free ?? { x: 10, y: 10 };

  return {
    ...source,
    snapshot: { ...source.snapshot },
    id: idFactory(),
    x: spot.x,
    y: spot.y
  };
}

/**
 * 配置を移動する。スナップを効かせたうえで、重なりを連鎖的に解消する。
 * 結果が荷台に収まらなければ移動そのものを棄却する（rejected を参照）。
 * @param {number} thresholdMm スナップの効く距離（ズーム率に応じて呼び出し側が決める）
 * @returns {{placements: Array, truncated: boolean, rejected: boolean}}
 */
export function movePlacement(slot, placementId, position, thresholdMm, clearanceMm = DEFAULT_CLEARANCE_MM) {
  return applyMove(slot, slot, placementId, position, thresholdMm, clearanceMm);
}

/**
 * 移動の実体。before には「操作前のスロット」を渡す。
 * 別エリアから移してきた場合、slot には移動中の機材が既に足されているため、
 * それを含まない before と比べないと、着地した時点で不正でも棄却できない。
 */
function applyMove(slot, before, placementId, position, thresholdMm, clearanceMm) {
  const moving = slot.placements.find((placement) => placement.id === placementId);
  if (!moving) return { placements: slot.placements, truncated: false, rejected: false };

  const size = rotatedSize(moving.snapshot.widthMm, moving.snapshot.depthMm, moving.rotation);
  const others = [
    ...placementRects(slot).filter((rect) => rect.id !== placementId),
    ...obstacleRects(slot)
  ];

  const snapped = snapPosition(
    { id: placementId, x: position.x, y: position.y, w: size.w, d: size.d },
    others,
    bedOf(slot),
    thresholdMm,
    clearanceMm
  );

  const updated = slot.placements.map((placement) =>
    placement.id === placementId ? { ...placement, x: snapped.x, y: snapped.y } : placement
  );

  return settle({ ...slot, placements: updated }, before, placementId, null, clearanceMm);
}

/**
 * 配置を別のエリアへ移す（機材置き場 → トラック、トラック → 別のトラック など）。
 * 移動先では通常の移動と同じようにスナップと連鎖押し出しが働く。
 *
 * @returns {{source: Array, target: Array, truncated: boolean, rejected: boolean}}
 *   それぞれ移動元・移動先の新しい placements 配列。
 *   移動先に収まらない場合は棄却し、両方とも元のまま返す（移動元に留まる）。
 */
export function movePlacementToSlot(
  sourceSlot, targetSlot, placementId, position, thresholdMm, clearanceMm = DEFAULT_CLEARANCE_MM
) {
  const moving = sourceSlot.placements.find((placement) => placement.id === placementId);
  if (!moving) {
    return {
      source: sourceSlot.placements,
      target: targetSlot.placements,
      truncated: false,
      rejected: false
    };
  }

  const source = sourceSlot.placements.filter((placement) => placement.id !== placementId);
  const landed = { ...moving, x: Math.round(position.x), y: Math.round(position.y) };
  const staged = { ...targetSlot, placements: [...targetSlot.placements, landed] };

  const result = applyMove(staged, targetSlot, placementId, position, thresholdMm, clearanceMm);
  if (result.rejected) {
    return {
      source: sourceSlot.placements,
      target: targetSlot.placements,
      truncated: result.truncated,
      rejected: true
    };
  }

  return { source, target: result.placements, truncated: result.truncated, rejected: false };
}

/**
 * 配置を90度回転させる。回転で伸びた軸を押し出しの優先方向として渡すことで、
 * 一列に並んだ機材が列の向きに沿って逃げるようにする。
 *
 * 隣接する機材を押し出すのは許すが、押し出した結果まで含めて荷台に収まる場合だけ。
 * 収まらなければ回転を棄却するので、向きも位置も元のまま返る。
 */
export function rotatePlacement(slot, placementId, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const target = slot.placements.find((placement) => placement.id === placementId);
  if (!target) return { placements: slot.placements, truncated: false, rejected: false };

  const before = rotatedSize(target.snapshot.widthMm, target.snapshot.depthMm, target.rotation);
  const rotation = (target.rotation + 90) % 360;
  const after = rotatedSize(target.snapshot.widthMm, target.snapshot.depthMm, rotation);

  const updated = slot.placements.map((placement) =>
    placement.id === placementId ? { ...placement, rotation } : placement
  );

  const preferredAxis = after.w > before.w ? 'x' : after.d > before.d ? 'y' : null;
  return settle({ ...slot, placements: updated }, slot, placementId, preferredAxis, clearanceMm);
}

/**
 * 指定した配置を固定したまま、重なりを連鎖的に解消して座標を確定させる。
 * 障害物も固定側に含めるため、機材が障害物を押しのけることはない。
 * 収束後に判定し、収まらなければ操作前（before）の配置をそのまま返す。
 */
function settle(slot, before, pinnedPlacementId, preferredAxis, clearanceMm) {
  const obstacles = obstacleRects(slot);
  const rects = [...placementRects(slot), ...obstacles];
  const pinnedIds = [pinnedPlacementId, ...obstacles.map((rect) => rect.id)];

  const resolved = resolveOverlaps(rects, pinnedIds, bedOf(slot), { preferredAxis, clearanceMm });
  const byId = new Map(resolved.rects.map((rect) => [rect.id, rect]));

  const placements = slot.placements.map((placement) => {
    const rect = byId.get(placement.id);
    return rect ? { ...placement, x: rect.x, y: rect.y } : placement;
  });

  if (rejects(before, { ...slot, placements })) {
    return { placements: before.placements, truncated: resolved.truncated, rejected: true };
  }

  return { placements, truncated: resolved.truncated, rejected: false };
}

/**
 * 操作を棄却すべきか。操作前に問題の無かった機材が、操作の結果はみ出したり
 * 重なったりしたら棄却する。
 *
 * 「結果が少しでも不正なら棄却」にしないのは、はみ出しを含む既存データ
 * （DBは負の座標も許している）を開いたときに、以後あらゆる操作が棄却されて
 * 直せなくなるため。悪化させない操作は通す。
 *
 * 機材置き場は判定しない。積み込み前の作業台なので、収まるかどうかを
 * 問う場所ではない。
 */
function rejects(before, after) {
  if (isStaging(after)) return false;

  const was = invalidIdsOf(before);
  for (const id of invalidIdsOf(after)) {
    if (!was.has(id)) return true;
  }
  return false;
}

function invalidIdsOf(slot) {
  return findInvalidRects(placementRects(slot), bedOf(slot), obstacleRects(slot));
}

/**
 * 集計パネル用の数値をまとめて返す。
 * 高さはパイロット版では配置計算に使わないが、荷台内寸を超える機材は件数で警告する。
 */
export function summarize(slot) {
  const bed = bedOf(slot);
  const rects = placementRects(slot);
  const invalid = findInvalidRects(rects, bed, obstacleRects(slot));

  const bedArea = bed.w * bed.d;
  const usedArea = rects.reduce((total, rect) => total + rect.w * rect.d, 0);
  const totalWeightKg = slot.placements.reduce(
    (total, placement) => total + (placement.snapshot.weightKg ?? 0),
    0
  );
  // bedHeightMm が null（＝高さ制限なし。機材置き場がこれ）のときに素の比較をすると、
  // null が 0 に変換されて全機材が高さ超過と判定されてしまう。明示的に除外する。
  const bedHeightMm = slot.truck.bedHeightMm;
  const overHeight =
    bedHeightMm === null || bedHeightMm === undefined
      ? []
      : slot.placements.filter((placement) => placement.snapshot.heightMm > bedHeightMm);

  const maxPayloadKg = slot.truck.maxPayloadKg ?? null;

  return {
    placementCount: slot.placements.length,
    floorAreaRatio: bedArea > 0 ? usedArea / bedArea : 0,
    usedAreaMm2: usedArea,
    bedAreaMm2: bedArea,
    totalWeightKg,
    maxPayloadKg,
    payloadRatio: maxPayloadKg ? totalWeightKg / maxPayloadKg : null,
    overPayload: maxPayloadKg !== null && totalWeightKg > maxPayloadKg,
    invalidIds: invalid,
    invalidCount: [...invalid].filter((id) => !String(id).startsWith('obstacle:')).length,
    overHeightCount: overHeight.length,
    overHeightNames: overHeight.map((placement) => placement.snapshot.name)
  };
}

/**
 * 選択中の機材から荷台の各壁までの残り寸法。寸法パネルに出す。
 */
export function clearances(slot, placementId) {
  const placement = slot.placements.find((item) => item.id === placementId);
  if (!placement) return null;

  const bed = bedOf(slot);
  const rect = toRect(placement);
  return {
    left: rect.x,
    right: bed.w - (rect.x + rect.w),
    front: rect.y,
    back: bed.d - (rect.y + rect.d),
    width: rect.w,
    depth: rect.d
  };
}
