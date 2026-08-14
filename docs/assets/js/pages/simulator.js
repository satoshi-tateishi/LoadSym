// シミュレーター画面。
//
// 状態の持ち方:
//   this.slots が唯一の真実で、描画も集計も保存もここから導出する。
//   操作のたびに history.commit() でスナップショットを積み、Undo/Redoを可能にする。
//   Alpineのプロキシ越しでも安全なよう、履歴はJSON往復で複製している。
//
// 描画はAlpineのテンプレートではなくrenderer.jsが直接SVGを書き換える。
// 数十個の矩形をAlpineの再描画に任せると、ドラッグ中の追従が重くなるため。

import { initAuthenticatedPage } from '../layout.js';
import { canEdit, canEditRecord } from '../auth.js';
import { translateError } from '../error-messages.js';
import { listEquipments, createEquipment, updateEquipment, deleteEquipment } from '../equipments.js';
import { listTrucks, createTruck, updateTruck, deleteTruck, replaceObstacles } from '../trucks.js';
import { saveLayout, loadLayout, toSlots } from '../layouts.js';
import { createHistory } from '../history.js';
import { createPlacement, movePlacement, rotatePlacement, summarize, clearances } from '../packing.js';
import { renderTruck, updatePlacementPosition, clientToBed, mmPerPixel, MARGIN_MM }
  from '../renderer.js';
import { downloadSvgAsPng } from '../export-png.js';

/** 荷台1台あたりの表示幅の上限(px)。3台並べても収まるようにする。 */
const MAX_STAGE_WIDTH = 420;
/** 荷台の表示高さの目安(px)。縦長の荷台を画面いっぱいに使うための基準。 */
const TARGET_STAGE_HEIGHT = 520;
/** スナップが効き始める画面上の距離(px)。実寸mmには描画倍率をかけて換算する。 */
const SNAP_PIXELS = 12;

