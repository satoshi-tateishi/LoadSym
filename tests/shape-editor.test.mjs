// shape-editor.js の保存前正規化と入力検証の回帰テスト。
// ブラウザ向けのESMをNodeからそのまま読み、既存テストと同じ小さなハーネスで実行する。

import { prepareEquipmentShape, shapeEditor } from '../docs/assets/js/shape-editor.js';

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

console.log('\n# shapeEditor cancel/apply');
{
  const target = form([
    { kind: 'rect', x: 0, y: 0, w: 600, d: 400 },
    { kind: 'rect', x: 600, y: 0, w: 200, d: 200 }
  ], 800, 400);
  const editor = shapeEditor(target);
  editor.openEditor();
  editor.removePart(1);
  editor.closeEditor();
  eq('閉じるとshapeと外形寸法を編集前へ戻す', target, form([
    { kind: 'rect', x: 0, y: 0, w: 600, d: 400 },
    { kind: 'rect', x: 600, y: 0, w: 200, d: 200 }
  ], 800, 400));
}
{
  const target = { width_mm: 600, depth_mm: 400, shape: null };
  const editor = shapeEditor(target);
  editor.openEditor();
  editor.updatePart(0, 'w', 800);
  editor.apply();
  eq('形を反映すると編集後の外形寸法を保持する', target, {
    width_mm: 800, depth_mm: 400, shape: null
  });
}
{
  const target = { width_mm: 600, depth_mm: 400, shape: null };
  const editor = shapeEditor(target);
  editor.tool = 'polygon';
  editor.openEditor();
  eq('開くとツールを選択へ戻す', editor.tool, 'select');
  editor.tool = 'polygon';
  editor.closeEditor();
  eq('閉じるとツールを選択へ戻す', editor.tool, 'select');
}
{
  const target = { width_mm: 600, depth_mm: 400, shape: null };
  const editor = shapeEditor(target);
  editor.chamfers = [50, 60, 70, 80];
  editor.openEditor();
  eq('開くと前回の角落とし量を消す', editor.chamfers, [0, 0, 0, 0]);

  editor.chamfers = [200, 0, 0, 0];
  editor.drag = { kind: 'create' };
  editor.draft = { kind: 'rect', x: 700, y: 0, w: 400, d: 400 };
  editor.$refs = { canvas: { hasPointerCapture: () => false } };
  editor.pointerUp({ pointerId: 1 });
  eq('新規パーツを確定すると角落とし量を消す', editor.chamfers, [0, 0, 0, 0]);
  eq('新規パーツが選択される', editor.selectedIndex, 1);
}
{
  const target = { width_mm: 600, depth_mm: 400, shape: null };
  const editor = shapeEditor(target);
  editor.openEditor();
  editor.chamfers = [50, 60, 70, 80];
  editor.drag = {
    kind: 'chamfer',
    index: 0,
    corner: 2,
    original: { kind: 'rect', x: 0, y: 0, w: 600, d: 400 }
  };
  editor.point = () => ({ x: 500, y: 300 });
  editor.pointerMove({});
  eq('角落としドラッグで他3隅の値を保持する', editor.chamfers, [50, 60, 100, 80]);
}
{
  const target = form([{ kind: 'polygon', points: [
    { x: 0, y: 0 }, { x: 7, y: 3 }, { x: 0, y: 10 }
  ] }], 7, 10);
  const editor = shapeEditor(target);
  editor.openEditor();
  editor.insertVertex(0, 0);
  eq('斜辺では丸めず共線の中点を追加する', editor.parts[0].points[1], { x: 3.5, y: 1.5 });
  editor.apply();
  eq('斜辺の中点を形の反映後も保持する', target.shape.parts[0].points[1], { x: 3.5, y: 1.5 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
