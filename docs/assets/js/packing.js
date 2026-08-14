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

import { toRect, rotatedSize, resolveOverlaps, findInvalidRects, snapPosition, findFreeSpot }
  from './geometry.js';

// 機材置き場（ステージングエリア）の寸法。
// 「その現場に必要な機材を先に並べてから積む」という実際の作業手順を画面上でも
// なぞれるよう、トラックの下に常設する。マスタ登録はせず固定寸法とする。
// 置き場はトラックより横長に描くため、同じ機材でもトラック側よりやや大きく見える。
// 幅を広げるほどトラック側のスケールに近づくので、使ってみて調整する余地を残している。
export const STAGING_SLOT = 0;
export const STAGING_WIDTH_MM = 8000;
export const STAGING_DEPTH_MM = 2000;

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

/** 機材マスタから新しい配置を作る。空き位置が無ければ左前に重ねて置く（エラー表示になる）。 */
export function createPlacement(equipment, slot, idFactory) {
  const size = { w: equipment.width_mm, d: equipment.depth_mm };
  const spot =
    findFreeSpot(size, placementRects(slot), bedOf(slot), obstacleRects(slot)) ?? { x: 10, y: 10 };

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
 * 配置を移動する。スナップを効かせたうえで、重なりを連鎖的に解消する。
 * @param {number} thresholdMm スナップの効く距離（ズーム率に応じて呼び出し側が決める）
 * @returns {{placements: Array, truncated: boolean}}
 */
export function movePlacement(slot, placementId, position, thresholdMm) {
  const moving = slot.placements.find((placement) => placement.id === placementId);
  if (!moving) return { placements: slot.placements, truncated: false };

  const size = rotatedSize(moving.snapshot.widthMm, moving.snapshot.depthMm, moving.rotation);
  const others = [
    ...placementRects(slot).filter((rect) => rect.id !== placementId),
    ...obstacleRects(slot)
  ];

  const snapped = snapPosition(
    { id: placementId, x: position.x, y: position.y, w: size.w, d: size.d },
    others,
    bedOf(slot),
    thresholdMm
  );

  const updated = slot.placements.map((placement) =>
    placement.id === placementId ? { ...placement, x: snapped.x, y: snapped.y } : placement
  );

  return settle({ ...slot, placements: updated }, placementId, null);
}

/**
 * 配置を別のエリアへ移す（機材置き場 → トラック、トラック → 別のトラック など）。
 * 移動先では通常の移動と同じようにスナップと連鎖押し出しが働く。
 *
 * @returns {{source: Array, target: Array, truncated: boolean}}
 *   それぞれ移動元・移動先の新しい placements 配列。
 */
export function movePlacementToSlot(sourceSlot, targetSlot, placementId, position, thresholdMm) {
  const moving = sourceSlot.placements.find((placement) => placement.id === placementId);
  if (!moving) {
    return { source: sourceSlot.placements, target: targetSlot.placements, truncated: false };
  }

  const source = sourceSlot.placements.filter((placement) => placement.id !== placementId);
  const landed = { ...moving, x: Math.round(position.x), y: Math.round(position.y) };
  const staged = { ...targetSlot, placements: [...targetSlot.placements, landed] };

  const result = movePlacement(staged, placementId, position, thresholdMm);
  return { source, target: result.placements, truncated: result.truncated };
}

/**
 * 配置を90度回転させる。回転で伸びた軸を押し出しの優先方向として渡すことで、
 * 一列に並んだ機材が列の向きに沿って逃げるようにする。
 */
export function rotatePlacement(slot, placementId) {
  const target = slot.placements.find((placement) => placement.id === placementId);
  if (!target) return { placements: slot.placements, truncated: false };

  const before = rotatedSize(target.snapshot.widthMm, target.snapshot.depthMm, target.rotation);
  const rotation = (target.rotation + 90) % 360;
  const after = rotatedSize(target.snapshot.widthMm, target.snapshot.depthMm, rotation);

  const updated = slot.placements.map((placement) =>
    placement.id === placementId ? { ...placement, rotation } : placement
  );

  const preferredAxis = after.w > before.w ? 'x' : after.d > before.d ? 'y' : null;
  return settle({ ...slot, placements: updated }, placementId, preferredAxis);
}

/**
 * 指定した配置を固定したまま、重なりを連鎖的に解消して座標を確定させる。
 * 障害物も固定側に含めるため、機材が障害物を押しのけることはない。
 */
function settle(slot, pinnedPlacementId, preferredAxis) {
  const obstacles = obstacleRects(slot);
  const rects = [...placementRects(slot), ...obstacles];
  const pinnedIds = [pinnedPlacementId, ...obstacles.map((rect) => rect.id)];

  const resolved = resolveOverlaps(rects, pinnedIds, bedOf(slot), { preferredAxis });
  const byId = new Map(resolved.rects.map((rect) => [rect.id, rect]));

  const placements = slot.placements.map((placement) => {
    const rect = byId.get(placement.id);
    return rect ? { ...placement, x: rect.x, y: rect.y } : placement;
  });

  return { placements, truncated: resolved.truncated };
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
