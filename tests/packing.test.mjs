// packing.js（レイアウト状態の操作と集計）の回帰テスト。`npm test` で実行する。

import {
  movePlacement, movePlacementToSlot, rotatePlacement, summarize, clearances,
  createPlacement, createStagingSlot, isStaging, STAGING_SLOT,
  clampToBed, duplicatePlacement
} from '../docs/assets/js/packing.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  NG  ${name}\n      got  ${g}\n      want ${w}`);
  }
};

const snapshot = (name, w, d, h, kg, color = '#64748b') => ({
  name,
  widthMm: w,
  depthMm: d,
  heightMm: h,
  weightKg: kg,
  color
});

// 2tロング相当の荷台
const makeSlot = (placements, obstacles = []) => ({
  id: 'lt1',
  slot: 1,
  truck: {
    name: '2tロング',
    bedWidthMm: 1700,
    bedDepthMm: 4400,
    bedHeightMm: 1900,
    maxPayloadKg: 2000
  },
  obstacles,
  placements
});

console.log('# summarize');
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('アンプラック', 600, 800, 1200, 120), x: 10, y: 10, rotation: 0 }
  ]);
  const s = summarize(slot);
  eq('機材点数', s.placementCount, 1);
  eq('占有面積', s.usedAreaMm2, 600 * 800);
  eq('総重量', s.totalWeightKg, 120);
  eq('積載率', Math.round(s.payloadRatio * 1000) / 1000, 0.06);
  eq('過積載でない', s.overPayload, false);
  eq('エラーなし', s.invalidCount, 0);
  eq('高さ超過なし', s.overHeightCount, 0);
}
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('重量物', 600, 800, 1200, 1500), x: 10, y: 10, rotation: 0 },
    { id: 'p2', snapshot: snapshot('重量物', 600, 800, 2000, 900), x: 10, y: 900, rotation: 0 }
  ]);
  const s = summarize(slot);
  eq('過積載を検出', s.overPayload, true);
  eq('高さ超過を検出', s.overHeightCount, 1);
  eq('高さ超過の機材名', s.overHeightNames, ['重量物']);
}

console.log('# rotatePlacement');
{
  // 幅方向に3つ並べ、真ん中を回転させると幅が伸びて両隣を押す
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 },
    { id: 'p2', snapshot: snapshot('B', 400, 600, 500, 10), x: 420, y: 10, rotation: 0 },
    { id: 'p3', snapshot: snapshot('C', 400, 600, 500, 10), x: 830, y: 10, rotation: 0 }
  ]);
  const { placements, truncated } = rotatePlacement(slot, 'p2');
  const byId = Object.fromEntries(placements.map((p) => [p.id, p]));
  eq('回転角が90度になる', byId.p2.rotation, 90);
  eq('回転した機材は動かない', { x: byId.p2.x, y: byId.p2.y }, { x: 420, y: 10 });
  // p2は回転後 600x400。右端は 420+600=1020 なので p3 は 1030 へ押される
  eq('右隣が押し出される', byId.p3.x, 1030);
  eq('左隣は押されない', byId.p1.x, 10);
  eq('収束する', truncated, false);
}

console.log('# movePlacement');
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 800, y: 800, rotation: 0 }
  ]);
  const { placements } = movePlacement(slot, 'p1', { x: 4, y: 3 }, 60);
  eq('壁にスナップする', { x: placements[0].x, y: placements[0].y }, { x: 10, y: 10 });
}
{
  // 障害物（タイヤハウス）の上には物理的に置けない。赤くして見せるのではなく、
  // 移動そのものを棄却して元の位置に留める。
  const tire = { id: 'tire', label: 'タイヤハウス', x: 0, y: 1800, w: 300, d: 900, heightMm: 300 };
  const slot = makeSlot(
    [{ id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 1000, y: 2000, rotation: 0 }],
    [tire]
  );
  const r = movePlacement(slot, 'p1', { x: 10, y: 2000 }, 60);
  eq('障害物の上へは移動できない', r.rejected, true);
  eq('位置は元のまま', { x: r.placements[0].x, y: r.placements[0].y }, { x: 1000, y: 2000 });
  eq('エラーが残らない', summarize({ ...slot, placements: r.placements }).invalidCount, 0);
}
{
  // 一方、押し出しの結果として障害物の上へ送り込むことはしない（避けて逃げる）
  const tire = { id: 'tire', label: 'タイヤハウス', x: 700, y: 0, w: 300, d: 900, heightMm: 300 };
  const slot = makeSlot(
    [
      { id: 'p1', snapshot: snapshot('A', 600, 600, 500, 10), x: 10, y: 10, rotation: 0 },
      { id: 'p2', snapshot: snapshot('B', 600, 600, 500, 10), x: 300, y: 10, rotation: 0 }
    ],
    [tire]
  );
  const { placements } = movePlacement(slot, 'p1', { x: 10, y: 10 }, 60);
  const s = summarize({ ...slot, placements });
  eq('押し出し先に障害物を選ばない', s.invalidCount, 0);
}

