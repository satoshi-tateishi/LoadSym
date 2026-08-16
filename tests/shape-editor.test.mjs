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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
