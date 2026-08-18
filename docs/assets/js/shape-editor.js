// 機材フォーム2か所で共有する平面形状エディタ。
// 保存形は人が読める座標を保ち、判定時だけ全kindを bbox 付きへ正規化する。
// データ座標は x=幅、y=奥行のまま保ち、SVGへ描くときだけ荷台と同じ横向きへ写す。

import { boundsOf, isConvex, normalizeShape, partsOverlap } from './geometry.js';

const NORMAL_GRID_MM = 100;
const FINE_GRID_MM = 10;
const MIN_SIZE_MM = 1;
const MAX_SIZE_MM = 20000;
const CANVAS_MARGIN_MM = 300;
// プレビューは aspect-[2/1]。x（横＝奥行）の見える範囲を段で持ち、y（縦＝幅）をその半分にすると
// viewBox が枠にぴったり収まる。段を持たせているのは、拡大縮小を刻みで扱えるようにするため。
const ZOOM_LEVELS_MM = [500, 1000, 2000, 4000, 8000, 16000, 20000];
const DEFAULT_ZOOM_INDEX = 2;   // 2000mm × 1000mm
// ズームしても画面上の大きさが変わらないよう、装飾はviewBoxの幅からの比で出す。
// 分母は 2500mm ビューで調整した値（ハンドル28mm / 番号140mm など）から逆算してある。
const DECOR_RATIO = {
  handle: 90,       // 頂点ハンドルの半径
  labelOffset: 26,  // 番号を頂点からずらす量
  labelSize: 18,    // 番号のフォントサイズ
  stroke: 250,      // ハンドルや下書きの線幅
  partStroke: 312,  // パーツの輪郭の線幅
  labelEdge: 104    // 番号の白フチ
};
const ACTIVE_INK = '#111827';
const INSERT_INK = '#0f766e';

// 画面ではCADと同じく横軸をx・縦軸をyと呼ぶ。プレビューは横が奥行・縦が幅なので、
// 保存形式（x=幅 / y=奥行）とは名前が入れ替わる。読み替えはこの3つの表だけに閉じ込め、
// 見出し行と入力行が同じ配列を回すことでラベルと中身がずれないようにする。
// 幅・奥行・半径は物理寸法の名前なので、そのまま据え置く。
const RECT_COLUMNS = [
  { label: 'x', field: 'y' },     // 横位置（奥行方向）
  { label: 'y', field: 'x' },     // 縦位置（幅方向）
  { label: '幅', field: 'w' },
  { label: '奥行', field: 'd' }
];
const CIRCLE_COLUMNS = [
  { label: 'cx', field: 'cy' },
  { label: 'cy', field: 'cx' },
  { label: '半径', field: 'r' }
];
const POINT_COLUMNS = [
  { label: 'x', field: 'y' },
  { label: 'y', field: 'x' }
];

const roundMm = (value) => Math.round(Number(value));
const snap = (value, fine = false) => Math.round(value / (fine ? FINE_GRID_MM : NORMAL_GRID_MM)) *
  (fine ? FINE_GRID_MM : NORMAL_GRID_MM);
// Alpine のリアクティブ値は Proxy のため structuredClone では複製できない。
// shape は数値・文字列・配列だけのJSONなので、保存形式と同じJSON往復で素の値へ戻す。
const clone = (value) => JSON.parse(JSON.stringify(value));

function editableParts(shape, width, depth) {
  return normalizeShape(shape, width, depth).map((part) => {
    if (part.kind === 'circle') {
      return { kind: 'circle', cx: part.x + part.w / 2, cy: part.y + part.d / 2, r: part.w / 2 };
    }
    if (part.kind === 'polygon') {
      return { kind: 'polygon', points: clone(part.points) };
    }
    return { kind: 'rect', x: part.x, y: part.y, w: part.w, d: part.d };
  });
}

function normalizedPart(part) {
  const normalized = normalizeShape({ parts: [part] }, 0, 0)[0];
  return normalized.w > 0 && normalized.d > 0 ? normalized : null;
}

function normalizedParts(parts) {
  return parts.map(normalizedPart).filter(Boolean);
}

function viewPoint(point, widthExtent) {
  return { x: point.y, y: widthExtent - point.x };
}

function viewRect(part, widthExtent) {
  return { x: part.y, y: widthExtent - part.x - part.w, w: part.d, h: part.w };
}

