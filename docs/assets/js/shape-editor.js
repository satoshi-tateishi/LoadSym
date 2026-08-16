// 機材フォーム2か所で共有する矩形パーツ形状エディタ。
// データ座標は x=幅、y=奥行のまま保ち、SVGへ描くときだけ荷台と同じ横向きへ写す。

import { boundsOf, normalizeShape, rectsOverlap } from './geometry.js';

const NORMAL_GRID_MM = 100;
const FINE_GRID_MM = 10;
const MIN_SIZE_MM = 1;
const MAX_SIZE_MM = 20000;
const MIN_CANVAS_MM = 1000;
const CANVAS_MARGIN_MM = 300;

function cloneParts(form) {
  return normalizeShape(form.shape, Number(form.width_mm), Number(form.depth_mm))
    .map((part) => ({ kind: 'rect', ...part }));
}

function roundMm(value) {
  return Math.round(Number(value));
}

function snap(value, fine = false) {
  const grid = fine ? FINE_GRID_MM : NORMAL_GRID_MM;
  return Math.round(value / grid) * grid;
}

function viewRect(part, widthExtent) {
  return {
    x: part.y,
    y: widthExtent - part.x - part.w,
    w: part.d,
    h: part.w
  };
}

/**
 * 保存用の形を検証・正規化し、フォームの幅/奥行も外形bboxへ合わせる。
 * 通常の矩形1枚なら shape=null に戻して、従来データと同じ表現にする。
 */
