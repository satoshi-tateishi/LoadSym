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
//   snapshot = { name, widthMm, depthMm, heightMm, weightKg, color, shape }

import {
  toParts, toShape, rectToShape, boundsOf, resolveOverlaps, findInvalidShapes,
  snapPosition, findFreeSpot, partArea,
  DEFAULT_CLEARANCE_MM, MIN_SETTING_CLEARANCE_MM
} from './geometry.js';

const GROUP_WIDTH_RATIOS = [1 / 2, 3 / 5, 2 / 3, 1];

// 先頭は変更前のアルゴリズムをそのまま再現する退行防止戦略。
// 同点では定義順が結果になるため、並び順も含めて明示する。
const ARRANGEMENT_STRATEGIES = Object.freeze([
  { name: 'legacy-area', orderBy: 'totalArea', exploreCandidates: false },
  { name: 'search-area', orderBy: 'totalArea', exploreCandidates: true },
  { name: 'search-depth', orderBy: 'depth', exploreCandidates: true },
  { name: 'search-width', orderBy: 'width', exploreCandidates: true }
]);

function strategiesForCount(count) {
  // 60点で4戦略を走らせると約1430msだった。縦積み候補の再計算が大半を占めるため
  // 差は小さいが、41点以上は実測で勝った面積順探索までの先頭2本に絞り、
  // 1500msの操作待ち上限へ余裕を持たせる。退行防止戦略は必ず残る。
  if (count > 40) return ARRANGEMENT_STRATEGIES.slice(0, 2);
  return ARRANGEMENT_STRATEGIES;
}

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

/** 障害物を1パーツの形にし、機材と同じ判定経路に乗せる。 */
export function obstacleShapes(slot) {
  return obstacleRects(slot).map(rectToShape);
}