console.log('# clearances');
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  eq('壁までの残り寸法', clearances(slot, 'p1'), {
    left: 10,
    right: 1700 - 410,
    front: 10,
    back: 4400 - 610,
    width: 400,
    depth: 600
  });
}

console.log('# createPlacement');
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  let n = 0;
  const created = createPlacement(
    { id: 'e1', name: 'B', width_mm: 400, depth_mm: 600, height_mm: 500, weight_kg: 10, color: '#ff0000' },
    slot,
    () => `new${++n}`
  );
  eq('既存機材と重ならない位置に置かれる', created.x >= 420 || created.y >= 620, true);
  eq('回転は0で作られる', created.rotation, 0);
  eq('スナップショットを持つ', created.snapshot.name, 'B');
}

console.log('# 機材置き場');
{
  const staging = createStagingSlot();
  eq('スロット0で作られる', staging.slot, STAGING_SLOT);
  eq('種別がstaging', isStaging(staging), true);
  eq('高さ制限なし', staging.truck.bedHeightMm, null);
  eq('積載重量制限なし', staging.truck.maxPayloadKg, null);
  eq('中身は空', staging.placements.length, 0);
}
{
  // bedHeightMm が null のとき、素の比較だと 0 扱いになり全機材が高さ超過になる回帰テスト
  const staging = createStagingSlot();
  staging.placements = [
    { id: 'p1', snapshot: snapshot('背の高い機材', 600, 600, 2500, 30), x: 10, y: 10, rotation: 0 },
    { id: 'p2', snapshot: snapshot('低い機材', 600, 600, 200, 10), x: 620, y: 10, rotation: 0 }
  ];
  const s = summarize(staging);
  eq('高さ超過を判定しない', s.overHeightCount, 0);
  eq('積載率は算出しない', s.payloadRatio, null);
  eq('過積載にならない', s.overPayload, false);
  eq('総重量は集計する', s.totalWeightKg, 40);
}