/** 保存用の形を検証し、全kindを外形bboxの左前原点へ揃える。 */
export function prepareEquipmentShape(form) {
  if (!form.shape) {
    const width = roundMm(form.width_mm);
    const depth = roundMm(form.depth_mm);
    if (![width, depth].every(Number.isFinite) || width < 1 || width > MAX_SIZE_MM ||
        depth < 1 || depth > MAX_SIZE_MM) {
      throw new Error('幅と奥行は1〜20000mmの整数で入力してください。');
    }
    form.width_mm = width;
    form.depth_mm = depth;
    return null;
  }
  if (!Array.isArray(form.shape.parts) || form.shape.parts.length === 0) {
    throw new Error('形状にはパーツを1つ以上追加してください。');
  }

  const saved = form.shape.parts.map((source) => {
    if (source?.kind === 'rect') {
      const part = {
        kind: 'rect',
        x: roundMm(source.x),
        y: roundMm(source.y),
        w: roundMm(source.w),
        d: roundMm(source.d)
      };
      if (![part.x, part.y, part.w, part.d].every(Number.isFinite) || part.w < 1 || part.d < 1 ||
          part.w > MAX_SIZE_MM || part.d > MAX_SIZE_MM) {
        throw new Error('矩形パーツの幅と奥行は1〜20000mmの整数で入力してください。');
      }
      return part;
    }
    if (source?.kind === 'circle') {
      const part = {
        kind: 'circle',
        cx: roundMm(source.cx),
        cy: roundMm(source.cy),
        r: roundMm(source.r)
      };
      if (![part.cx, part.cy, part.r].every(Number.isFinite) || part.r < 1 || part.r * 2 > MAX_SIZE_MM) {
        throw new Error('円パーツの半径は1〜10000mmの整数で入力してください。');
      }
      return part;
    }
    if (source?.kind === 'polygon') {
      const points = Array.isArray(source.points)
        // 斜辺へ追加した厳密な中点は0.5mmになる場合がある。整数へ丸めると辺から外れて
        // 凸判定を壊すため、多角形の頂点だけは有限な実数をそのまま保持する。
        ? source.points.map((point) => ({ x: Number(point.x), y: Number(point.y) })) : [];
      if (points.length < 3 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
        throw new Error('多角形パーツには3点以上の頂点を指定してください。');
      }
      if (!isConvex(points)) {
        throw new Error('多角形は凸形状にしてください。凹んだ形は矩形パーツを組み合わせて作れます。');
      }
      return { kind: 'polygon', points };
    }
    throw new Error('未対応の種類のパーツが含まれています。');
  });

  const parts = normalizedParts(saved);
  if (parts.length !== saved.length) throw new Error('パーツの寸法を確認してください。');
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (partsOverlap(parts[i], parts[j], 0)) {
        throw new Error(`パーツ ${i + 1} と ${j + 1} が重なっています。重ならない位置へ移動してください。`);
      }
    }
  }
  const bounds = boundsOf(parts);
  if (!bounds || bounds.w < 1 || bounds.d < 1 || bounds.w > MAX_SIZE_MM || bounds.d > MAX_SIZE_MM) {
    throw new Error('形状全体の幅と奥行は1〜20000mmに収めてください。');
  }

  const normalized = saved.map((part) => {
    if (part.kind === 'circle') {
      return { ...part, cx: part.cx - bounds.x, cy: part.cy - bounds.y };
    }
    if (part.kind === 'polygon') {
      return {
        ...part,
        points: part.points.map((point) => ({
          x: point.x - bounds.x,
          y: point.y - bounds.y
        }))
      };
    }
    return { ...part, x: part.x - bounds.x, y: part.y - bounds.y };
  });
  form.width_mm = bounds.w;
  form.depth_mm = bounds.d;

  // 通常の矩形1枚なら shape=null に戻して、従来データと同じ表現にする。
  const only = normalized[0];
  form.shape = normalized.length === 1 && only.kind === 'rect' && only.x === 0 && only.y === 0 &&
    only.w === bounds.w && only.d === bounds.d ? null : { parts: normalized };
  return form.shape;
}

