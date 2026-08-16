// 機材フォーム2か所で共有する平面形状エディタ。
// 保存形は人が読める座標を保ち、判定時だけ全kindを bbox 付きへ正規化する。
// データ座標は x=幅、y=奥行のまま保ち、SVGへ描くときだけ荷台と同じ横向きへ写す。

import { boundsOf, isConvex, normalizeShape, partsOverlap } from './geometry.js';

const NORMAL_GRID_MM = 100;
const FINE_GRID_MM = 10;
const MIN_SIZE_MM = 1;
const MAX_SIZE_MM = 20000;
const MIN_CANVAS_MM = 2500;
const CANVAS_MARGIN_MM = 300;

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
        ? source.points.map((point) => ({ x: roundMm(point.x), y: roundMm(point.y) })) : [];
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
    canvasWidth: MIN_CANVAS_MM,
    canvasDepth: MIN_CANVAS_MM,

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
      return this.parts.map((part, index) => {
        const selected = this.selectedIndex === index;
        const attrs = [
          `data-part-index="${index}"`,
          `fill="${selected ? '#93c5fd' : '#cbd5e1'}"`,
          'fill-opacity="0.8"',
          `stroke="${selected ? '#1d4ed8' : '#475569'}"`,
          'stroke-width="8"'
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
            shape += part.points.map((point, vertex) => {
              const view = viewPoint(point, this.canvasWidth);
              return `<circle data-part-index="${index}" data-vertex-index="${vertex}"` +
                ` cx="${view.x}" cy="${view.y}" r="28" fill="#fff"` +
                ' stroke="#1d4ed8" stroke-width="10"/>';
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
                ` cx="${view.x}" cy="${view.y}" r="28" fill="#fff"` +
                ' stroke="#7c3aed" stroke-width="10"/>';
            }).join('');
          }
        }
        return shape;
      }).join('');
    },

    get draftMarkup() {
      if (this.draft) {
        const part = this.draft;
        if (part.kind === 'circle') {
          const center = viewPoint({ x: part.cx, y: part.cy }, this.canvasWidth);
          return `<circle cx="${center.x}" cy="${center.y}" r="${part.r}"` +
            ' fill="#bfdbfe" fill-opacity=".6" stroke="#2563eb"' +
            ' stroke-width="8" stroke-dasharray="30 20"/>';
        }
        const box = viewRect(part, this.canvasWidth);
        return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"` +
          ' fill="#bfdbfe" fill-opacity=".6" stroke="#2563eb"' +
          ' stroke-width="8" stroke-dasharray="30 20"/>';
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
          ' stroke-width="10" stroke-dasharray="30 20"/>';
      }
      return '';
    },

    openEditor() {
      this.parts = editableParts(
        this.form.shape,
        Number(this.form.width_mm),
        Number(this.form.depth_mm)
      );
      this.selectedIndex = null;
      this.cancelPolygon();
      this.error = '';
      this.open = true;
      this.refreshExtents();
    },

    closeEditor() {
      this.open = false;
      this.drag = null;
      this.draft = null;
      this.cancelPolygon();
    },

    chooseTool(tool) {
      if (this.tool === 'polygon' && tool !== 'polygon') {
        this.cancelPolygon();
      }
      this.tool = tool;
      this.error = '';
    },

    refreshExtents() {
      const bounds = this.bounds;
      this.canvasWidth = Math.min(
        MAX_SIZE_MM,
        Math.max(MIN_CANVAS_MM, bounds.x + bounds.w + CANVAS_MARGIN_MM)
      );
      this.canvasDepth = Math.min(
        MAX_SIZE_MM,
        Math.max(MIN_CANVAS_MM, bounds.y + bounds.d + CANVAS_MARGIN_MM)
      );
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
        const amounts = [0, 0, 0, 0];
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
      const [topLeft, topRight, bottomRight, bottomLeft] = this.chamfers.map((value) =>
        Math.max(0, Math.min(roundMm(value), limit))
      );
      const raw = [
        { x: part.x + topLeft, y: part.y },
        { x: part.x + part.w - topRight, y: part.y },
        { x: part.x + part.w, y: part.y + topRight },
        { x: part.x + part.w, y: part.y + part.d - bottomRight },
        { x: part.x + part.w - bottomRight, y: part.y + part.d },
        { x: part.x + bottomLeft, y: part.y + part.d },
        { x: part.x, y: part.y + part.d - bottomLeft },
        { x: part.x, y: part.y + topLeft }
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
      this.closeEditor();
    },
  };
}