/** 機材の配置を当たり判定用の形にする。 */
export function placementShapes(slot) {
  return slot.placements.map(toShape);
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
  const rect = boundsOf(toParts(placement));
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
  const draft = {
    id: '__new__',
    snapshot: {
      widthMm: equipment.width_mm,
      depthMm: equipment.depth_mm,
      shape: equipment.shape ?? null
    },
    x: 0,
    y: 0,
    rotation: 0
  };
  const free = findFreeSpot(
    toParts(draft), placementShapes(slot), bedOf(slot), obstacleShapes(slot), clearanceMm
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
      color: equipment.color,
      shape: equipment.shape ?? null
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

  const free = findFreeSpot(
    toParts({ ...source, x: 0, y: 0 }),
    placementShapes(slot),
    bedOf(slot),
    obstacleShapes(slot),
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
 * 指定したトラック内の全機材を、荷台の左前から詰め直す。
 *
 * 同一機材を小さなブロックにまとめ、グループ単位の90度回転と幅比率を候補にして
 * 既存の空き探索へ通すことで、人手で積むときに近いまとまりを作る。
 * 同一機材が5台以上あり、1台を除外すると使用奥行きが大きく縮む場合は、その1台を
 * 縦積み候補として床面計算から外す（2D上では後方へ退避し、実際には重ねない）。
 * 1点でも置けない、または最終検証で不正が残る場合は途中結果を破棄する。
 *
 * DOM・履歴・通知には触れず、入力の slot / placements も変更しない。
 * @returns {{placements:Array, status:'arranged'|'unchanged'|'failed', unplacedIds:Array<string>, stackSuggestion?:object}}
 */
export function autoArrangeSlot(slot, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const originals = slot?.placements ?? [];
  if (!slot?.truck || isStaging(slot) || originals.length === 0) {
    return { placements: originals, status: 'unchanged', unplacedIds: [] };
  }

  const bed = bedOf(slot);
  const obstacles = obstacleShapes(slot);
  const recalculated = arrangeFloor(originals, bed, obstacles, clearanceMm);
  if (!recalculated) {
    return {
      placements: originals,
      status: 'failed',
      unplacedIds: originals.map((placement) => placement.id)
    };
  }

  // 既存データが正常かつ再計算より短い場合は、それ自体を最良候補として扱う。
  // 人手で作った理想型を自動配置で悪化させず、以後の試行錯誤の基準にもできる。
  const existingIsValid = findInvalidShapes(
    originals.map(toShape), bed, obstacles, clearanceMm
  ).size === 0;
  const normal = existingIsValid && usedDepth(originals) <= usedDepth(recalculated.placements)
    ? originals
    : recalculated.placements;

  const suggested = findStackSuggestion(
    originals, normal, bed, obstacles, clearanceMm, recalculated.strategy
  );
  const placements = suggested?.placements ?? normal;

  const unchanged = placements.every((placement, index) =>
    placement.x === originals[index].x &&
    placement.y === originals[index].y &&
    placement.rotation === originals[index].rotation
  );

  const result = {
    placements: unchanged ? originals : placements,
    status: unchanged ? 'unchanged' : 'arranged',
    unplacedIds: []
  };
  if (suggested) result.stackSuggestion = suggested.stackSuggestion;
  return result;
}

/** 複数のグループ戦略を最後まで走らせ、成立した完成配置から最良を選ぶ。 */
function arrangeFloor(originals, bed, obstacles, clearanceMm, fixedStrategy = null) {
  const strategies = fixedStrategy ? [fixedStrategy] : strategiesForCount(originals.length);
  let best = null;

  for (const strategy of strategies) {
    const groups = compactArrangementGroups(originals, bed, clearanceMm, strategy);
    const arrangedById = arrangeGroups(groups, bed, obstacles, clearanceMm);
    if (!arrangedById) continue;
    const placements = originals.map((placement) => arrangedById.get(placement.id));
    if (findInvalidShapes(placements.map(toShape), bed, obstacles, clearanceMm).size > 0) continue;

    const candidate = {
      placements,
      strategy,
      depth: usedDepth(placements),
      cohesion: groupCohesionArea(placements)
    };
    // 完全同点では置換せず、戦略の定義順（先に評価したもの）を採用する。
    if (
      !best ||
      candidate.depth < best.depth ||
      (candidate.depth === best.depth && candidate.cohesion < best.cohesion)
    ) {
      best = candidate;
    }
  }
  // 個体単位配置は「全戦略が失敗したときの保険」ではなく、対等な候補として比較する。
  // 変更前のアルゴリズムは、グループ配置が最終検証で落ちるとここへ落ちており、
  // 点数の多い構成ではその結果が採用されていた（40点5950mm / 60点8616mmはいずれも個体配置由来）。
  // 候補から外すと、変更前に到達できていた解が探索空間から消えて退行する。
  // 退行防止は「変更前が採りうる全経路を候補に残す」ことで初めて成立する。
  const individual = arrangeIndividually(originals, bed, obstacles, clearanceMm);
  if (individual) {
    const placements = originals.map((placement) => individual.get(placement.id));
    if (findInvalidShapes(placements.map(toShape), bed, obstacles, clearanceMm).size === 0) {
      // 同点ではグループ配置を優先する（同じ奥行きなら同型機材がまとまっているほうが積みやすい）。
      const depth = usedDepth(placements);
      if (!best || depth < best.depth) {
        best = {
          placements,
          strategy: strategies[0],
          depth,
          cohesion: groupCohesionArea(placements)
        };
      }
    }
  }
  return best;
}

/** 配置が占める荷台前端からの奥行き。 */
function usedDepth(placements) {
  return placements.reduce((max, placement) => {
    const bounds = boundsOf(toParts(placement));
    return Math.max(max, bounds.y + bounds.d);
  }, 0);
}

/** 同一グループの外接矩形面積の合計。小さいほど同型機材が散らばっていない。 */
function groupCohesionArea(placements) {
  const byKey = new Map();
  for (const placement of placements) {
    const key = arrangementGroupKey(placement);
    const group = byKey.get(key) ?? [];
    group.push(placement);
    byKey.set(key, group);
  }
  let total = 0;
  for (const group of byKey.values()) {
    const bounds = boundsOf(group.flatMap(toParts));
    total += bounds.w * bounds.d;
  }
  return total;
}

/**
 * 多数ある同一機材から1台だけを外して床面配置を比較し、効果が十分な場合に縦積みを提案する。
 * 候補自体はデータから消さず、計算済みの床面ブロックより後ろへ単独で表示する。
 */
function findStackSuggestion(originals, normal, bed, obstacles, clearanceMm, bestStrategy) {
  const normalDepth = usedDepth(normal);
  const counts = new Map();
  for (const placement of originals) {
    const key = arrangementGroupKey(placement);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = null;
  for (const candidate of originals) {
    // 少数セットを安易に縦積み扱いしない。Bパターンのような多数セットだけを対象とする。
    if ((counts.get(arrangementGroupKey(candidate)) ?? 0) < 5) continue;

    const coreOriginals = originals.filter((placement) => placement.id !== candidate.id);
    // 通常配置で選んだ1戦略だけを使う。候補数×戦略数の乗算を避けるため。
    const recalculatedCore = arrangeFloor(
      coreOriginals, bed, obstacles, clearanceMm, bestStrategy
    )?.placements;
    const existingCore = findInvalidShapes(
      coreOriginals.map(toShape), bed, obstacles, clearanceMm
    ).size === 0 ? coreOriginals : null;
    const core = [recalculatedCore, existingCore]
      .filter(Boolean)
      .sort((a, b) => usedDepth(a) - usedDepth(b))[0];
    if (!core) continue;
    const coreDepth = usedDepth(core);
    const saving = normalDepth - coreDepth;
    if (saving < Math.max(250, normalDepth * 0.1)) continue;

    const held = placeStackCandidateBehindCore(
      candidate, core, coreDepth, bed, obstacles, clearanceMm
    );
    if (!held) continue;
    const byId = new Map(core.map((placement) => [placement.id, placement]));
    byId.set(held.id, held);
    const placements = originals.map((placement) => byId.get(placement.id));
    if (findInvalidShapes(placements.map(toShape), bed, obstacles, clearanceMm).size > 0) continue;

    if (!best || saving > best.saving) {
      best = {
        saving,
        placements,
        stackSuggestion: {
          placementId: candidate.id,
          name: candidate.snapshot?.name ?? '機材',
          coreUsedDepthMm: coreDepth
        }
      };
    }
  }
  return best;
}

/** 縦積み候補を、床面計算に含めていないことが見た目でも分かるよう後方へ退避する。 */
function placeStackCandidateBehindCore(candidate, core, coreDepth, bed, obstacles, clearanceMm) {
  const candidateBounds = boundsOf(toParts(candidate));
  if (
    candidateBounds.y >= coreDepth + clearanceMm &&
    findInvalidShapes([...core.map(toShape), toShape(candidate)], bed, obstacles, clearanceMm).size === 0
  ) {
    return candidate;
  }
  const origin = { ...candidate, x: 0, y: 0 };
  const frontBlocker = rectToShape({
    id: '__stack_suggestion_front__', x: 0, y: 0, w: bed.w, d: coreDepth
  });
  const free = findFreeSpot(
    toParts(origin), core.map(toShape), bed, [...obstacles, frontBlocker], clearanceMm
  );
  return free ? { ...candidate, x: free.x, y: free.y } : null;
}

/** 各ブロック候補を部分配置全体で評価し、実形状の凹みも利用しながら荷台へ配置する。 */
function arrangeGroups(groups, bed, obstacles, clearanceMm) {
  const arranged = new Map();
  const occupied = [];

  for (const group of groups) {
    let best = null;
    for (const candidate of group.candidates) {
      if (candidate.parts.length === 0) continue;
      const free = findFreeSpot(candidate.parts, occupied, bed, obstacles, clearanceMm);
      if (!free) continue;
      const placements = candidate.placements.map((relative) => ({
        ...relative,
        x: free.x + relative.x,
        y: free.y + relative.y
      }));
      const partialDepth = usedDepth([...arranged.values(), ...placements]);
      const blockEnd = free.y + candidate.depth;
      if (
        !best ||
        partialDepth < best.partialDepth ||
        (partialDepth === best.partialDepth && blockEnd < best.blockEnd)
      ) {
        best = { candidate, free, placements, partialDepth, blockEnd };
      }
    }
    if (!best) return null;

    for (const placement of best.placements) arranged.set(placement.id, placement);
    occupied.push({
      id: `arrangement:${group.key}`,
      parts: best.candidate.parts.map((part) => ({
        ...part,
        x: part.x + best.free.x,
        y: part.y + best.free.y,
        points: part.points?.map((point) => ({
          x: point.x + best.free.x,
          y: point.y + best.free.y
        }))
      }))
    });
  }
  return arranged;
}

/** ブロック配置が成立しない場合の安全なフォールバック。 */
function arrangeIndividually(placements, bed, obstacles, clearanceMm) {
  const ordered = placements
    .map((placement, index) => {
      const bounds = boundsOf(toParts(placement));
      return { placement, index, width: bounds.w, depth: bounds.d };
    })
    .sort((a, b) => b.depth - a.depth || b.width - a.width || a.index - b.index);
  const arranged = new Map();
  const occupied = [];

  for (const { placement } of ordered) {
    const free = findFreeSpot(
      toParts({ ...placement, x: 0, y: 0 }), occupied, bed, obstacles, clearanceMm
    );
    if (!free) return null;
    const next = { ...placement, x: free.x, y: free.y };
    arranged.set(next.id, next);
    occupied.push(toShape(next));
  }
  return arranged;
}

/** 同一機材を先にコンパクトな矩形ブロックへまとめ、ブロック面積の大きい順にする。 */
function compactArrangementGroups(placements, bed, clearanceMm, strategy) {
  const byKey = new Map();
  placements.forEach((placement, index) => {
    const key = arrangementGroupKey(placement);
    const group = byKey.get(key) ?? { key, firstIndex: index, placements: [] };
    group.placements.push(placement);
    byKey.set(key, group);
  });

  return [...byKey.values()]
    .map((group) => {
      const totalArea = group.placements.reduce((sum, placement) => {
        const bounds = boundsOf(toParts(placement));
        return sum + bounds.w * bounds.d;
      }, 0);
      return {
        ...group,
        totalArea,
        candidates: compactGroup(group.placements, bed, clearanceMm, strategy.exploreCandidates)
      };
    })
    .map((group) => ({
      ...group,
      width: group.candidates[0]?.width ?? bed.w + 1,
      depth: group.candidates[0]?.depth ?? bed.d + 1
    }))
    .sort((a, b) => compareArrangementGroups(a, b, strategy.orderBy));
}

function compareArrangementGroups(a, b, orderBy) {
  const remaining = ['totalArea', 'depth', 'width'].filter((key) => key !== orderBy);
  return (
    b[orderBy] - a[orderBy] ||
    b[remaining[0]] - a[remaining[0]] ||
    b[remaining[1]] - a[remaining[1]] ||
    a.firstIndex - b.firstIndex
  );
}

/** equipmentId が無いテストデータでも、同じスナップショットなら同じ組として扱う。 */
function arrangementGroupKey(placement) {
  if (placement.equipmentId) return placement.equipmentId;
  const { name, widthMm, depthMm, shape } = placement.snapshot;
  return JSON.stringify([name, widthMm, depthMm, shape ?? null]);
}

/**
 * 現在向き／グループ全体+90度と幅比率の候補を作る。ここでは勝者を選ばない。
 * 先頭は現行の向き・現行の点数別比率とし、退行防止戦略も同じ経路を使う。
 */
function compactGroup(placements, bed, clearanceMm, exploreCandidates) {
  const legacyRatio = placements.length === 2 ? 2 / 3 : 3 / 5;
  const ratios = exploreCandidates
    ? [legacyRatio, ...GROUP_WIDTH_RATIOS.filter((ratio) => ratio !== legacyRatio)]
    : [legacyRatio];
  const changesBounds = placements.some((placement) => {
    const currentBounds = boundsOf(toParts(placement));
    const rotatedBounds = boundsOf(toParts({
      ...placement,
      rotation: ((placement.rotation ?? 0) + 90) % 360
    }));
    return currentBounds.w !== rotatedBounds.w || currentBounds.d !== rotatedBounds.d;
  });
  const candidates = [];
  const dimensions = new Set();
  for (const ratio of ratios) {
    const current = compactGroupOrientation(placements, bed, clearanceMm, ratio);
    if (!current) continue;
    const variants = exploreCandidates && changesBounds
      ? [current, rotatePackedGroup(current)]
      : [current];
    for (const candidate of variants) {
      const key = `${candidate.width}:${candidate.depth}`;
      if (dimensions.has(key)) continue;
      dimensions.add(key);
      candidates.push(candidate);
    }
  }
  return candidates.length > 0
    ? candidates
    : [{ placements, parts: [], width: bed.w + 1, depth: bed.d + 1 }];
}

/** ブロック内の相対位置を保ったまま、全メンバーを時計回りに90度回す。 */
function rotatePackedGroup(candidate) {
  const placements = candidate.placements.map((placement) => {
    const itemBounds = boundsOf(toParts(placement));
    return {
      ...placement,
      x: candidate.depth - (placement.y + itemBounds.d),
      y: placement.x,
      rotation: ((placement.rotation ?? 0) + 90) % 360
    };
  });
  return {
    placements,
    parts: placements.flatMap(toParts),
    width: candidate.depth,
    depth: candidate.width
  };
}

function compactGroupOrientation(placements, bed, clearanceMm, widthRatio) {
  const directionCounts = new Map();
  for (const placement of placements) {
    const bounds = boundsOf(toParts(placement));
    const key = `${bounds.w}:${bounds.d}`;
    directionCounts.set(key, (directionCounts.get(key) ?? 0) + 1);
  }
  const ordered = placements
    .map((placement, index) => {
      const bounds = boundsOf(toParts(placement));
      return {
        placement,
        index,
        width: bounds.w,
        depth: bounds.d,
        directionCount: directionCounts.get(`${bounds.w}:${bounds.d}`)
      };
    })
    .sort((a, b) =>
      b.directionCount - a.directionCount ||
      b.depth - a.depth ||
      b.width - a.width ||
      a.index - b.index
    );

  const largestWidth = Math.max(...ordered.map((item) => item.width));
  const preferredMax = Math.max(largestWidth, Math.floor(bed.w * widthRatio));
  const widths = groupCandidateWidths(ordered, preferredMax, clearanceMm);
  let best = null;

  for (const width of widths) {
    const candidate = packGroupWithinWidth(ordered, width, bed.d, clearanceMm);
    if (!candidate) continue;
    if (
      !best ||
      candidate.depth < best.depth ||
      (candidate.depth === best.depth && candidate.width < best.width)
    ) {
      best = candidate;
    }
  }

  // largestWidth の候補なら縦一列には必ずできる。壊れた寸法だけは呼び出し側で失敗扱いにする。
  return best;
}

/** 1〜3点を横に置く幅と上限幅を候補にする。固定グリッドは使わない。 */
function groupCandidateWidths(items, maxWidth, clearanceMm) {
  const values = new Set([maxWidth]);
  for (let i = 0; i < items.length; i++) {
    values.add(clearanceMm + items[i].width);
    for (let j = i + 1; j < items.length; j++) {
      values.add(clearanceMm * 2 + items[i].width + items[j].width);
      for (let k = j + 1; k < items.length; k++) {
        values.add(
          clearanceMm * 3 + items[i].width + items[j].width + items[k].width
        );
      }
    }
  }
  return [...values]
    .filter((width) => width <= maxWidth)
    .sort((a, b) => a - b);
}

/** 指定幅の仮想荷台へ詰め、左前を(0,0)へ正規化した相対配置を返す。 */
function packGroupWithinWidth(items, width, maxDepth, clearanceMm) {
  const placed = [];
  const occupied = [];

  for (const { placement } of items) {
    const origin = { ...placement, x: 0, y: 0 };
    const free = findFreeSpot(toParts(origin), occupied, { w: width, d: maxDepth }, [], clearanceMm);
    if (!free) return null;
    const next = { ...placement, x: free.x, y: free.y };
    placed.push(next);
    occupied.push(toShape(next));
  }

  const block = boundsOf(occupied.flatMap((shape) => shape.parts));
  const normalized = placed.map((placement) => ({
    ...placement,
    x: placement.x - block.x,
    y: placement.y - block.y
  }));
  return {
    placements: normalized,
    parts: normalized.flatMap(toParts),
    width: block.w,
    depth: block.d
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

  const proposed = { ...moving, x: position.x, y: position.y };
  const others = [
    ...placementShapes(slot).filter((shape) => shape.id !== placementId),
    ...obstacleShapes(slot)
  ];

  const snapped = snapPosition(
    toShape(proposed),
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

  const before = boundsOf(toParts(target));
  const rotation = (target.rotation + 90) % 360;
  const after = boundsOf(toParts({ ...target, rotation }));

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
  const obstacles = obstacleShapes(slot);
  const shapes = [...placementShapes(slot), ...obstacles];
  const pinnedIds = [pinnedPlacementId, ...obstacles.map((shape) => shape.id)];

  const resolved = resolveOverlaps(shapes, pinnedIds, bedOf(slot), { preferredAxis, clearanceMm });
  const byId = new Map(resolved.shapes.map((shape) => [shape.id, boundsOf(shape.parts)]));

  const placements = slot.placements.map((placement) => {
    const rect = byId.get(placement.id);
    return rect ? { ...placement, x: rect.x, y: rect.y } : placement;
  });

  if (rejects(before, { ...slot, placements }, clearanceMm)) {
    return { placements: before.placements, truncated: resolved.truncated, rejected: true };
  }

  return { placements, truncated: resolved.truncated, rejected: false };
}

/**
 * 操作を棄却すべきか。操作前に問題の無かった機材が、操作の結果そうなったら棄却する。
 *
 * 「結果が少しでも不正なら棄却」にしないのは、はみ出しを含む既存データ
 * （DBは負の座標も許している）を開いたときや、クリアランス設定を広げて多くの機材が
 * 赤くなったときに、以後あらゆる操作が棄却されて直せなくなるため。悪化させない操作は通す。
 *
 * ただし判定は2系統に分けること。
 *
 *   物理的に不可能な状態 … 荷台からのはみ出しと、設定範囲の下限(1mm)を割り込む近さ。
 *                          設定値がいくつでも、これは絶対に作らせない。
 *   クリアランス不足     … 設定した隙間に足りない（設定値で判定）
 *
 * ひとまとめにすると、設定を広げて全機材が赤くなった状態では、はみ出しや重なりを
 * 作る操作まで通ってしまう（どれも既に赤いので、悪化したことを検知できない）。
 *
 * 機材置き場は判定しない。積み込み前の作業台なので、収まるかどうかを
 * 問う場所ではない。
 */
function rejects(before, after, clearanceMm) {
  if (isStaging(after)) return false;

  return (
    grew(
      invalidIdsOf(before, MIN_SETTING_CLEARANCE_MM),
      invalidIdsOf(after, MIN_SETTING_CLEARANCE_MM)
    ) ||
    grew(invalidIdsOf(before, clearanceMm), invalidIdsOf(after, clearanceMm))
  );
}

/** after に、before には無かったidが現れたか。 */
function grew(before, after) {
  for (const id of after) {
    if (!before.has(id)) return true;
  }
  return false;
}


function invalidIdsOf(slot, clearanceMm) {
  return findInvalidShapes(placementShapes(slot), bedOf(slot), obstacleShapes(slot), clearanceMm);
}

/**
 * エラー判定に使う隙間。機材置き場は 0（実際に重なっているものだけ赤くする）。
 * 積み込み前の作業台なので、ここで隙間を問うと画面が赤だらけになるだけで役に立たない。
 */
function invalidGapOf(slot, clearanceMm) {
  return isStaging(slot) ? 0 : clearanceMm;
}

/**
 * 集計パネル用の数値をまとめて返す。
 * 高さはパイロット版では配置計算に使わないが、荷台内寸を超える機材は件数で警告する。
 */
export function summarize(slot, clearanceMm = DEFAULT_CLEARANCE_MM) {
  const bed = bedOf(slot);
  const shapes = placementShapes(slot);
  const invalid = findInvalidShapes(shapes, bed, obstacleShapes(slot), invalidGapOf(slot, clearanceMm));

  const bedArea = bed.w * bed.d;
  const usedArea = shapes.reduce(
    (total, shape) => total + shape.parts.reduce((sum, part) => sum + partArea(part), 0),
    0
  );
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
  const rect = boundsOf(toParts(placement));
  return {
    left: rect.x,
    right: bed.w - (rect.x + rect.w),
    front: rect.y,
    back: bed.d - (rect.y + rect.d),
    width: rect.w,
    depth: rect.d
  };
}