export function prepareEquipmentShape(form) {
  if (!form.shape) {
    const width = roundMm(form.width_mm);
    const depth = roundMm(form.depth_mm);
    if (![width, depth].every(Number.isFinite) ||
        width < MIN_SIZE_MM || width > MAX_SIZE_MM ||
        depth < MIN_SIZE_MM || depth > MAX_SIZE_MM) {
      throw new Error('幅と奥行は1〜20000mmの整数で入力してください。');
    }
    form.width_mm = width;
    form.depth_mm = depth;
    return null;
  }
  if (!Array.isArray(form.shape.parts) || form.shape.parts.length === 0) {
    throw new Error('形状には矩形パーツを1つ以上追加してください。');
  }

  const parts = form.shape.parts.map((part) => ({
    kind: 'rect',
    x: roundMm(part.x),
    y: roundMm(part.y),
    w: roundMm(part.w),
    d: roundMm(part.d)
  }));

  if (parts.some((part) =>
    ![part.x, part.y, part.w, part.d].every(Number.isFinite) ||
    part.w < MIN_SIZE_MM || part.d < MIN_SIZE_MM ||
    part.w > MAX_SIZE_MM || part.d > MAX_SIZE_MM
  )) {
    throw new Error('各パーツの幅と奥行は1〜20000mmの整数で入力してください。');
  }

  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (rectsOverlap(parts[i], parts[j])) {
        throw new Error(`矩形パーツ ${i + 1} と ${j + 1} が重なっています。重ならない位置へ移動してください。`);
      }
    }
  }

  const bounds = boundsOf(parts);
  if (!bounds || bounds.w < MIN_SIZE_MM || bounds.d < MIN_SIZE_MM ||
      bounds.w > MAX_SIZE_MM || bounds.d > MAX_SIZE_MM) {
    throw new Error('形状全体の幅と奥行は1〜20000mmに収めてください。');
  }

  const normalized = parts.map((part) => ({
    ...part,
    x: part.x - bounds.x,
    y: part.y - bounds.y
  }));
  form.width_mm = bounds.w;
  form.depth_mm = bounds.d;

  const only = normalized[0];
  const isPlainRect = normalized.length === 1 && only.x === 0 && only.y === 0 &&
    only.w === bounds.w && only.d === bounds.d;
  form.shape = isPlainRect ? null : { parts: normalized };
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
    drag: null,
    error: '',
    canvasWidth: MIN_CANVAS_MM,
    canvasDepth: MIN_CANVAS_MM,

    init() {
      this.parts = cloneParts(this.form);
      this.refreshExtents();
    },

    get bounds() {
      return boundsOf(this.parts) ?? { x: 0, y: 0, w: 0, d: 0 };
    },

    get widthExtent() {
      return this.canvasWidth;
    },

    get depthExtent() {
      return this.canvasDepth;
    },

    get viewBox() {
      return `0 0 ${this.depthExtent} ${this.widthExtent}`;
    },

    get previewSize() {
      return `${this.bounds.w} × ${this.bounds.d} mm`;
    },

    openEditor() {
      this.parts = cloneParts(this.form);
      this.refreshExtents();
      this.selectedIndex = null;
      this.error = '';
      this.open = true;
    },

    closeEditor() {
      this.open = false;
      this.drag = null;
      this.draft = null;
    },

    rectBox(part) {
      return viewRect(part, this.widthExtent);
    },

    refreshExtents() {
      const bounds = this.bounds;
      this.canvasWidth = Math.min(MAX_SIZE_MM, Math.max(MIN_CANVAS_MM, bounds.x + bounds.w + CANVAS_MARGIN_MM));
      this.canvasDepth = Math.min(MAX_SIZE_MM, Math.max(MIN_CANVAS_MM, bounds.y + bounds.d + CANVAS_MARGIN_MM));
    },

    point(event, fine = event.shiftKey) {
      const svg = this.$refs.canvas;
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(svg.getScreenCTM().inverse());
      return {
        x: Math.max(0, Math.min(MAX_SIZE_MM, snap(this.widthExtent - local.y, fine))),
        y: Math.max(0, Math.min(MAX_SIZE_MM, snap(local.x, fine)))
      };
    },

    canvasPointerDown(event) {
      if (event.button !== 0) return;
      if (this.tool !== 'rect') {
        this.selectedIndex = null;
        return;
      }
      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      const start = this.point(event);
      this.drag = { kind: 'create', start };
      this.draft = { kind: 'rect', x: start.x, y: start.y, w: 0, d: 0 };
    },

    partPointerDown(event, index) {
      event.stopPropagation();
      if (event.button !== 0) return;
      this.selectedIndex = index;
      if (this.tool !== 'select') return;
      event.preventDefault();
      this.$refs.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'move',
        index,
        start: this.point(event),
        original: { ...this.parts[index] }
      };
    },

    pointerMove(event) {
      if (!this.drag) return;
      const current = this.point(event);
      if (this.drag.kind === 'create') {
        const start = this.drag.start;
        this.draft = {
          kind: 'rect',
          x: Math.min(start.x, current.x),
          y: Math.min(start.y, current.y),
          w: Math.abs(current.x - start.x),
          d: Math.abs(current.y - start.y)
        };
        return;
      }

      const dx = current.x - this.drag.start.x;
      const dy = current.y - this.drag.start.y;
      const original = this.drag.original;
      this.parts[this.drag.index] = {
        ...original,
        x: Math.max(0, Math.min(MAX_SIZE_MM - original.w, original.x + dx)),
        y: Math.max(0, Math.min(MAX_SIZE_MM - original.d, original.y + dy))
      };
    },

    pointerUp(event) {
      if (!this.drag) return;
      if (this.$refs.canvas.hasPointerCapture(event.pointerId)) {
        this.$refs.canvas.releasePointerCapture(event.pointerId);
      }
      if (this.drag.kind === 'create' && this.draft?.w >= MIN_SIZE_MM && this.draft?.d >= MIN_SIZE_MM) {
        this.parts.push(this.draft);
        this.selectedIndex = this.parts.length - 1;
        this.tool = 'select';
      }
      this.drag = null;
      this.draft = null;
      this.syncForm();
    },

    updatePart(index, field, value) {
      const part = this.parts[index];
      if (!part) return;
      part[field] = roundMm(value);
      this.syncForm();
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
      this.error = '';
      this.form.shape = { parts: this.parts.map((part) => ({ ...part })) };
      if (this.parts.length) {
        const bounds = boundsOf(this.parts);
        this.form.width_mm = bounds.w;
        this.form.depth_mm = bounds.d;
      }
      this.refreshExtents();
    },

    apply() {
      try {
        this.syncForm();
        prepareEquipmentShape(this.form);
        this.parts = cloneParts(this.form);
        this.closeEditor();
      } catch (error) {
        this.error = error.message;
      }
    },

    resetToRectangle() {
      this.form.shape = null;
      this.parts = cloneParts(this.form);
      this.refreshExtents();
      this.selectedIndex = null;
      this.error = '';
      this.closeEditor();
    }
  };
}
