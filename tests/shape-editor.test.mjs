import assert from 'node:assert/strict';
import { prepareEquipmentShape } from '../docs/assets/js/shape-editor.js';

function form(parts, width = 1, depth = 1) {
  return { width_mm: width, depth_mm: depth, shape: { parts } };
}

{
  const target = form([
    { kind: 'rect', x: 100, y: 200, w: 1000, d: 400 },
    { kind: 'rect', x: 1100, y: 200, w: 600, d: 200 }
  ]);
  prepareEquipmentShape(target);
  assert.equal(target.width_mm, 1600);
  assert.equal(target.depth_mm, 400);
  assert.deepEqual(target.shape.parts, [
    { kind: 'rect', x: 0, y: 0, w: 1000, d: 400 },
    { kind: 'rect', x: 1000, y: 0, w: 600, d: 200 }
  ]);
}

{
  const target = form([{ kind: 'rect', x: 20, y: 30, w: 600, d: 400 }]);
  prepareEquipmentShape(target);
  assert.equal(target.width_mm, 600);
  assert.equal(target.depth_mm, 400);
  assert.equal(target.shape, null);
}

{
  const target = form([
    { kind: 'rect', x: 0, y: 0, w: 600, d: 400 },
    { kind: 'rect', x: 500, y: 300, w: 200, d: 200 }
  ]);
  assert.throws(() => prepareEquipmentShape(target), /重なっています/);
}

{
  const target = { width_mm: 20001, depth_mm: 400, shape: null };
  assert.throws(() => prepareEquipmentShape(target), /1〜20000mm/);
}

console.log('shape-editor tests: ok');