export function shapeEditor(form) {
  return {
    form,
    open: false,
    tool: 'select',
    /** 「閉じる」で戻す、エディタを開いた時点のフォーム値。 */
    formSnapshot: null,
    parts: [],
    selectedIndex: null,
    draft: null,
    polygonDraft: [],
    hoverPoint: null,
    drag: null,
    error: '',
    // 角落としを独立したkindにせず、4隅の編集状態から凸多角形へ置き換える。
    // 保存形式のkindを増やさず、判定と描画を既存のpolygon経路に揃えるため。
    chamfers: [0, 0, 0, 0],
    canvasWidth: ZOOM_LEVELS_MM[DEFAULT_ZOOM_INDEX] / 2,
    canvasDepth: ZOOM_LEVELS_MM[DEFAULT_ZOOM_INDEX],
    // ユーザーが選んだズーム段。canvasWidth/Depth とは別に持つ。編集のたびに走る
    // refreshExtents() で毎回上書きされると、選んだ倍率が巻き戻ってしまうため。
    zoomIndex: DEFAULT_ZOOM_INDEX,
    // 入力欄にフォーカス中の頂点 { part, vertex }。プレビュー側で黒く塗って対応を示す。
    activeVertex: null,
    rectColumns: RECT_COLUMNS,
    circleColumns: CIRCLE_COLUMNS,
    pointColumns: POINT_COLUMNS,

    init() {
      this.parts = editableParts(
        this.form.shape,
        Number(this.form.width_mm),
        Number(this.form.depth_mm)
      );
      this.refreshExtents();
    },

    get normalized() {
      return normalizedParts(this.parts);
    },

    get bounds() {
      return boundsOf(this.normalized) ?? { x: 0, y: 0, w: 0, d: 0 };
    },

    get selectedPart() {
      return this.selectedIndex === null ? null : this.parts[this.selectedIndex];
    },

    get canChamfer() {
      return this.selectedPart?.kind === 'rect';
    },

    get viewBox() {
      return `0 0 ${this.canvasDepth} ${this.canvasWidth}`;
    },

    /**
     * ハンドル・番号・線幅のmm寸法。viewBoxの幅に比例させることで、
     * どの倍率でも画面上ではほぼ同じ大きさに見せる。
     */
    get decor() {
      const base = this.canvasDepth;
      return {
        handle: base / DECOR_RATIO.handle,
        labelOffset: base / DECOR_RATIO.labelOffset,
        labelSize: base / DECOR_RATIO.labelSize,
        stroke: base / DECOR_RATIO.stroke,
        partStroke: base / DECOR_RATIO.partStroke,
        labelEdge: base / DECOR_RATIO.labelEdge
      };
    },

    /** 見た目のグリッド刻み。吸着は従来どおり100mm（Shiftで10mm）で変えない。 */
    get gridStepMm() {
      const level = ZOOM_LEVELS_MM[this.zoomIndex];
      return level <= 2000 ? NORMAL_GRID_MM : level <= 8000 ? 500 : 1000;
    },

    get gridPath() {
      const step = this.gridStepMm;
      return `M ${step} 0 L 0 0 0 ${step}`;
    },

    /** いまの形が収まる最小の段。＋の可否と refreshExtents で共用する。 */
    get fitZoomIndex() {
      const bounds = this.bounds;
      const needX = bounds.y + bounds.d + CANVAS_MARGIN_MM;
      const needY = bounds.x + bounds.w + CANVAS_MARGIN_MM;
      const index = ZOOM_LEVELS_MM.findIndex((mm) => mm >= needX && mm / 2 >= needY);
      return index === -1 ? ZOOM_LEVELS_MM.length - 1 : index;
    },

    // 形がはみ出す拡大はさせない。見えていない頂点は掴めず、パンの仕組みも無いため。
    get canZoomIn() {
      return this.zoomIndex > this.fitZoomIndex;
    },

    get canZoomOut() {
      return this.zoomIndex < ZOOM_LEVELS_MM.length - 1;
    },

    get zoomLabel() {
      return `${ZOOM_LEVELS_MM[this.zoomIndex]}mm`;
    },

    zoomIn() {
      if (!this.canZoomIn) return;
      this.zoomIndex -= 1;
      this.refreshExtents();
    },

    zoomOut() {
      if (!this.canZoomOut) return;
      this.zoomIndex += 1;
      this.refreshExtents();
    },

    get previewSize() {
      return `${this.bounds.w} × ${this.bounds.d} mm`;
    },

    partBounds(part) {
      return normalizedPart(part) ?? { w: 0, d: 0 };
    },

    /**
     * SVG内のtemplate要素はHTMLTemplateElementにならずAlpineのx-forで扱えないため、
     * renderer.jsと同様にSVGマークアップを文字列で組み立てる。
     */
    get partsMarkup() {
      const decor = this.decor;
      return this.parts.map((part, index) => {
        const selected = this.selectedIndex === index;
        const attrs = [
          `data-part-index="${index}"`,
          `fill="${selected ? '#93c5fd' : '#cbd5e1'}"`,
          'fill-opacity="0.8"',
          `stroke="${selected ? '#1d4ed8' : '#475569'}"`,
          `stroke-width="${decor.partStroke}"`
        ].join(' ');
        let shape = '';

        if (part.kind === 'circle') {
          const center = viewPoint({ x: part.cx, y: part.cy }, this.canvasWidth);
          shape = `<circle ${attrs} cx="${center.x}" cy="${center.y}" r="${part.r}"/>`;
        } else if (part.kind === 'polygon') {
          const points = part.points.map((point) => {
            const view = viewPoint(point, this.canvasWidth);
            return `${view.x},${view.y}`;
          }).join(' ');
          shape = `<polygon ${attrs} points="${points}"/>`;
          if (selected) {
            // 辺の中点の「＋」を先に描く。頂点ハンドルと重なったときは、後から描く
            // 頂点ハンドルのほうが上に来て、掴む操作を邪魔しない。
            shape += part.points.map((point, edge) => {
              const next = part.points[(edge + 1) % part.points.length];
              const view = viewPoint({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 }, this.canvasWidth);
              const arm = decor.handle * 0.55;
              return `<g data-part-index="${index}" data-insert-index="${edge}" style="cursor:copy">` +
                `<circle cx="${view.x}" cy="${view.y}" r="${decor.handle * 0.85}"` +
                ` fill="#fff" fill-opacity="0.9" stroke="${INSERT_INK}" stroke-width="${decor.stroke}"/>` +
                `<path d="M ${view.x - arm} ${view.y} H ${view.x + arm} M ${view.x} ${view.y - arm} V ${view.y + arm}"` +
                ` stroke="${INSERT_INK}" stroke-width="${decor.stroke}" stroke-linecap="round" pointer-events="none"/>` +
                '</g>';
            }).join('');
            shape += part.points.map((point, vertex) => {
              const view = viewPoint(point, this.canvasWidth);
              // 入力欄の行と見比べられるよう、頂点には番号を添え、編集中の1点だけ黒く塗る。
              const active = this.activeVertex?.part === index && this.activeVertex?.vertex === vertex;
              const handle = `<circle data-part-index="${index}" data-vertex-index="${vertex}"` +
                ` cx="${view.x}" cy="${view.y}" r="${decor.handle}"` +
                ` fill="${active ? ACTIVE_INK : '#fff'}"` +
                ` stroke="${active ? ACTIVE_INK : '#1d4ed8'}" stroke-width="${decor.stroke}"/>`;
              // 番号はドラッグの当たり判定を奪わないよう pointer-events を切る。
              // 形の塗りに埋もれないよう白フチ（paint-order）を付ける。
              const label = `<text x="${view.x + decor.labelOffset}" y="${view.y - decor.labelOffset}"` +
                ` font-size="${decor.labelSize}" font-weight="${active ? '700' : '500'}"` +
                ` fill="${active ? ACTIVE_INK : '#1d4ed8'}" paint-order="stroke"` +
                ` stroke="#fff" stroke-width="${decor.labelEdge}" stroke-linejoin="round"` +
                ` text-anchor="middle" dominant-baseline="middle" pointer-events="none">${vertex + 1}</text>`;
              return handle + label;
            }).join('');
          }
        } else {
          const box = viewRect(part, this.canvasWidth);
          shape = `<rect ${attrs} x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`;
          if (selected) {
            const corners = [
              { x: part.x, y: part.y },
              { x: part.x + part.w, y: part.y },
              { x: part.x + part.w, y: part.y + part.d },
              { x: part.x, y: part.y + part.d }
            ];
            shape += corners.map((point, corner) => {
              const view = viewPoint(point, this.canvasWidth);
              return `<circle data-part-index="${index}" data-chamfer-corner="${corner}"` +
                ` cx="${view.x}" cy="${view.y}" r="${decor.handle}" fill="#fff"` +
                ` stroke="#7c3aed" stroke-width="${decor.stroke}"/>`;
            }).join('');
          }
        }
        return shape;
      }).join('');
    },

    get draftMarkup() {
      const decor = this.decor;
      // 破線の刻みもズームで変わらないよう、線幅と同じ比で出す。
      const dash = `stroke-dasharray="${decor.stroke * 3} ${decor.stroke * 2}"`;
      if (this.draft) {
        const part = this.draft;
        if (part.kind === 'circle') {
          const center = viewPoint({ x: part.cx, y: part.cy }, this.canvasWidth);
          return `<circle cx="${center.x}" cy="${center.y}" r="${part.r}"` +
            ' fill="#bfdbfe" fill-opacity=".6" stroke="#2563eb"' +
            ` stroke-width="${decor.partStroke}" ${dash}/>`;
        }
        const box = viewRect(part, this.canvasWidth);
        return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"` +
          ' fill="#bfdbfe" fill-opacity=".6" stroke="#2563eb"' +
          ` stroke-width="${decor.partStroke}" ${dash}/>`;
      }

      if (this.polygonDraft.length) {
        const draftPoints = [
          ...this.polygonDraft,
          ...(this.hoverPoint ? [this.hoverPoint] : [])
        ];
        const points = draftPoints.map((point) => {
          const view = viewPoint(point, this.canvasWidth);
          return `${view.x},${view.y}`;
        }).join(' ');
        return `<polyline points="${points}" fill="none" stroke="#2563eb"` +
          ` stroke-width="${decor.stroke}" ${dash}/>`;
      }
      return '';
    },

    openEditor() {
      this.formSnapshot = {
        shape: this.form.shape === null ? null : clone(this.form.shape),
        width_mm: this.form.width_mm,
        depth_mm: this.form.depth_mm
      };
      this.parts = editableParts(
        this.form.shape,
        Number(this.form.width_mm),
        Number(this.form.depth_mm)
      );
      this.selectedIndex = null;
      this.activeVertex = null;
      this.tool = 'select';
      // 前の機材のズームは持ち越さない。開いた直後は常に既定の 2000×1000 から始める。
      this.zoomIndex = DEFAULT_ZOOM_INDEX;
      this.cancelPolygon();
      this.error = '';
      this.open = true;
      this.refreshExtents();
    },

    closeEditor() {
      if (this.formSnapshot) {
        this.form.shape = this.formSnapshot.shape === null
          ? null
          : clone(this.formSnapshot.shape);
        this.form.width_mm = this.formSnapshot.width_mm;
        this.form.depth_mm = this.formSnapshot.depth_mm;
      }
      this.open = false;
      this.tool = 'select';
      this.drag = null;
      this.draft = null;
      this.activeVertex = null;
      this.cancelPolygon();
      this.formSnapshot = null;
    },

    chooseTool(tool) {
      if (this.tool === 'polygon' && tool !== 'polygon') {
        this.cancelPolygon();
      }
      this.tool = tool;
      this.error = '';
    },

    /**
     * viewBoxの範囲を決める。ユーザーが選んだ段を尊重しつつ、形がそこに収まらないときだけ広げる。
     * canvasWidth は y反転の原点（viewPoint / point）も兼ねるので、viewBoxの高さと必ず一致させる。
     */
    refreshExtents() {
      const bounds = this.bounds;
      this.zoomIndex = Math.max(this.zoomIndex, this.fitZoomIndex);
      const level = ZOOM_LEVELS_MM[this.zoomIndex];
      // 最大段でも入らない極端な形は、はみ出させずに letterbox で受ける。
      this.canvasDepth = Math.max(level, bounds.y + bounds.d + CANVAS_MARGIN_MM);
      this.canvasWidth = Math.max(level / 2, bounds.x + bounds.w + CANVAS_MARGIN_MM);
    },

    point(event, fine = event.shiftKey) {
      const svg = this.$refs.canvas;
      const svgPoint = svg.createSVGPoint();
      svgPoint.x = event.clientX;
      svgPoint.y = event.clientY;
      const local = svgPoint.matrixTransform(svg.getScreenCTM().inverse());
      return {
        x: Math.max(0, Math.min(MAX_SIZE_MM, snap(this.canvasWidth - local.y, fine))),
        y: Math.max(0, Math.min(MAX_SIZE_MM, snap(local.x, fine)))
      };
    },

    canvasPointerDown(event) {
      if (event.button !== 0) return;

      // 辺の中点の「＋」。押した時点で頂点を確定させるので、ドラッグ系より先に見る。
      const insert = event.target.closest?.('[data-insert-index]');
      if (insert) {
        event.preventDefault();
        this.insertVertex(Number(insert.dataset.partIndex), Number(insert.dataset.insertIndex));
        return;
      }

      const vertex = event.target.closest?.('[data-vertex-index]');
      if (vertex) {
        this.vertexPointerDown(
          event,
          Number(vertex.dataset.partIndex),
          Number(vertex.dataset.vertexIndex)
        );
        return;
      }

      const corner = event.target.closest?.('[data-chamfer-corner]');
      if (corner) {
        this.chamferPointerDown(
          event,
          Number(corner.dataset.partIndex),
          Number(corner.dataset.chamferCorner)
        );
        return;
      }

      const hit = event.target.closest?.('[data-part-index]');
      if (hit) {
        this.partPointerDown(event, Number(hit.dataset.partIndex));
        return;
      }
      if (this.tool === 'polygon') {
        this.addPolygonPoint(event);
        return;
      }
      if (!['rect', 'circle'].includes(this.tool)) {
        this.selectedIndex = null;
        return;
      }

      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      const start = this.point(event);
      this.drag = { kind: 'create', shapeKind: this.tool, start };
      this.draft = this.tool === 'circle'
        ? { kind: 'circle', cx: start.x, cy: start.y, r: 0 }
        : { kind: 'rect', x: start.x, y: start.y, w: 0, d: 0 };
    },

    partPointerDown(event, index) {
      this.selectedIndex = index;
      this.chamfers = [0, 0, 0, 0];
      if (this.tool !== 'select') return;

      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'move',
        index,
        start: this.point(event),
        original: clone(this.parts[index])
      };
    },

    vertexPointerDown(event, index, vertex) {
      if (this.tool !== 'select') return;
      this.selectedIndex = index;
      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'vertex',
        index,
        vertex,
        original: clone(this.parts[index])
      };
    },

    chamferPointerDown(event, index, corner) {
      if (this.tool !== 'select') return;
      this.selectedIndex = index;
      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'chamfer',
        index,
        corner,
        original: clone(this.parts[index])
      };
    },

    pointerMove(event) {
      if (!this.drag) {
        if (this.tool === 'polygon' && this.polygonDraft.length) {
          this.hoverPoint = this.point(event);
        }
        return;
      }

      const current = this.point(event);
      const drag = this.drag;
      if (drag.kind === 'create') {
        const dx = current.x - drag.start.x;
        const dy = current.y - drag.start.y;
        if (drag.shapeKind === 'circle') {
          // 長いほうを使うとポインタを越えて円が広がるため、ドラッグ枠に収まる短辺を直径にする。
          const diameter = Math.min(Math.abs(dx), Math.abs(dy));
          this.draft = {
            kind: 'circle',
            cx: drag.start.x + Math.sign(dx || 1) * diameter / 2,
            cy: drag.start.y + Math.sign(dy || 1) * diameter / 2,
            r: diameter / 2
          };
        } else {
          this.draft = {
            kind: 'rect',
            x: Math.min(drag.start.x, current.x),
            y: Math.min(drag.start.y, current.y),
            w: Math.abs(dx),
            d: Math.abs(dy)
          };
        }
        return;
      }

      if (drag.kind === 'vertex') {
        const candidate = clone(drag.original);
        candidate.points[drag.vertex] = current;
        // 凹形を保存形式として許さないため、編集中も凸を崩す操作は元の形を保って弾く。
        if (isConvex(candidate.points)) {
          this.parts[drag.index] = candidate;
          this.error = '';
        } else {
          this.error = '凸形状を保てない位置へ頂点を移動できません。';
        }
        return;
      }

      if (drag.kind === 'chamfer') {
        const part = drag.original;
        // 入力済みの他3隅は保持し、ドラッグ中の隅だけを更新する。
        const amounts = [...this.chamfers];
        amounts[drag.corner] = Math.max(
          0,
          Math.min(
            Math.floor(Math.min(part.w, part.d) / 2),
            this.cornerInset(part, drag.corner, current)
          )
        );
        this.chamfers = amounts;
        return;
      }

      const dx = current.x - drag.start.x;
      const dy = current.y - drag.start.y;
      const original = drag.original;
      if (original.kind === 'circle') {
        this.parts[drag.index] = {
          ...original,
          cx: original.cx + dx,
          cy: original.cy + dy
        };
      } else if (original.kind === 'polygon') {
        this.parts[drag.index] = {
          ...original,
          points: original.points.map((point) => ({
            x: point.x + dx,
            y: point.y + dy
          }))
        };
      } else {
        this.parts[drag.index] = {
          ...original,
          x: original.x + dx,
          y: original.y + dy
        };
      }
    },

    pointerUp(event) {
      if (!this.drag) return;

      if (this.$refs.canvas.hasPointerCapture(event.pointerId)) {
        this.$refs.canvas.releasePointerCapture(event.pointerId);
      }
      if (this.drag.kind === 'create' && this.draft) {
        const valid = this.draft.kind === 'circle'
          ? this.draft.r >= MIN_SIZE_MM
          : this.draft.w >= MIN_SIZE_MM && this.draft.d >= MIN_SIZE_MM;
        if (valid) {
          this.parts.push(this.draft);
          this.selectedIndex = this.parts.length - 1;
          this.tool = 'select';
        }
      }
      if (this.drag.kind === 'chamfer' && this.chamfers.some((value) => value > 0)) {
        this.applyChamfer();
      }
      this.drag = null;
      this.draft = null;
      this.syncForm();
    },

    cornerInset(part, corner, point) {
      const values = [
        Math.max(point.x - part.x, point.y - part.y),
        Math.max(part.x + part.w - point.x, point.y - part.y),
        Math.max(part.x + part.w - point.x, part.y + part.d - point.y),
        Math.max(point.x - part.x, part.y + part.d - point.y)
      ];
      return values[corner];
    },

    applyChamfer() {
      const part = this.selectedPart;
      if (part?.kind !== 'rect') return;
      if (!this.chamfers.some((value) => Number(value) > 0)) {
        this.error = '角落とし量を入力してください。';
        return;
      }

      const limit = Math.floor(Math.min(part.w, part.d) / 2);
      // 隅の名前は画面の見た目に合わせる。データの (x,y) は viewPoint() で90度回るため、
      // データ上の (x, y) 最小の隅はプレビューでは「左下」に出る。添字の意味は変えていない。
      const [bottomLeft, topLeft, topRight, bottomRight] = this.chamfers.map((value) =>
        Math.max(0, Math.min(roundMm(value), limit))
      );
      const raw = [
        { x: part.x + bottomLeft, y: part.y },
        { x: part.x + part.w - topLeft, y: part.y },
        { x: part.x + part.w, y: part.y + topLeft },
        { x: part.x + part.w, y: part.y + part.d - topRight },
        { x: part.x + part.w - topRight, y: part.y + part.d },
        { x: part.x + bottomRight, y: part.y + part.d },
        { x: part.x, y: part.y + part.d - bottomRight },
        { x: part.x, y: part.y + bottomLeft }
      ];
      const points = raw.filter((point, index) =>
        index === 0 || point.x !== raw[index - 1].x || point.y !== raw[index - 1].y
      );
      const first = points[0];
      const last = points.at(-1);
      if (points.length > 1 && first.x === last.x && first.y === last.y) {
        points.pop();
      }

      this.parts[this.selectedIndex] = { kind: 'polygon', points };
      this.chamfers = [0, 0, 0, 0];
      this.syncForm();
    },

    addPolygonPoint(event) {
      event.preventDefault();
      const point = this.point(event);
      const first = this.polygonDraft[0];
      if (this.polygonDraft.length >= 3 && point.x === first.x && point.y === first.y) {
        this.finishPolygon();
        return;
      }

      const last = this.polygonDraft.at(-1);
      if (last?.x === point.x && last?.y === point.y) return;
      this.polygonDraft.push(point);
      this.hoverPoint = point;
    },

    finishPolygon() {
      if (this.polygonDraft.length < 3) {
        this.error = '多角形を閉じるには3点以上必要です。';
        return;
      }
      if (!isConvex(this.polygonDraft)) {
        this.error = '多角形は凸形状にしてください。凹んだ形は矩形パーツを組み合わせて作れます。';
        return;
      }

      this.parts.push({ kind: 'polygon', points: clone(this.polygonDraft) });
      this.selectedIndex = this.parts.length - 1;
      this.cancelPolygon();
      this.tool = 'select';
      this.syncForm();
    },

    cancelPolygon() {
      this.polygonDraft = [];
      this.hoverPoint = null;
    },

    editorKey(event) {
      if (!this.open) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;

      if (this.tool === 'polygon' && event.key === 'Enter') {
        event.preventDefault();
        this.finishPolygon();
      } else if (this.tool === 'polygon' && event.key === 'Escape') {
        event.preventDefault();
        this.cancelPolygon();
      } else {
        this.deleteByKey(event);
      }
    },

    updatePart(index, field, value) {
      const part = this.parts[index];
      if (!part) return;
      part[field] = roundMm(value);
      this.syncForm();
    },

    /** 入力欄とプレビューの頂点を対応づける。Tab移動でも効くよう、ここで選択も移す。 */
    focusVertex(index, vertex) {
      this.selectedIndex = index;
      this.activeVertex = { part: index, vertex };
    },

    blurVertex() {
      this.activeVertex = null;
    },

    /**
     * 辺の中点に頂点を1つ足す。中点は両隣と共線だが、isConvex は共線を読み飛ばすので通る。
     * 同座標の点だけは isConvex が弾くので、潰れた辺の中点はここで落ちる。
     */
    insertVertex(index, edge) {
      const part = this.parts[index];
      if (part?.kind !== 'polygon') return;

      const a = part.points[edge];
      const b = part.points[(edge + 1) % part.points.length];
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const rounded = { x: roundMm(midpoint.x), y: roundMm(midpoint.y) };
      // 丸め後も外積が0なら扱いやすい整数座標を使い、斜辺から外れるときだけ正確な中点を使う。
      const insertion = (rounded.x - a.x) * (b.y - a.y) ===
        (rounded.y - a.y) * (b.x - a.x) ? rounded : midpoint;
      const candidate = clone(part);
      candidate.points.splice(edge + 1, 0, insertion);
      if (!isConvex(candidate.points)) {
        this.error = 'この辺は短すぎて頂点を追加できません。';
        return;
      }

      this.parts[index] = candidate;
      this.selectedIndex = index;
      // 追加した点をそのまま黒く示し、どれが増えたのか分かるようにする。
      this.activeVertex = { part: index, vertex: edge + 1 };
      this.error = '';
      this.syncForm();
    },

    /** 頂点を1つ減らす。3点未満の多角形は保存できないのでUI側で先に止める。 */
    removeVertex(index, vertex) {
      const part = this.parts[index];
      if (part?.kind !== 'polygon') return;
      if (part.points.length <= 3) {
        this.error = '多角形の頂点は3点以上必要です。';
        return;
      }

      const candidate = clone(part);
      candidate.points.splice(vertex, 1);
      if (!isConvex(candidate.points)) {
        this.error = '凸形状を保てないため、この頂点は削除できません。';
        return;
      }

      this.parts[index] = candidate;
      this.activeVertex = null;
      this.error = '';
      this.syncForm();
    },

    /**
     * 選択中のパーツだけを90度回す。軸はそのパーツの外形中心なので、回してもその場に留まる。
     * 向きは geometry.js の toParts() と同じ（局所座標で {x: d0 - y, y: x}）にして、
     * 荷台上で機材を回したときと食い違わないようにする。
     * 回転で他のパーツと重なっても止めない。重なりの検査は「形を反映」でまとめて行う。
     */
    rotatePart(index = this.selectedIndex) {
      const part = index === null ? null : this.parts[index];
      const box = part ? normalizedPart(part) : null;
      if (!box || part.kind === 'circle') return;

      const cx = box.x + box.w / 2;
      const cy = box.y + box.d / 2;
      const map = (point) => ({
        x: roundMm(cx + box.d / 2 - (point.y - box.y)),
        y: roundMm(cy - box.w / 2 + (point.x - box.x))
      });

      this.parts[index] = part.kind === 'polygon'
        ? { kind: 'polygon', points: part.points.map(map) }
        // 矩形は外形そのものなので、幅と奥行を入れ替えて中心を合わせ直すだけでよい。
        : { kind: 'rect', x: roundMm(cx - box.d / 2), y: roundMm(cy - box.w / 2), w: box.d, d: box.w };
      this.chamfers = [0, 0, 0, 0];
      this.error = '';
      this.syncForm();
    },

    updatePoint(index, vertex, field, value) {
      const part = this.parts[index];
      if (part?.kind !== 'polygon') return;

      const candidate = clone(part);
      candidate.points[vertex][field] = roundMm(value);
      // 数値入力でもドラッグと同じく、保存できない凹形へ途中で崩れる操作を弾く。
      if (isConvex(candidate.points)) {
        this.parts[index] = candidate;
        this.error = '';
        this.syncForm();
      } else {
        this.error = '多角形は凸形状を保つ必要があります。';
      }
    },

    removePart(index = this.selectedIndex) {
      if (index === null || !this.parts[index]) return;
      this.parts.splice(index, 1);
      this.selectedIndex = null;
      // 削除で添字がずれるので、消えた頂点を指したまま黒く塗り続けないようにする。
      this.activeVertex = null;
      this.syncForm();
    },

    deleteByKey(event) {
      if (!this.open || !['Delete', 'Backspace'].includes(event.key)) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      event.preventDefault();
      this.removePart();
    },

    syncForm() {
      this.form.shape = { parts: clone(this.parts) };
      if (this.parts.length) {
        const bounds = this.bounds;
        this.form.width_mm = bounds.w;
        this.form.depth_mm = bounds.d;
      }
      this.refreshExtents();
    },

    apply() {
      try {
        this.syncForm();
        prepareEquipmentShape(this.form);
        this.parts = editableParts(
          this.form.shape,
          Number(this.form.width_mm),
          Number(this.form.depth_mm)
        );
        // closeEditor() はキャンセル扱いでスナップショットへ戻すため、確定値で更新してから閉じる。
        this.formSnapshot = {
          shape: this.form.shape === null ? null : clone(this.form.shape),
          width_mm: this.form.width_mm,
          depth_mm: this.form.depth_mm
        };
        this.closeEditor();
      } catch (error) {
        this.error = error.message;
      }
    },

    resetToRectangle() {
      this.form.shape = null;
      this.parts = editableParts(
        null,
        Number(this.form.width_mm),
        Number(this.form.depth_mm)
      );
      this.selectedIndex = null;
      this.error = '';
      // 「矩形に戻す」は即時確定する操作なので、閉じる前に復元先も更新する。
      this.formSnapshot = {
        shape: null,
        width_mm: this.form.width_mm,
        depth_mm: this.form.depth_mm
      };
      this.closeEditor();
    },
  };
}