console.log('# movePlacementToSlot（エリア間移動）');
{
  const staging = createStagingSlot();
  staging.placements = [
    { id: 'p1', snapshot: snapshot('メインSP', 700, 500, 900, 45), x: 1000, y: 500, rotation: 0 }
  ];
  const truck = makeSlot([
    { id: 't1', snapshot: snapshot('先客', 600, 600, 500, 20), x: 10, y: 10, rotation: 0 }
  ]);

  // 荷台の左前あたりへドロップ → 壁にスナップし、先客とぶつかるので押し出される
  const r = movePlacementToSlot(staging, truck, 'p1', { x: 5, y: 4 }, 60);
  eq('移動元から取り除かれる', r.source.length, 0);
  eq('移動先に追加される', r.target.length, 2);

  const moved = r.target.find((p) => p.id === 'p1');
  eq('移動先で壁にスナップする', { x: moved.x, y: moved.y }, { x: 10, y: 10 });

  // p1(700x500) の下へ押し出される。右へ逃がすより移動量が小さいため。
  const pushed = r.target.find((p) => p.id === 't1');
  eq('先客が押し出される', { x: pushed.x, y: pushed.y }, { x: 10, y: 520 });
  eq('クリアランス10mm', pushed.y - (moved.y + 500), 10);
  eq('重なりが残らない', summarize({ ...truck, placements: r.target }).invalidCount, 0);
  eq('収束する', r.truncated, false);
}
{
  // トラック → 置き場へ戻せる。機材のスナップショットは失われない。
  const truck = makeSlot([
    { id: 'p1', snapshot: snapshot('アンプラック', 650, 900, 1400, 130), x: 10, y: 10, rotation: 90 }
  ]);
  const staging = createStagingSlot();
  const r = movePlacementToSlot(truck, staging, 'p1', { x: 2000, y: 800 }, 60);
  const moved = r.target[0];
  eq('トラック側が空になる', r.source.length, 0);
  eq('機材情報が保たれる', moved.snapshot.name, 'アンプラック');
  eq('回転角も保たれる', moved.rotation, 90);
  eq('置き場の集計に乗る', summarize({ ...staging, placements: r.target }).totalWeightKg, 130);
}
{
  // 存在しないidを渡しても壊れない
  const staging = createStagingSlot();
  const truck = makeSlot([]);
  const r = movePlacementToSlot(staging, truck, 'missing', { x: 0, y: 0 }, 60);
  eq('存在しない配置は無視する', { s: r.source.length, t: r.target.length }, { s: 0, t: 0 });
}

console.log('# 荷台に収まらない操作を成立させない');
// 任意の内寸の荷台。逃げ場の有無を作り分けるために使う。
const makeBed = (bedWidthMm, bedDepthMm, placements) => ({
  id: 'x1',
  slot: 1,
  truck: { name: 'テスト', bedWidthMm, bedDepthMm, bedHeightMm: 1900, maxPayloadKg: 2000 },
  obstacles: [],
  placements
});

