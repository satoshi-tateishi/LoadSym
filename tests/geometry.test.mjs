// geometry.js の配置ロジックの回帰テスト。`npm test` で実行する。
//
// 連鎖押し出しは手で追いにくく、実際に「連鎖が途中で軸を変えて列が崩れる」
// 「障害物の上に押し出してしまう」という2つのバグをここで検出した。
// アルゴリズムに手を入れるときは必ずこれを通すこと。
//
// ブラウザ向けのESMをNodeからそのまま読むため、依存ゼロ・アサーションも自前。

import {
  snapPosition, resolveOverlaps, findInvalidRects, rotatedSize, rectsOverlap, findFreeSpot,
  toRect, toParts, rectToShape, boundsOf, normalizeShape, shapesOverlap,
  findInvalidShapes, DEFAULT_CLEARANCE_MM
} from '../docs/assets/js/geometry.js';

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

console.log('# shape');
{
  const placement = {
    id: 'shape-less',
    snapshot: { widthMm: 600, depthMm: 400 },
    x: 30,
    y: 40,
    rotation: 0
  };
  const [part] = toParts(placement);
  const rect = toRect(placement);
  eq('shapeが無ければ外形矩形1枚', part,
    { id: rect.id, partIndex: 0, x: rect.x, y: rect.y, w: rect.w, d: rect.d });
}
{
  const shape = { parts: [
    { kind: 'rect', x: 0, y: 0, w: 1370, d: 460 },
    { kind: 'rect', x: 1370, y: 0, w: 400, d: 250 }
  ] };
  const expected = {
    0: [
      { id: 'l', partIndex: 0, x: 100, y: 200, w: 1370, d: 460 },
      { id: 'l', partIndex: 1, x: 1470, y: 200, w: 400, d: 250 }
    ],
    90: [
      { id: 'l', partIndex: 0, x: 100, y: 200, w: 460, d: 1370 },
      { id: 'l', partIndex: 1, x: 310, y: 1570, w: 250, d: 400 }
    ],
    180: [
      { id: 'l', partIndex: 0, x: 500, y: 200, w: 1370, d: 460 },
      { id: 'l', partIndex: 1, x: 100, y: 410, w: 400, d: 250 }
    ],
    270: [
      { id: 'l', partIndex: 0, x: 100, y: 600, w: 460, d: 1370 },
      { id: 'l', partIndex: 1, x: 100, y: 200, w: 250, d: 400 }
    ]
  };

  for (const rotation of [0, 90, 180, 270]) {
    const placement = {
      id: 'l', snapshot: { widthMm: 1770, depthMm: 460, shape }, x: 100, y: 200, rotation
    };
    const parts = toParts(placement);
    eq(`L字の${rotation}度回転`, parts, expected[rotation]);
    eq(`L字の${rotation}度回転後の外形`, boundsOf(parts), toRect(placement));
  }
}
{
  const fallback = [{ x: 0, y: 0, w: 600, d: 400 }];
  eq('空配列は外形矩形へフォールバック', normalizeShape({ parts: [] }, 600, 400), fallback);
  eq('負の幅は外形矩形へフォールバック',
    normalizeShape({ parts: [{ kind: 'rect', x: 0, y: 0, w: -1, d: 10 }] }, 600, 400), fallback);
  eq('壊れた矩形が1つでもあれば形全体をフォールバック', normalizeShape({ parts: [
    { kind: 'rect', x: 0, y: 0, w: 100, d: 100 },
    { kind: 'rect', x: 100, y: 0, w: 0, d: 100 }
  ] }, 600, 400), fallback);
  eq('未知のkindだけなら外形矩形へフォールバック',
    normalizeShape({ parts: [{ kind: 'circle', cx: 10, cy: 10, r: 10 }] }, 600, 400), fallback);
  eq('未知のkindは無視して有効な矩形を残す', normalizeShape({ parts: [
    { kind: 'circle', cx: 10, cy: 10, r: 10 },
    { kind: 'rect', x: 20, y: 30, w: 100, d: 200 }
  ] }, 600, 400), [{ x: 20, y: 30, w: 100, d: 200 }]);
}
{
  const shape = { parts: [
    { kind: 'rect', x: 0, y: 0, w: 100, d: 40 },
    { kind: 'rect', x: 0, y: 40, w: 40, d: 40 }
  ] };
  for (const rotation of [0, 90, 180, 270]) {
    const parts = toParts({
      id: 'mismatch', snapshot: { widthMm: 300, depthMm: 200, shape },
      x: 10, y: 20, rotation
    });
    const turned = rotation === 90 || rotation === 270;
    eq(`マスタ寸法がずれていても${rotation}度回転はshapeの外形を保つ`,
      boundsOf(parts), {
        id: 'mismatch', x: 10, y: 20, w: turned ? 80 : 100, d: turned ? 100 : 80
      });
  }
}

