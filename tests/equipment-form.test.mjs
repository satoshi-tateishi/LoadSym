import assert from 'node:assert/strict';
import {
  defaultCategoryIdOf,
  categoryDefaultColorOf,
  emptyEquipmentDraft,
  buildEquipmentValues
} from '../docs/assets/js/equipment-form.js';
import { withSaving } from '../docs/assets/js/error-messages.js';

const categories = [
  { id: 'speaker', name: 'スピーカー', default_color: '#123456' },
  { id: 'other', name: 'その他', default_color: '#abcdef' }
];

assert.equal(defaultCategoryIdOf(categories), 'other');
assert.equal(defaultCategoryIdOf(categories.slice(0, 1)), 'speaker');
assert.equal(defaultCategoryIdOf([]), null);
assert.equal(categoryDefaultColorOf(categories, 'speaker'), '#123456');
assert.equal(categoryDefaultColorOf(categories, 'missing'), null);

assert.deepEqual(emptyEquipmentDraft('other', '#abcdef'), {
  id: null,
  name: '',
  category_id: 'other',
  width_mm: 600,
  depth_mm: 400,
  height_mm: 500,
  weight_kg: 0,
  color: '#abcdef',
  shape: null
});

const form = {
  name: '機材', category_id: '', width_mm: 100, depth_mm: 200,
  height_mm: 300, weight_kg: null, color: '#123456', shape: null,
  asTemplate: true
};
assert.deepEqual(buildEquipmentValues(form, 'other'), {
  name: '機材', category_id: 'other', width_mm: 100, depth_mm: 200,
  height_mm: 300, weight_kg: 0, color: '#123456', shape: null
});

const successful = { saving: false, errorMessage: '前のエラー' };
await withSaving(successful, async () => {
  assert.equal(successful.saving, true);
  assert.equal(successful.errorMessage, '');
});
assert.deepEqual(successful, { saving: false, errorMessage: '' });

const failed = { saving: false, errorMessage: '' };
let handled = false;
const originalConsoleError = console.error;
console.error = () => {};
try {
  await withSaving(failed, async () => {
    throw new Error('保存失敗');
  }, {
    onError: () => { handled = true; }
  });
} finally {
  console.error = originalConsoleError;
}
assert.equal(failed.saving, false);
assert.equal(failed.errorMessage, '保存失敗');
assert.equal(handled, true);

console.log('equipment-form tests: ok');