{
  // 回転で隣を押し出すのは許す。押し出した結果まで荷台に収まっているため。
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 },
    { id: 'p2', snapshot: snapshot('B', 400, 600, 500, 10), x: 420, y: 10, rotation: 0 }
  ]);
  const r = rotatePlacement(slot, 'p1');
  eq('収まるなら回転できる', r.rejected, false);
  eq('回転が反映される', r.placements.find((p) => p.id === 'p1').rotation, 90);
  eq('隣が押し出される', r.placements.find((p) => p.id === 'p2').x, 620);
  eq('押し出し後もエラーなし', summarize({ ...slot, placements: r.placements }).invalidCount, 0);
}
{
  // 回転すると幅1800が内寸1700を超える。押し出す相手もいないので単純に棄却される。
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('長物', 400, 1800, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  const r = rotatePlacement(slot, 'p1');
  eq('収まらない回転は棄却する', r.rejected, true);
  eq('向きは元のまま', r.placements[0].rotation, 0);
  eq('位置も元のまま', { x: r.placements[0].x, y: r.placements[0].y }, { x: 10, y: 10 });
}
{
  // 逃げ場のない荷台。回転すると隣がどちらへ逃げても荷台外に出るので、回転ごと棄却する。
  const slot = makeBed(1000, 700, [
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 },
    { id: 'p2', snapshot: snapshot('B', 400, 600, 500, 10), x: 420, y: 10, rotation: 0 }
  ]);
  const r = rotatePlacement(slot, 'p1');
  eq('押し出し先がなければ回転しない', r.rejected, true);
  eq('押し出される側も動かない', r.placements.find((p) => p.id === 'p2').x, 420);
  eq('はみ出しが生まれない', summarize({ ...slot, placements: r.placements }).invalidCount, 0);
}
{
  // 壁の外へは出さない。壁に押し付けた形で止まる。
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  const placement = slot.placements[0];
  eq('右の壁で止まる', clampToBed({ ...placement, x: 9999, y: 10 }, slot).x, 1700 - 400);
  eq('後ろの壁で止まる', clampToBed({ ...placement, x: 10, y: 9999 }, slot).y, 4400 - 600);
  eq('左の壁で止まる', clampToBed({ ...placement, x: -500, y: 10 }, slot).x, 0);
  // 回転後の外形で判定する（幅と奥行きが入れ替わる）
  const turned = { ...placement, rotation: 90, x: 9999, y: 9999 };
  eq('回転後の外形で止まる', clampToBed(turned, slot), { x: 1700 - 600, y: 4400 - 400 });
}
{
  // 荷台より大きい機材は上限が負になる。左前の角に寄せる。
  const slot = makeBed(500, 500, []);
  const oversize = { id: 'p1', snapshot: snapshot('大物', 900, 900, 500, 10), x: 300, y: 300, rotation: 0 };
  eq('荷台より大きければ角に寄る', clampToBed(oversize, slot), { x: 0, y: 0 });
}
{
  // 機材置き場は積み込み前の作業台。収まるかどうかを問わない。
  const staging = createStagingSlot();
  staging.placements = [
    { id: 'p1', snapshot: snapshot('A', 700, 500, 900, 45), x: 100, y: 100, rotation: 0 }
  ];
  eq('置き場では壁で止めない', clampToBed({ ...staging.placements[0], x: 9999, y: 10 }, staging).x, 9999);
  const r = movePlacement(staging, 'p1', { x: 1900, y: 100 }, 0);
  eq('置き場では棄却しない', r.rejected, false);
  eq('置き場でははみ出せる', r.placements[0].x, 1900);
}
{
  // 既にはみ出している既存データを開いても、悪化させない操作は通す。
  // そうしないと直す手立てがなくなる。
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 1500, y: 10, rotation: 0 }
  ]);
  eq('前提: 元からはみ出している', summarize(slot).invalidCount, 1);

  const stillOut = movePlacement(slot, 'p1', { x: 1450, y: 10 }, 0);
  eq('はみ出したままの移動は通す', stillOut.rejected, false);
  eq('移動が反映される', stillOut.placements[0].x, 1450);

  const fixed = movePlacement(slot, 'p1', { x: 100, y: 10 }, 0);
  eq('荷台内へ戻す移動も通す', fixed.rejected, false);
  eq('はみ出しが解消する', summarize({ ...slot, placements: fixed.placements }).invalidCount, 0);
}
{
  // 別エリアへのドロップも、移動先に収まらなければ移動元に留める。
  const staging = createStagingSlot();
  staging.placements = [
    { id: 'p1', snapshot: snapshot('長物', 400, 1800, 500, 10), x: 100, y: 100, rotation: 90 }
  ];
  const truck = makeBed(1000, 4400, []);
  const r = movePlacementToSlot(staging, truck, 'p1', { x: 10, y: 10 }, 0);
  eq('収まらない移動は棄却する', r.rejected, true);
  eq('移動元に留まる', r.source.length, 1);
  eq('移動先には増えない', r.target.length, 0);
}

console.log('# 空きが無いときは置かない');
{
  const slot = makeBed(500, 500, []);
  const created = createPlacement(
    { id: 'e1', name: '大物', width_mm: 900, depth_mm: 900, height_mm: 500, weight_kg: 10, color: '#ff0000' },
    slot,
    () => 'new1'
  );
  eq('荷台に空きが無ければ作らない', created, null);
}
{
  // 置き場は逃がし先なので、空きが無くても置ける
  const staging = createStagingSlot();
  const created = createPlacement(
    { id: 'e1', name: '大物', width_mm: 9000, depth_mm: 9000, height_mm: 500, weight_kg: 10, color: '#ff0000' },
    staging,
    () => 'new1'
  );
  eq('置き場は空きが無くても置ける', created?.id, 'new1');
}
{
  const slot = makeSlot([
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  const copy = duplicatePlacement(slot, 'p1', () => 'copy1');
  eq('複製は空きに置かれる', summarize({ ...slot, placements: [...slot.placements, copy] }).invalidCount, 0);
  eq('複製は別idになる', copy.id, 'copy1');
  eq('複製は元の情報を保つ', { name: copy.snapshot.name, rotation: copy.rotation }, { name: 'A', rotation: 0 });
}
{
  const slot = makeBed(420, 620, [
    { id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 10, y: 10, rotation: 0 }
  ]);
  eq('空きが無ければ複製しない', duplicatePlacement(slot, 'p1', () => 'copy1'), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