console.log('# snapPosition');
// 吸着先の隙間はクリアランス設定に従う（既定5mm）。しきい値(50)とは別物。
eq('左前の壁に吸着', snapPosition({ id: 'a', x: 3, y: 4, w: 600, d: 400 }, [], bed, 50), { x: 5, y: 5 });
eq('右奥の壁に吸着',
  snapPosition({ id: 'a', x: 1385, y: 3585, w: 600, d: 400 }, [], bed, 50),
  { x: 2000 - 600 - 5, y: 4000 - 400 - 5 });
eq('遠ければ吸着しない', snapPosition({ id: 'a', x: 800, y: 900, w: 600, d: 400 }, [], bed, 50), { x: 800, y: 900 });
// 既存機材 (10,10,600x400) の右隣にクリアランスぶん空けて付く
const neighbour = [{ id: 'a', x: 10, y: 10, w: 600, d: 400 }];
eq('隣接スナップ',
  snapPosition({ id: 'b', x: 615, y: 12, w: 600, d: 400 }, neighbour, bed, 50),
  { x: 615, y: 10 });
eq('クリアランスを変えると吸着先も変わる',
  snapPosition({ id: 'b', x: 615, y: 12, w: 600, d: 400 }, neighbour, bed, 50, 10),
  { x: 620, y: 10 });
// x は隣に1mm空けて付き、y は整列候補（クリアランスなし）で辺が揃う
eq('1mmなら隣にぴったり寄せられる',
  snapPosition({ id: 'b', x: 615, y: 12, w: 600, d: 400 }, neighbour, bed, 50, 1),
  { x: 611, y: 10 });
{
  const l = {
    id: 'l',
    parts: [
      { id: 'l', x: 0, y: 0, w: 100, d: 40 },
      { id: 'l', x: 0, y: 40, w: 40, d: 60 }
    ]
  };
  const moving = rectToShape({ id: 'm', x: 42, y: 102, w: 20, d: 20 });
  eq('L字の袖の辺に吸着', snapPosition(moving, [l], { w: 300, d: 300 }, 10), { x: 45, y: 105 });
  const besideBody = rectToShape({ id: 'm', x: 103, y: 8, w: 20, d: 20 });
  eq('L字の本体の辺に吸着', snapPosition(besideBody, [l], { w: 300, d: 300 }, 10), { x: 105, y: 5 });
}

