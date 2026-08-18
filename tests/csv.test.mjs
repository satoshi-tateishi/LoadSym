import { parseCsv, toEquipmentRows } from '../docs/assets/js/csv.js';

let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ok  ${name}`);
  else {
    fail++;
    console.log(`  NG  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
};

console.log('# CSVカテゴリフォールバック');
const rows = parseCsv(
  'name,category,width_mm,depth_mm,height_mm\nケース,存在しない,600,400,300'
);
const result = toEquipmentRows(rows, new Map([['予備', 'category-1']]), 'category-1', '予備');
eq('警告に実際のフォールバック先を表示する', result.items[0].problems, [
  'カテゴリ「存在しない」が見つかりません（「予備」として取り込みます）'
]);
eq('フォールバック先IDを保存値に使う', result.items[0].values.category_id, 'category-1');

console.log(`\n${2 - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
