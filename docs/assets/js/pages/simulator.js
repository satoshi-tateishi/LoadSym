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
import { listCategories } from '../categories.js';
import { PALETTE, PALETTE_SHADES } from '../palette.js';
import { listTrucks, createTruck, updateTruck, deleteTruck, replaceObstacles } from '../trucks.js';
import { saveLayout, loadLayout, toSlots } from '../layouts.js';
import { createHistory } from '../history.js';
import {
  createPlacement, movePlacement, movePlacementToSlot, rotatePlacement, summarize, clearances,
  createStagingSlot, isStaging, STAGING_SLOT
} from '../packing.js';
import { renderTruck, updatePlacementPosition, clientToBed, mmPerPixel, MARGIN_MM, viewSize }
  from '../renderer.js';
import { downloadSvgAsPng } from '../export-png.js';

/**
 * 荷台の表示高さの目安(px)。荷台は横向きに描くので、高さを揃えて横に伸ばす。
 * トラックを3台積み上げても1画面で見渡せる程度に抑えてある。
 */
const TARGET_STAGE_HEIGHT = 330;
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
    categories: [],
    equipmentQuery: '',
    /** 空文字なら全カテゴリ。 */
    categoryFilter: '',
    truckQuery: '',

    slots: [],
    activeSlot: STAGING_SLOT,
    selectedId: null,
    /** ドラッグ中に「ここに落ちる」と示すエリアのスロット番号。 */
    dropTarget: null,

    layoutId: null,
    layoutName: '',
    layoutNote: '',
    layoutOwnerId: null,

    equipmentForm: null,
    truckForm: null,
    saveDialog: null,

    /** 識別カラーの選択肢。赤はエラー表示に使うためパレットから除外してある。 */
    palette: PALETTE,
    paletteShades: PALETTE_SHADES,

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
        else this.resetHistory([createStagingSlot()]);
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.loading = false;
      }
    },

    // ---------------- マスタ ----------------

    async reloadMasters() {
      const [equipments, trucks, categories] = await Promise.all([
        listEquipments(),
        listTrucks(),
        listCategories()
      ]);
      this.equipments = equipments;
      this.trucks = trucks;
      this.categories = categories;
    },

    /** 新規登録時の既定カテゴリ。「その他」があればそれ、無ければ先頭。 */
    get defaultCategoryId() {
      const fallback = this.categories.find((category) => category.name === 'その他');
      return (fallback ?? this.categories[0])?.id ?? null;
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
      const byCategory = this.categoryFilter
        ? this.equipments.filter((item) => item.category_id === this.categoryFilter)
        : this.equipments;

      return this.sectionsFor(byCategory, this.equipmentQuery, (item, needle) =>
        `${item.name} ${item.categoryName}`.toLowerCase().includes(needle)
      );
    },

    get truckSections() {
      return this.sectionsFor(this.trucks, this.truckQuery, (item, needle) =>
        item.name.toLowerCase().includes(needle)
      );
    },

    // ---------------- 荷台の読み込み ----------------

    /** 機材置き場を除いた、実際に読み込まれているトラック。 */
    get truckSlots() {
      return this.slots.filter((slot) => !isStaging(slot));
    },

    get stagingSlot() {
      return this.slots.find((slot) => isStaging(slot)) ?? null;
    },

    loadTruck(truck) {
      if (this.readOnly || this.truckSlots.length >= 3) return;

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
      const start = { x: placement.x, y: placement.y };
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
        // どのエリアに落ちるかを先に見せる。ポインタキャプチャ中でも
        // elementFromPoint はポインタ直下の要素を返すので判定に使える。
        this.dropTarget = this.stageSlotAt(moveEvent.clientX, moveEvent.clientY);
      };

      const onUp = (upEvent) => {
        svg.releasePointerCapture(event.pointerId);
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerup', onUp);
        svg.removeEventListener('pointercancel', onUp);
        this.dropTarget = null;

        if (!moved) {
          this.renderAll();
          return;
        }

        const dropSlot = this.stageSlotAt(upEvent.clientX, upEvent.clientY);

        // エリアの外で離した場合は、掴む前の位置に戻す。
        // 荷台外の座標をそのまま採用して赤くするより、意図が分かりやすい。
        if (dropSlot === null) {
          placement.x = start.x;
          placement.y = start.y;
          this.slots = slots;
          this.renderAll();
          return;
        }

        if (dropSlot === working.slot) {
          const threshold = SNAP_PIXELS * mmPerPixel(svg);
          const result = movePlacement(working, placementId, { x: placement.x, y: placement.y }, threshold);
          working.placements = result.placements;
          this.warnIfTruncated(result.truncated);
          this.commit(slots);
          return;
        }

        this.dropIntoSlot(slots, working, dropSlot, placementId, upEvent, offset);
      };

      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
    },

    /** 画面座標の真下にあるエリアのスロット番号。エリア外なら null。 */
    stageSlotAt(clientX, clientY) {
      const element = document.elementFromPoint(clientX, clientY);
      const stage = element?.closest('svg[data-slot]');
      return stage ? Number(stage.dataset.slot) : null;
    },

    /** 別のエリアへ移す。掴んだ位置のオフセットを保ったまま移動先の座標へ変換する。 */
    dropIntoSlot(slots, sourceSlot, targetSlotNumber, placementId, upEvent, offset) {
      const targetSlot = slots.find((item) => item.slot === targetSlotNumber);
      const targetSvg = document.querySelector(`svg[data-slot="${targetSlotNumber}"]`);
      if (!targetSlot || !targetSvg) {
        this.renderAll();
        return;
      }

      const point = clientToBed(targetSvg, upEvent.clientX, upEvent.clientY);
      const position = { x: point.x - offset.x, y: point.y - offset.y };
      const threshold = SNAP_PIXELS * mmPerPixel(targetSvg);

      const result = movePlacementToSlot(sourceSlot, targetSlot, placementId, position, threshold);
      sourceSlot.placements = result.source;
      targetSlot.placements = result.target;

      this.warnIfTruncated(result.truncated);
      this.activeSlot = targetSlotNumber;
      this.commit(slots);
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

    /** テンプレートから種別を判定するための橋渡し。 */
    isStagingSlot(slot) {
      return isStaging(slot);
    },

    /** 保存やPNGに意味がある状態か（トラックを読んだか、置き場に機材があるか）。 */
    get hasContent() {
      return this.truckSlots.length > 0 || (this.stagingSlot?.placements.length ?? 0) > 0;
    },

    /**
     * SVGに渡すstyle。
     * 荷台は横向きに描くので、どのエリアも「高さを揃えて横に伸ばす」形にすると
     * 画面を使い切れる。高さを基準にすることで、トラックと機材置き場の
     * mm/px スケールも近くなり、エリアをまたいでドラッグしたときに
     * 機材の見た目の大きさが極端に変わらない。
     */
    stageStyle(slot) {
      const { w, d } = this.stageBox(slot);
      const width = Math.round(TARGET_STAGE_HEIGHT * (w / d));
      return `width:${width}px; max-width:100%; aspect-ratio:${w} / ${d}`;
    },

    /** 尺規の余白を含めた描画領域の実寸。renderer.jsのviewBoxと一致させる。 */
    stageBox(slot) {
      const view = viewSize({ w: slot.truck.bedWidthMm, d: slot.truck.bedDepthMm });
      return {
        w: view.w + MARGIN_MM * 2,
        d: view.d + MARGIN_MM * 2
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
            category_id: this.defaultCategoryId,
            width_mm: 600,
            depth_mm: 400,
            height_mm: 500,
            weight_kg: 0,
            color: PALETTE[0].hex,
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
          category_id: form.category_id || this.defaultCategoryId,
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

      // 機材置き場が導入される前に保存されたレイアウトにはスロット0が無い。
      // 開けなくなると困るので、空の置き場を補ってから開く。
      const slots = toSlots(row);
      if (!slots.some((slot) => isStaging(slot))) {
        slots.unshift(createStagingSlot());
      }

      this.resetHistory(slots);
      this.activeSlot = this.truckSlots[0]?.slot ?? STAGING_SLOT;
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
