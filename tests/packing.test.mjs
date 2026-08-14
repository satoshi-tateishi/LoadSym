// packing.js（レイアウト状態の操作と集計）の回帰テスト。`npm test` で実行する。

import { movePlacement, rotatePlacement, summarize, clearances, createPlacement }
  from '../docs/assets/js/packing.js';

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
  // 障害物（タイヤハウス）の上に直接ドロップした場合は、位置を勝手に補正せず
  // エラー（赤表示）にする。仕様どおり「移動を阻む」のではなく「見せて気づかせる」。
  const tire = { id: 'tire', label: 'タイヤハウス', x: 0, y: 1800, w: 300, d: 900, heightMm: 300 };
  const slot = makeSlot(
    [{ id: 'p1', snapshot: snapshot('A', 400, 600, 500, 10), x: 1000, y: 2000, rotation: 0 }],
    [tire]
  );
  const { placements } = movePlacement(slot, 'p1', { x: 10, y: 2000 }, 60);
  const s = summarize({ ...slot, placements });
  eq('障害物との干渉をエラーにする', s.invalidCount, 1);
  eq('エラー対象は該当機材', [...s.invalidIds].includes('p1'), true);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
