// geometry.js の配置ロジックの回帰テスト。`npm test` で実行する。
//
// 連鎖押し出しは手で追いにくく、実際に「連鎖が途中で軸を変えて列が崩れる」
// 「障害物の上に押し出してしまう」という2つのバグをここで検出した。
// アルゴリズムに手を入れるときは必ずこれを通すこと。
//
// ブラウザ向けのESMをNodeからそのまま読むため、依存ゼロ・アサーションも自前。

import { snapPosition, resolveOverlaps, findInvalidRects, rotatedSize, rectsOverlap, CLEARANCE_MM }
  from '../docs/assets/js/geometry.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  NG  ${name}\n      got  ${g}\n      want ${w}`); }
};

const rectsOverlapForTest = (a, b) => rectsOverlap(a, b);
const bed = { w: 2000, d: 4000 };

console.log('# rotatedSize');
eq('0度', rotatedSize(600, 400, 0), { w: 600, d: 400 });
eq('90度', rotatedSize(600, 400, 90), { w: 400, d: 600 });

console.log('# snapPosition');
eq('左前の壁に吸着', snapPosition({ id: 'a', x: 3, y: 4, w: 600, d: 400 }, [], bed, 50), { x: 10, y: 10 });
eq('右奥の壁に吸着',
  snapPosition({ id: 'a', x: 1385, y: 3585, w: 600, d: 400 }, [], bed, 50),
  { x: 2000 - 600 - 10, y: 4000 - 400 - 10 });
eq('遠ければ吸着しない', snapPosition({ id: 'a', x: 800, y: 900, w: 600, d: 400 }, [], bed, 50), { x: 800, y: 900 });
// 既存機材 (10,10,600x400) の右隣に 10mm 空けて付く
eq('隣接スナップ',
  snapPosition({ id: 'b', x: 615, y: 12, w: 600, d: 400 }, [{ id: 'a', x: 10, y: 10, w: 600, d: 400 }], bed, 50),
  { x: 620, y: 10 });

console.log('# resolveOverlaps');
{
  // a を固定して b が重なっている状態 → b が右へ押し出される
  const rects = [
    { id: 'a', x: 100, y: 100, w: 600, d: 400 },
    { id: 'b', x: 400, y: 100, w: 600, d: 400 }
  ];
  const r = resolveOverlaps(rects, ['a'], bed);
  eq('bが押し出される', r.rects.find((x) => x.id === 'b'), { id: 'b', x: 710, y: 100, w: 600, d: 400 });
  eq('aは不動', r.rects.find((x) => x.id === 'a'), { id: 'a', x: 100, y: 100, w: 600, d: 400 });
  eq('打ち切っていない', r.truncated, false);
  eq('クリアランス10mm', r.rects[1].x - (rects[0].x + rects[0].w), CLEARANCE_MM);
}
{
  // 連鎖: a固定、b,c が数珠つなぎ
  const rects = [
    { id: 'a', x: 100, y: 100, w: 600, d: 400 },
    { id: 'b', x: 400, y: 100, w: 600, d: 400 },
    { id: 'c', x: 900, y: 100, w: 600, d: 400 }
  ];
  const r = resolveOverlaps(rects, ['a'], bed);
  const b = r.rects.find((x) => x.id === 'b'), c = r.rects.find((x) => x.id === 'c');
  eq('連鎖でbが移動', b.x, 710);
  eq('連鎖でcも移動', c.x, 1320);
  eq('b-c間クリアランス', c.x - (b.x + b.w), CLEARANCE_MM);
  eq('振動せず収束', r.truncated, false);
}
{
  // 逃げ場のない狭い荷台。押し出した結果はみ出す → 赤対象になる
  // 荷台が機材1つ分しかなく、左右にも前後にも逃げ場がない
  const tight = { w: 1000, d: 500 };
  const rects = [
    { id: 'a', x: 50, y: 50, w: 900, d: 400 },
    { id: 'b', x: 100, y: 50, w: 900, d: 400 }
  ];
  const r = resolveOverlaps(rects, ['a'], tight);
  const invalid = findInvalidRects(r.rects, tight);
  eq('逃げ場がなければはみ出す', [...invalid], ['b']);
}
{
  // 障害物(pinned)の上には押し出さない
  const rects = [
    { id: 'a', x: 100, y: 100, w: 600, d: 400 },
    { id: 'b', x: 400, y: 100, w: 600, d: 400 },
    { id: 'tire', x: 710, y: 100, w: 300, d: 400 }
  ];
  const r = resolveOverlaps(rects, ['a', 'tire'], bed, { preferredAxis: 'x' });
  const b = r.rects.find((x) => x.id === 'b');
  const tire = r.rects.find((x) => x.id === 'tire');
  eq('障害物は不動', { x: tire.x, y: tire.y }, { x: 710, y: 100 });
  eq('障害物を避けて押し出される', rectsOverlapForTest(b, tire), false);
}

console.log('# findInvalidRects');
eq('障害物と重なる',
  [...findInvalidRects([{ id: 'a', x: 0, y: 0, w: 500, d: 500 }], bed, [{ id: 'o', x: 400, y: 400, w: 200, d: 200 }])],
  ['a']);
eq('10mm離れていれば正常',
  [...findInvalidRects([
    { id: 'a', x: 10, y: 10, w: 600, d: 400 },
    { id: 'b', x: 620, y: 10, w: 600, d: 400 }
  ], bed)],
  []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
