// shape-editor.js の保存前正規化と入力検証の回帰テスト。
// ブラウザ向けのESMをNodeからそのまま読み、既存テストと同じ小さなハーネスで実行する。

import { prepareEquipmentShape } from '../docs/assets/js/shape-editor.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  NG  ${name}\n      got  ${g}\n      want ${w}`); }
};

const throws = (name, action, pattern) => {
  try {
    action();
    fail++;
    console.log(`  NG  ${name}\n      エラーが発生しませんでした`);
  } catch (error) {
    const matched = pattern.test(error.message);
    if (matched) { pass++; console.log(`  ok  ${name}`); }
    else { fail++; console.log(`  NG  ${name}\n      got  ${error.message}\n      want ${pattern}`); }
  }
};

function form(parts, width = 1, depth = 1) {
  return { width_mm: width, depth_mm: depth, shape: { parts } };
}

console.log('# prepareEquipmentShape');
{
  const target = form([
    { kind: 'rect', x: 100, y: 200, w: 1000, d: 400 },
    { kind: 'rect', x: 1100, y: 200, w: 600, d: 200 }
  ]);
  prepareEquipmentShape(target);
  eq('bboxの左前を原点へ正規化', target, {
    width_mm: 1600,
    depth_mm: 400,
    shape: { parts: [
      { kind: 'rect', x: 0, y: 0, w: 1000, d: 400 },
      { kind: 'rect', x: 1000, y: 0, w: 600, d: 200 }
    ] }
  });
}
{
  const target = form([{ kind: 'rect', x: 20, y: 30, w: 600, d: 400 }]);
  prepareEquipmentShape(target);
  eq('矩形1枚ならshape=null', target, { width_mm: 600, depth_mm: 400, shape: null });
}
{
  const target = form([
    { kind: 'rect', x: 0, y: 0, w: 600, d: 400 },
    { kind: 'rect', x: 500, y: 300, w: 200, d: 200 }
  ]);
  throws('重なったパーツを棄却', () => prepareEquipmentShape(target), /重なっています/);
}
{
  const target = { width_mm: 20001, depth_mm: 400, shape: null };
  throws('寸法上限を超えた矩形を棄却', () => prepareEquipmentShape(target), /1〜20000mm/);
}
{
  const target = form([{ kind: 'circle', cx: 300, cy: 400, r: 200 }]);
  prepareEquipmentShape(target);
  eq('円のbboxを書き戻して円心を原点合わせ', target, {
    width_mm: 400, depth_mm: 400,
    shape: { parts: [{ kind: 'circle', cx: 200, cy: 200, r: 200 }] }
  });
}
{
  const target = form([{ kind: 'polygon', points: [
    { x: 100, y: 200 }, { x: 500, y: 200 }, { x: 400, y: 600 }, { x: 100, y: 500 }
  ] }]);
  prepareEquipmentShape(target);
  eq('多角形のbboxを書き戻して頂点を原点合わせ', target, {
    width_mm: 400, depth_mm: 400,
    shape: { parts: [{ kind: 'polygon', points: [
      { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 300, y: 400 }, { x: 0, y: 300 }
    ] }] }
  });
}
{
  throws('半径0の円を棄却', () => prepareEquipmentShape(form([
    { kind: 'circle', cx: 10, cy: 10, r: 0 }
  ])), /半径/);
  throws('頂点不足の多角形を棄却', () => prepareEquipmentShape(form([
    { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
  ])), /3点以上/);
  throws('凹多角形を棄却', () => prepareEquipmentShape(form([
    { kind: 'polygon', points: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 40 }, { x: 100, y: 100 }, { x: 0, y: 100 }
    ] }
  ])), /凸形状/);
}
{
  throws('円と矩形の混在重なりを棄却', () => prepareEquipmentShape(form([
    { kind: 'circle', cx: 100, cy: 100, r: 80 },
    { kind: 'rect', x: 150, y: 50, w: 100, d: 100 }
  ])), /パーツ 1 と 2/);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