export function simulator() {
  return {
    loading: true,
    saving: false,
    errorMessage: '',
    noticeMessage: '',

    session: null,
    profile: null,
    readOnly: false,

    tab: 'equipments',
    equipments: [],
    trucks: [],
    equipmentQuery: '',
    truckQuery: '',

    slots: [],
    activeSlot: 1,
    selectedId: null,

    layoutId: null,
    layoutName: '',
    layoutNote: '',
    layoutOwnerId: null,

    equipmentForm: null,
    truckForm: null,
    saveDialog: null,

    history: null,
    canUndo: false,
    canRedo: false,

    async init() {
      const context = await initAuthenticatedPage();
      if (!context) return;

      this.session = context.session;
      this.profile = context.profile;
      // Viewerは配置操作も保存もできない。閲覧専用として開く。
      this.readOnly = !canEdit(context.profile);
      this.history = createHistory([]);

      try {
        await this.reloadMasters();

        const layoutId = new URLSearchParams(window.location.search).get('layout');
        if (layoutId) await this.openLayout(layoutId);
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.loading = false;
      }
    },

    // ---------------- マスタ ----------------

    async reloadMasters() {
      const [equipments, trucks] = await Promise.all([listEquipments(), listTrucks()]);
      this.equipments = equipments;
      this.trucks = trucks;
    },

    get isAdmin() {
      return this.profile?.role === 'Admin';
    },

    get canCreate() {
      return canEdit(this.profile);
    },

    canEditItem(item) {
      return canEditRecord(this.profile, this.session, item.user_id);
    },

    /** テンプレート / 自分 / 他ユーザー の3セクションに振り分ける。 */
    sectionsFor(items, query, matcher) {
      const needle = query.trim().toLowerCase();
      const filtered = needle ? items.filter((item) => matcher(item, needle)) : items;
      const myId = this.session?.user?.id;

      return [
        { key: 'template', label: '共通テンプレート', items: filtered.filter((item) => item.user_id === null) },
        { key: 'mine', label: '自分のデータ', items: filtered.filter((item) => item.user_id === myId) },
        {
          key: 'others',
          label: '他のユーザーのデータ（閲覧のみ）',
          items: filtered.filter((item) => item.user_id !== null && item.user_id !== myId)
        }
      ];
    },

    get equipmentSections() {
      return this.sectionsFor(this.equipments, this.equipmentQuery, (item, needle) =>
        `${item.name} ${item.category}`.toLowerCase().includes(needle)
      );
    },

    get truckSections() {
      return this.sectionsFor(this.trucks, this.truckQuery, (item, needle) =>
        item.name.toLowerCase().includes(needle)
      );
    },

    // ---------------- 荷台の読み込み ----------------

    loadTruck(truck) {
      if (this.readOnly || this.slots.length >= 3) return;

      const used = new Set(this.slots.map((slot) => slot.slot));
      const slotNumber = [1, 2, 3].find((candidate) => !used.has(candidate));
      if (!slotNumber) return;

      const next = [
        ...this.rawSlots(),
        {
          slot: slotNumber,
          truckId: truck.id,
          truck: {
            name: truck.name,
            bedWidthMm: truck.bed_width_mm,
            bedDepthMm: truck.bed_depth_mm,
            bedHeightMm: truck.bed_height_mm,
            maxPayloadKg: truck.max_payload_kg === null ? null : Number(truck.max_payload_kg)
          },
          obstacles: (truck.truck_obstacles ?? []).map((obstacle) => ({
            id: obstacle.id,
            label: obstacle.label,
            x: obstacle.x_mm,
            y: obstacle.y_mm,
            w: obstacle.width_mm,
            d: obstacle.depth_mm,
            heightMm: obstacle.height_mm
          })),
          placements: []
        }
      ].sort((a, b) => a.slot - b.slot);

      this.commit(next);
      this.activeSlot = slotNumber;
    },

    removeSlot(slotNumber) {
      if (this.readOnly) return;
      this.commit(this.rawSlots().filter((slot) => slot.slot !== slotNumber));
    },

    // ---------------- 機材の配置 ----------------

    addEquipment(equipment) {
      if (this.readOnly) return;

      const slots = this.rawSlots();
      const target = slots.find((slot) => slot.slot === this.activeSlot) ?? slots[0];
      if (!target) return;

      const placement = createPlacement(equipment, target, () => crypto.randomUUID());
      target.placements = [...target.placements, placement];

      this.commit(slots);
      this.selectedId = placement.id;
    },

    // ---------------- ドラッグ ----------------

    onStagePointerDown(event, slot) {
      const group = event.target.closest('[data-placement-id]');
      if (!group) {
        this.selectedId = null;
        this.renderAll();
        return;
      }

      const placementId = group.dataset.placementId;
      this.selectedId = placementId;
      this.activeSlot = slot.slot;

      if (this.readOnly) {
        this.renderAll();
        return;
      }

      const svg = event.currentTarget;
      const slots = this.rawSlots();
      const working = slots.find((item) => item.slot === slot.slot);
      const placement = working.placements.find((item) => item.id === placementId);
      const origin = clientToBed(svg, event.clientX, event.clientY);
      const offset = { x: origin.x - placement.x, y: origin.y - placement.y };

      svg.setPointerCapture(event.pointerId);
      let moved = false;

      const onMove = (moveEvent) => {
        const point = clientToBed(svg, moveEvent.clientX, moveEvent.clientY);
        placement.x = Math.round(point.x - offset.x);
        placement.y = Math.round(point.y - offset.y);
        moved = true;
        // ドラッグ中は描画し直さず座標だけ書き換える（ポインタキャプチャを維持するため）
        updatePlacementPosition(svg, placement);
      };

      const onUp = () => {
        svg.releasePointerCapture(event.pointerId);
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerup', onUp);
        svg.removeEventListener('pointercancel', onUp);

        if (!moved) {
          this.renderAll();
          return;
        }

        const threshold = SNAP_PIXELS * mmPerPixel(svg);
        const result = movePlacement(working, placementId, { x: placement.x, y: placement.y }, threshold);
        working.placements = result.placements;
        this.warnIfTruncated(result.truncated);
        this.commit(slots);
      };

      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
    },

    // ---------------- キーボード ----------------

    onKeyDown(event) {
      if (this.equipmentForm || this.truckForm || this.saveDialog) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;

      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }

      if (this.readOnly || !this.selectedId) return;

      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        this.duplicateSelected();
        return;
      }

      const step = event.shiftKey ? 1 : 10;
      const deltas = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step }
      };

      if (deltas[event.key]) {
        event.preventDefault();
        this.nudgeSelected(deltas[event.key]);
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        this.rotateSelected();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.deleteSelected();
      }
    },

    withSelected(handler) {
      const slots = this.rawSlots();
      for (const slot of slots) {
        const placement = slot.placements.find((item) => item.id === this.selectedId);
        if (placement) {
          handler(slot, placement, slots);
          return;
        }
      }
    },

    nudgeSelected(delta) {
      this.withSelected((slot, placement, slots) => {
        // キー操作は微調整なのでスナップは効かせない（しきい値0）
        const result = movePlacement(
          slot,
          placement.id,
          { x: placement.x + delta.x, y: placement.y + delta.y },
          0
        );
        slot.placements = result.placements;
        this.warnIfTruncated(result.truncated);
        this.commit(slots);
      });
    },

    rotateSelected() {
      this.withSelected((slot, placement, slots) => {
        const result = rotatePlacement(slot, placement.id);
        slot.placements = result.placements;
        this.warnIfTruncated(result.truncated);
        this.commit(slots);
      });
    },

    deleteSelected() {
      this.withSelected((slot, placement, slots) => {
        slot.placements = slot.placements.filter((item) => item.id !== placement.id);
        this.selectedId = null;
        this.commit(slots);
      });
    },

    duplicateSelected() {
      this.withSelected((slot, placement, slots) => {
        const copy = {
          ...JSON.parse(JSON.stringify(placement)),
          id: crypto.randomUUID(),
          x: placement.x + 100,
          y: placement.y + 100
        };
        slot.placements = [...slot.placements, copy];
        this.selectedId = copy.id;
        this.commit(slots);
      });
    },

    // ---------------- 履歴 ----------------

    /** Alpineのプロキシを外した生の配列。純ロジックへ渡す前に必ず通す。 */
    rawSlots() {
      return JSON.parse(JSON.stringify(this.slots));
    },

    commit(nextSlots) {
      this.slots = this.history.commit(nextSlots);
      this.syncHistoryFlags();
      this.renderAll();
    },

    resetHistory(nextSlots) {
      this.slots = this.history.reset(nextSlots);
      this.syncHistoryFlags();
      this.renderAll();
    },

    syncHistoryFlags() {
      this.canUndo = this.history.canUndo;
      this.canRedo = this.history.canRedo;
    },

    undo() {
      this.slots = this.history.undo();
      this.syncHistoryFlags();
      this.renderAll();
    },

    redo() {
      this.slots = this.history.redo();
      this.syncHistoryFlags();
      this.renderAll();
    },

    warnIfTruncated(truncated) {
      this.noticeMessage = truncated
        ? '配置が詰まっていて押し出しを完了できませんでした。「元に戻す」で直前の状態に戻せます。'
        : '';
    },

    // ---------------- 描画 ----------------

    /**
     * Alpineのテンプレート更新後にSVGへ描画する。
     * $nextTickを挟まないと、追加直後のスロットのSVG要素がまだ存在しない。
     */
    renderAll() {
      this.$nextTick(() => {
        for (const slot of this.slots) {
          const svg = document.querySelector(`svg[data-slot="${slot.slot}"]`);
          if (!svg) continue;
          const raw = JSON.parse(JSON.stringify(slot));
          renderTruck(svg, raw, {
            invalidIds: summarize(raw).invalidIds,
            selectedId: this.selectedId
          });
        }
      });
    },

    summaryOf(slot) {
      return summarize(JSON.parse(JSON.stringify(slot)));
    },

    /**
     * 荷台の表示幅。トラックの荷台は縦長なので、幅ではなく「高さを揃える」considerationで
     * 決めたほうが画面を使い切れる。3台並べても収まるよう幅の上限で頭打ちにする。
     */
    stageWidth(slot) {
      const { w, d } = this.stageBox(slot);
      return Math.round(Math.min(MAX_STAGE_WIDTH, TARGET_STAGE_HEIGHT * (w / d)));
    },

    stageRatio(slot) {
      const { w, d } = this.stageBox(slot);
      return `${w} / ${d}`;
    },

    /** 尺規の余白を含めた描画領域の実寸。renderer.jsのviewBoxと一致させる。 */
    stageBox(slot) {
      return {
        w: slot.truck.bedWidthMm + MARGIN_MM * 2,
        d: slot.truck.bedDepthMm + MARGIN_MM * 2
      };
    },

    get selectedInfo() {
      if (!this.selectedId) return null;
      for (const slot of this.slots) {
        const placement = slot.placements.find((item) => item.id === this.selectedId);
        if (!placement) continue;
        const raw = JSON.parse(JSON.stringify(slot));
        return { name: placement.snapshot.name, ...clearances(raw, this.selectedId) };
      }
      return null;
    },

    // ---------------- 機材フォーム ----------------

    openEquipmentForm(item) {
      this.equipmentForm = item
        ? { ...item, asTemplate: item.user_id === null }
        : {
            id: null,
            name: '',
            category: 'その他',
            width_mm: 600,
            depth_mm: 400,
            height_mm: 500,
            weight_kg: 0,
            color: '#64748b',
            asTemplate: false
          };
    },

    async saveEquipment() {
      this.saving = true;
      this.errorMessage = '';
      try {
        const form = this.equipmentForm;
        const values = {
          name: form.name,
          category: form.category || 'その他',
          width_mm: form.width_mm,
          depth_mm: form.depth_mm,
          height_mm: form.height_mm,
          weight_kg: form.weight_kg ?? 0,
          color: form.color
        };

        if (form.id) {
          await updateEquipment(form.id, values);
        } else {
          await createEquipment(values, form.asTemplate ? null : this.session.user.id);
        }

        await this.reloadMasters();
        this.equipmentForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async removeEquipment() {
      if (!window.confirm('この機材を削除しますか？')) return;
      this.saving = true;
      try {
        await deleteEquipment(this.equipmentForm.id);
        await this.reloadMasters();
        this.equipmentForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    // ---------------- トラックフォーム ----------------

    openTruckForm(item) {
      this.truckForm = item
        ? {
            ...item,
            asTemplate: item.user_id === null,
            obstacles: (item.truck_obstacles ?? []).map((obstacle) => ({ ...obstacle }))
          }
        : {
            id: null,
            name: '',
            bed_width_mm: 1700,
            bed_depth_mm: 4400,
            bed_height_mm: 1900,
            max_payload_kg: '',
            asTemplate: false,
            obstacles: []
          };
    },

    addObstacleRow() {
      this.truckForm.obstacles.push({ label: '', x_mm: 0, y_mm: 0, width_mm: 300, depth_mm: 600 });
    },

    async saveTruck() {
      this.saving = true;
      this.errorMessage = '';
      try {
        const form = this.truckForm;
        const values = {
          name: form.name,
          bed_width_mm: form.bed_width_mm,
          bed_depth_mm: form.bed_depth_mm,
          bed_height_mm: form.bed_height_mm,
          max_payload_kg: form.max_payload_kg === '' || form.max_payload_kg === null
            ? null
            : Number(form.max_payload_kg)
        };

        const saved = form.id
          ? await updateTruck(form.id, values)
          : await createTruck(values, form.asTemplate ? null : this.session.user.id);

        await replaceObstacles(
          saved.id,
          form.obstacles
            .filter((obstacle) => obstacle.width_mm > 0 && obstacle.depth_mm > 0)
            .map((obstacle) => ({
              label: obstacle.label || null,
              x_mm: obstacle.x_mm ?? 0,
              y_mm: obstacle.y_mm ?? 0,
              width_mm: obstacle.width_mm,
              depth_mm: obstacle.depth_mm,
              height_mm: obstacle.height_mm ?? null
            }))
        );

        await this.reloadMasters();
        this.truckForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async removeTruck() {
      if (!window.confirm('このトラックを削除しますか？')) return;
      this.saving = true;
      try {
        await deleteTruck(this.truckForm.id);
        await this.reloadMasters();
        this.truckForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    // ---------------- レイアウトの保存・読み込み ----------------

    openSaveDialog() {
      this.saveDialog = { name: this.layoutName, note: this.layoutNote, asNew: false };
    },

    async saveLayoutNow() {
      this.saving = true;
      this.errorMessage = '';
      try {
        const dialog = this.saveDialog;
        const id = await saveLayout(
          {
            id: dialog.asNew ? undefined : this.layoutId ?? undefined,
            name: dialog.name,
            note: dialog.note,
            slots: this.rawSlots()
          },
          this.session.user.id
        );

        this.layoutId = id;
        this.layoutName = dialog.name;
        this.layoutNote = dialog.note;
        this.layoutOwnerId = this.session.user.id;
        this.saveDialog = null;
        this.noticeMessage = '保存しました。';
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async openLayout(id) {
      const row = await loadLayout(id);
      this.layoutId = row.id;
      this.layoutName = row.name;
      this.layoutNote = row.note ?? '';
      this.layoutOwnerId = row.user_id;

      // 他人のレイアウトは編集できない（RLSでも弾かれる）。読み取り専用で開く。
      if (row.user_id !== this.session.user.id) {
        this.readOnly = true;
        this.noticeMessage = '他のユーザーのレイアウトです。編集するには「別のレイアウトとして保存」してください。';
      }

      this.resetHistory(toSlots(row));
      this.activeSlot = this.slots[0]?.slot ?? 1;
    },

    // ---------------- 書き出し ----------------

    async exportPng() {
      try {
        const slot = this.slots.find((item) => item.slot === this.activeSlot) ?? this.slots[0];
        if (!slot) return;
        const svg = document.querySelector(`svg[data-slot="${slot.slot}"]`);
        if (!svg) return;

        const base = (this.layoutName || 'loadsym').replace(/[\\/:*?"<>|]/g, '_');
        await downloadSvgAsPng(svg, `${base}_${slot.truck.name}.png`);
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      }
    }
  };
}