console.log('# resolveOverlaps');
{
  // a を固定して b が重なっている状態 → b が右へ押し出される
  const rects = [
    { id: 'a', x: 100, y: 100, w: 600, d: 400 },
    { id: 'b', x: 400, y: 100, w: 600, d: 400 }
  ];
  const r = resolveOverlaps(rects, ['a'], bed);
  eq('bが押し出される', r.rects.find((x) => x.id === 'b'), { id: 'b', x: 705, y: 100, w: 600, d: 400 });
  eq('aは不動', r.rects.find((x) => x.id === 'a'), { id: 'a', x: 100, y: 100, w: 600, d: 400 });
  eq('打ち切っていない', r.truncated, false);
  eq('既定のクリアランス', r.rects[1].x - (rects[0].x + rects[0].w), DEFAULT_CLEARANCE_MM);
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
  eq('連鎖でbが移動', b.x, 705);
  eq('連鎖でcも移動', c.x, 1310);
  eq('b-c間クリアランス', c.x - (b.x + b.w), DEFAULT_CLEARANCE_MM);
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
{
  const l = {
    id: 'l',
    parts: [
      { id: 'l', x: 0, y: 0, w: 100, d: 40 },
      { id: 'l', x: 0, y: 40, w: 40, d: 60 }
    ]
  };
  const target = rectToShape({ id: 'small', x: 30, y: 50, w: 20, d: 20 });
  const r = resolveOverlaps([l, target], ['l'], { w: 300, d: 300 });
  eq('L字に押された機材は凹み側へ逃げる', boundsOf(r.shapes[1].parts),
    { id: 'small', x: 45, y: 50, w: 20, d: 20 });
}
{
  const pusher = {
    id: 'multi',
    parts: [
      { id: 'multi', x: 0, y: 0, w: 40, d: 40 },
      { id: 'multi', x: 60, y: 0, w: 60, d: 40 }
    ]
  };
  const target = rectToShape({ id: 'target', x: 30, y: 0, w: 50, d: 40 });
  const r = resolveOverlaps([pusher, target], ['multi'], { w: 300, d: 300 }, { preferredAxis: 'x' });
  eq('複数パーツの深い食い込み量で押し出す', boundsOf(r.shapes[1].parts).x, 125);
  eq('複数パーツの食い込みが残らない', shapesOverlap(r.shapes[0], r.shapes[1], 5), false);
}

console.log('# findInvalidRects');
eq('障害物と重なる',
  [...findInvalidRects([{ id: 'a', x: 0, y: 0, w: 500, d: 500 }], bed, [{ id: 'o', x: 400, y: 400, w: 200, d: 200 }])],
  ['a']);
eq('離れていれば正常',
  [...findInvalidRects([
    { id: 'a', x: 10, y: 10, w: 600, d: 400 },
    { id: 'b', x: 620, y: 10, w: 600, d: 400 }
  ], bed)],
  []);
// 重なり0（辺どうしがぴったり接する）は不可。手も吊りベルトも入らないため。
eq('接していたらエラー',
  [...findInvalidRects([
    { id: 'a', x: 10, y: 10, w: 600, d: 400 },
    { id: 'b', x: 610, y: 10, w: 600, d: 400 }
  ], bed)],
  ['a', 'b']);

// 判定の基準は設定値そのもの。設定を広げると、確保できていない機材が赤くなる。
const packed = [
  { id: 'a', x: 10, y: 10, w: 600, d: 400 },
  { id: 'b', x: 615, y: 10, w: 600, d: 400 }
];
eq('5mm設定なら5mm間隔は正常', [...findInvalidRects(packed, bed, [], 5)], []);
eq('10mm設定にすると足りない2点が赤くなる', [...findInvalidRects(packed, bed, [], 10)], ['a', 'b']);
eq('1mm設定なら余裕で正常', [...findInvalidRects(packed, bed, [], 1)], []);
// 機材置き場は 0 を渡す。実際に重なっているものだけを見る。
eq('0を渡すと重なりだけを見る', [...findInvalidRects(packed, bed, [], 0)], []);

// 壁との間にも設定値ぶんの隙間を要求する
eq('壁ぴったりは足りない', [...findInvalidRects([{ id: 'a', x: 0, y: 10, w: 600, d: 400 }], bed, [], 5)], ['a']);
eq('壁から離れていれば正常', [...findInvalidRects([{ id: 'a', x: 5, y: 10, w: 600, d: 400 }], bed, [], 5)], []);
// 荷台の幅いっぱいの機材は、両側にクリアランスを取れない。収まっていれば良しとする
// （そうしないと動かしても直せない赤が残る）。
eq('幅いっぱいの機材は収まっていれば良し',
  [...findInvalidRects([{ id: 'a', x: 0, y: 10, w: bed.w, d: 400 }], bed, [], 5)], []);
{
  const l = {
    id: 'l',
    parts: [
      { id: 'l', x: 5, y: 5, w: 100, d: 40 },
      { id: 'l', x: 5, y: 45, w: 40, d: 60 }
    ]
  };
  const inNotch = rectToShape({ id: 'small', x: 50, y: 50, w: 50, d: 50 });
  eq('L字の凹みなら外形bboxが重なっても正常',
    [...findInvalidShapes([l, inNotch], { w: 300, d: 300 }, [], 0)], []);
  const overlapsOneMm = rectToShape({ id: 'small', x: 44, y: 50, w: 50, d: 50 });
  eq('L字と1mm重なれば両方が赤い',
    [...findInvalidShapes([l, overlapsOneMm], { w: 300, d: 300 }, [], 0)], ['l', 'small']);
}

console.log('# findFreeSpot');
{
  // 11tロングの内寸に幅1160を2つ並べる。2つ目は x=1180 にしか置けない。
  // 50mm刻みの格子で探すと 1160 の次が 1210 で上限を超え、半分しか積めなかった。
  const wide = { w: 2363, d: 9090 };
  const first = findFreeSpot({ w: 1160, d: 405 }, [], wide);
  eq('1つ目は左前の隅', first, { x: DEFAULT_CLEARANCE_MM, y: DEFAULT_CLEARANCE_MM });

  const placed = [{ id: 'a', x: first.x, y: first.y, w: 1160, d: 405 }];
  eq('2つ目は隣に詰めて置ける', findFreeSpot({ w: 1160, d: 405 }, placed, wide), { x: 1170, y: 5 });
  // クリアランスを広げると、その分だけ離して置く
  eq('10mmなら10mm空けて置く', findFreeSpot({ w: 1160, d: 405 }, placed, wide, [], 10), { x: 1175, y: 10 });
}
{
  // 横に入らなければ次の列へ送る
  const narrow = { w: 1700, d: 4400 };
  const placed = [{ id: 'a', x: 10, y: 10, w: 1160, d: 405 }];
  eq('入らなければ後ろの列へ', findFreeSpot({ w: 1160, d: 405 }, placed, narrow), { x: 5, y: 420 });
}
{
  // 障害物も避ける。避けた先が荷台からはみ出すなら null。
  const tiny = { w: 1000, d: 1000 };
  const tire = { id: 'obstacle:t', x: 0, y: 0, w: 400, d: 1000 };
  eq('障害物を避ける', findFreeSpot({ w: 500, d: 500 }, [], tiny, [tire]), { x: 405, y: 5 });
  eq('避けきれなければ null', findFreeSpot({ w: 800, d: 500 }, [], tiny, [tire]), null);
}
{
  const l = {
    id: 'l',
    parts: [
      { id: 'l', x: 5, y: 5, w: 100, d: 40 },
      { id: 'l', x: 5, y: 45, w: 40, d: 60 }
    ]
  };
  const small = [{ id: 'small', x: 0, y: 0, w: 50, d: 50 }];
  eq('findFreeSpotがL字の凹みを空きとして見つける',
    findFreeSpot(small, [l], { w: 105, d: 105 }), { x: 50, y: 50 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
