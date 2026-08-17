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
  workingBedOf, clampToBed, duplicatePlacement, autoArrangeSlot
} from '../packing.js';
import { DEFAULT_CLEARANCE_MM, MIN_SETTING_CLEARANCE_MM, MAX_SETTING_CLEARANCE_MM }
  from '../geometry.js';
import {
  renderTruck, updatePlacementPosition, clientToBed, mmPerPixel, MARGIN_MM, viewSize,
  showDropGhost, clearDropGhost, dimPlacement
} from '../renderer.js';
import { downloadSvgAsPng } from '../export-png.js';
import { shapeEditor, prepareEquipmentShape } from '../shape-editor.js';

// 機材フォーム内の共有Alpineコンポーネントから参照する。
window.shapeEditor = shapeEditor;

/** スナップが効き始める画面上の距離(px)。実寸mmには描画倍率をかけて換算する。 */
const SNAP_PIXELS = 12;
/**
 * 通知を出しておく時間(ms)。
 * 通知は荷台に重ねて出すので、居座らせると図を隠してしまう。操作直後にしか
 * 意味のない情報なので、読める程度の時間だけ出して自動的に消す。
 */
const NOTICE_MS = 5000;

export function simulator() {
  return {
    loading: true,
    saving: false,
    errorMessage: '',
    /** 操作の結果を知らせる一時的なメッセージ。荷台に重ねて出し、自動的に消える。 */
    noticeMessage: '',
    noticeTimer: null,
    /**
     * 画面の状態を説明する居座り型のメッセージ（読み取り専用など）。
     * 一時的な通知と違って消えては困るので、重ねずに通常のフローへ置く。
     */
    stateMessage: '',

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
    /**
     * 機材どうし・機材と壁の間に確保する隙間(mm)。レイアウトごとの設定で保存する。
     * スナップの吸着先と押し出し先を決める値であって、既に置いた機材を動かすものでは
     * ないため、あとから変えても図は崩れない。
     */
    clearanceMm: DEFAULT_CLEARANCE_MM,
    clearanceRange: { min: MIN_SETTING_CLEARANCE_MM, max: MAX_SETTING_CLEARANCE_MM },
    activeSlot: null,
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
        else this.resetHistory([]);
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

    /** カテゴリの既定色。未設定・不明なら null。 */
    categoryDefaultColor(categoryId) {
      return this.categories.find((category) => category.id === categoryId)?.default_color ?? null;
    },

    /**
     * カテゴリを選び直したら識別カラーを既定色へ差し替える。
     * 現場ではカテゴリごとに色を揃えて使うため、手で選んだ色より既定色を優先する。
     * 別の色にしたいときは、この直後にパレットで選び直せる。
     */
    applyCategoryColor(categoryId) {
      const color = this.categoryDefaultColor(categoryId);
      if (color) this.equipmentForm.color = color;
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

    /** 最後の1台は削除できない。常にトラックを最低1台は保持する。 */
    removeSlot(slotNumber) {
      if (this.readOnly || this.slots.length <= 1) return;
      this.commit(this.rawSlots().filter((slot) => slot.slot !== slotNumber));
      if (this.activeSlot === slotNumber) {
        this.activeSlot = this.slots[0]?.slot ?? null;
      }
    },

    // ---------------- 機材の配置 ----------------

    addEquipment(equipment) {
      if (this.readOnly) return;

      const slots = this.rawSlots();
      const target = slots.find((slot) => slot.slot === this.activeSlot) ?? slots[0];
      if (!target) {
        this.notice('先にトラックを読み込んでください。');
        return;
      }

      const placement = createPlacement(
        equipment, target, () => crypto.randomUUID(), this.clearanceMm
      );
      // リアゲート側の仮置きゾーンを含めても空きが無ければ置かない。
      if (!placement) {
        this.notice('空きスペースがないため、配置できません。配置を詰めてください。');
        return;
      }

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
      /** 移動先のゴーストを描いているSVG。移動先が変わったら消して描き直す。 */
      let ghostSvg = null;

      /**
       * 移動先エリアに着地点のゴーストを出す。掴んだエリアの上にいる間と
       * エリアの外にいる間は出さない（そこは実物がそのまま追従している）。
       */
      const updateGhost = (clientX, clientY, dropSlot) => {
        const targetSvg = dropSlot === null || dropSlot === working.slot
          ? null
          : document.querySelector(`svg[data-slot="${dropSlot}"]`);

        if (ghostSvg && ghostSvg !== targetSvg) clearDropGhost(ghostSvg);
        ghostSvg = targetSvg;
        dimPlacement(svg, placementId, targetSvg !== null);
        if (!targetSvg) return;

        const targetSlot = slots.find((item) => item.slot === dropSlot);
        const landing = this.landingPosition(
          targetSvg, targetSlot, placement, clientX, clientY, offset
        );
        showDropGhost(targetSvg, { ...placement, ...landing });
      };

      const onMove = (moveEvent) => {
        const point = clientToBed(svg, moveEvent.clientX, moveEvent.clientY);
        // 壁の外へは出さない。ポインタが荷台の外に出ても機材は壁で止まる。
        const inside = clampToBed(
          { ...placement, x: point.x - offset.x, y: point.y - offset.y },
          working,
          this.clearanceMm
        );
        placement.x = inside.x;
        placement.y = inside.y;
        moved = true;
        // ドラッグ中は描画し直さず座標だけ書き換える（ポインタキャプチャを維持するため）
        updatePlacementPosition(svg, placement);
        // どのエリアに落ちるかを先に見せる。ポインタキャプチャ中でも
        // elementFromPoint はポインタ直下の要素を返すので判定に使える。
        this.dropTarget = this.stageSlotAt(moveEvent.clientX, moveEvent.clientY);
        updateGhost(moveEvent.clientX, moveEvent.clientY, this.dropTarget);
      };

      const onUp = (upEvent) => {
        svg.releasePointerCapture(event.pointerId);
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerup', onUp);
        svg.removeEventListener('pointercancel', onUp);
        this.dropTarget = null;
        if (ghostSvg) clearDropGhost(ghostSvg);
        dimPlacement(svg, placementId, false);

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
          // Altを押して離したときは、外接bboxのスナップを止めて掴んだ位置を優先する。
          // 多角形の斜面どうしを少しずらして寄せる場合でも、重なりとクリアランスの
          // 判定は後段の movePlacement / settle が通常どおり行う。
          const threshold = upEvent.altKey ? 0 : SNAP_PIXELS * mmPerPixel(svg);
          const result = movePlacement(
            working, placementId, { x: placement.x, y: placement.y }, threshold, this.clearanceMm
          );
          // 押し出した先が荷台に収まらない場合は移動そのものが成立しない。
          // 掴む前の位置へ戻す（result.placements も元のまま返ってくる）。
          if (result.rejected) {
            placement.x = start.x;
            placement.y = start.y;
            this.slots = slots;
            this.notice('ここへ移すと他の機材が荷台に収まらないため、移動できません。');
            this.renderAll();
            return;
          }
          working.placements = result.placements;
          this.noticeIfTruncated(result.truncated);
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

    /**
     * ポインタの位置から、移動先エリアでの着地点(荷台のmm座標)を求める。
     *
     * 掴んだ位置のオフセットは荷台のmm座標なので、別のエリアでもそのまま使える。
     * 移動先の壁の外へは出さない。同じエリア内のドラッグと同じ扱いにすることで、
     * 端で落としたときに「収まらない」と弾かれず、壁にぴったり付いて止まる。
     *
     * ゴーストの描画と実際の移動で同じ計算を使うこと。見せた位置と落ちる位置が
     * ずれると、プレビューが当てにならなくなる。
     */
    landingPosition(targetSvg, targetSlot, placement, clientX, clientY, offset) {
      const point = clientToBed(targetSvg, clientX, clientY);
      return clampToBed(
        { ...placement, x: point.x - offset.x, y: point.y - offset.y },
        targetSlot,
        this.clearanceMm
      );
    },

    /** 別のエリアへ移す。掴んだ位置のオフセットを保ったまま移動先の座標へ変換する。 */
    dropIntoSlot(slots, sourceSlot, targetSlotNumber, placementId, upEvent, offset) {
      const targetSlot = slots.find((item) => item.slot === targetSlotNumber);
      const targetSvg = document.querySelector(`svg[data-slot="${targetSlotNumber}"]`);
      const moving = sourceSlot.placements.find((item) => item.id === placementId);
      if (!targetSlot || !targetSvg || !moving) {
        this.renderAll();
        return;
      }

      const position = this.landingPosition(
        targetSvg, targetSlot, moving, upEvent.clientX, upEvent.clientY, offset
      );
      // エリアをまたぐドラッグも同じ操作感にする。Altはスナップだけを止め、
      // 荷台内へのクランプと干渉判定は無効にしない。
      const threshold = upEvent.altKey ? 0 : SNAP_PIXELS * mmPerPixel(targetSvg);

      const result = movePlacementToSlot(
        sourceSlot, targetSlot, placementId, position, threshold, this.clearanceMm
      );
      // 移動先に収まらなければ移動元に留める。
      if (result.rejected) {
        this.notice('移動先の荷台に収まらないため、移せません。');
        this.renderAll();
        return;
      }

      sourceSlot.placements = result.source;
      targetSlot.placements = result.target;

      this.noticeIfTruncated(result.truncated);
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
      // 荷台は横向きに描いている（renderer.js: ビューX = 荷台y、ビューY = 荷台w - 荷台x）ため、
      // 矢印キーは荷台座標そのままではなく、画面上の見た目の向きへ写してから渡す。
      // そうしないと「→」を押した機材が画面では下へ動く。
      const deltas = {
        ArrowLeft: { x: 0, y: -step },
        ArrowRight: { x: 0, y: step },
        ArrowUp: { x: step, y: 0 },
        ArrowDown: { x: -step, y: 0 }
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
        // 壁の外へは出さない。壁に向かって押し続けると、壁にぴったり付いて止まる。
        const target = clampToBed(
          { ...placement, x: placement.x + delta.x, y: placement.y + delta.y },
          slot,
          this.clearanceMm
        );
        if (target.x === placement.x && target.y === placement.y) return;

        // キー操作は微調整なのでスナップは効かせない（しきい値0）
        const result = movePlacement(slot, placement.id, target, 0, this.clearanceMm);
        if (result.rejected) {
          this.notice('他の機材が荷台に収まらなくなるため、これ以上動かせません。');
          return;
        }

        slot.placements = result.placements;
        this.noticeIfTruncated(result.truncated);
        this.commit(slots);
      });
    },

    rotateSelected() {
      this.withSelected((slot, placement, slots) => {
        const result = rotatePlacement(slot, placement.id, this.clearanceMm);
        // 隣を押し出すのは許すが、押し出した結果まで含めて収まらなければ回転しない。
        if (result.rejected) {
          this.notice('回転させると荷台に収まらないため、回転できません。');
          return;
        }

        slot.placements = result.placements;
        this.noticeIfTruncated(result.truncated);
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
        const copy = duplicatePlacement(
          slot, placement.id, () => crypto.randomUUID(), this.clearanceMm
        );
        if (!copy) {
          this.notice('空きスペースがないため、複製できません。');
          return;
        }

        slot.placements = [...slot.placements, copy];
        this.selectedId = copy.id;
        this.commit(slots);
      });
    },

    /** 指定した1台だけを一括で詰め直す。成功時は履歴上の1操作として確定する。 */
    autoArrange(slotNumber) {
      if (this.readOnly) return;

      const slots = this.rawSlots();
      const slot = slots.find((item) => item.slot === slotNumber);
      if (!slot || slot.placements.length === 0) return;

      const result = autoArrangeSlot(slot, this.clearanceMm);
      if (result.status === 'failed') {
        this.notice('全機材を収められなかったため、配置を変更しませんでした。');
        return;
      }
      if (result.status === 'unchanged') {
        if (result.stackSuggestion) {
          this.notice(this.stackSuggestionNotice(slot.truck.name, result.stackSuggestion.name));
        } else {
          this.notice('機材は既に自動配置と同じ位置にあります。');
        }
        return;
      }

      slot.placements = result.placements;
      this.selectedId = null;
      this.commit(slots);
      if (result.stackSuggestion) {
        this.notice(this.stackSuggestionNotice(slot.truck.name, result.stackSuggestion.name));
      } else {
        this.notice(`${slot.truck.name} の機材を自動配置しました。`);
      }
    },

    stackSuggestionNotice(truckName, equipmentName) {
      return `${truckName} の機材を自動配置しました。` +
        `${equipmentName} 1台は床面計算から外しています。` +
        '他の機材への縦積みを検討してください。';
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

    /**
     * 通知を出す。空文字を渡すと消える。
     * 荷台に重ねて表示するため、放置せず NOTICE_MS 後に自動で消す。
     */
    notice(message) {
      clearTimeout(this.noticeTimer);
      this.noticeMessage = message;
      if (!message) return;
      this.noticeTimer = setTimeout(() => {
        this.noticeMessage = '';
      }, NOTICE_MS);
    },

    /** 設定できる範囲へ丸める。手入力とDBの想定外の値の両方を受け止める。 */
    normalizeClearance(value) {
      const number = Math.round(Number(value));
      if (!Number.isFinite(number)) return DEFAULT_CLEARANCE_MM;
      return Math.min(Math.max(number, this.clearanceRange.min), this.clearanceRange.max);
    },

    /**
     * クリアランスを変える。既に置いてある機材は動かさない。
     * 勝手に配置が変わるほうが分かりにくいので、動かす代わりに、新しい隙間を
     * 確保できていない機材を赤くして知らせる。
     */
    setClearance(value) {
      if (this.readOnly) return;
      const next = this.normalizeClearance(value);
      if (next === this.clearanceMm) return;

      this.clearanceMm = next;
      this.renderAll();

      const short = this.rawSlots()
        .reduce((total, slot) => total + summarize(slot, next).invalidCount, 0);
      this.notice(
        short > 0
          ? `クリアランスを ${next}mm にしました。確保できていない機材が ${short} 点あります（赤色）。配置は動かしていません。`
          : `クリアランスを ${next}mm にしました。すべての機材が確保できています。`
      );
    },

    noticeIfTruncated(truncated) {
      this.notice(
        truncated
          ? '配置が詰まっていて押し出しを完了できませんでした。「元に戻す」で直前の状態に戻せます。'
          : ''
      );
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
            invalidIds: summarize(raw, this.clearanceMm).invalidIds,
            selectedId: this.selectedId,
            clearanceMm: this.clearanceMm
          });
        }
      });
    },

    summaryOf(slot) {
      return summarize(JSON.parse(JSON.stringify(slot)), this.clearanceMm);
    },

    /** 保存やPNGに意味がある状態か（トラックを1台でも読んでいるか）。 */
    get hasContent() {
      return this.slots.length > 0;
    },

    /**
     * SVGに渡すstyle。
     * workingBedOf の奥行きは全トラック共通でREFERENCE_DEPTH_MM（リアゲート側の
     * 仮置きぶんを含む）になるため、幅は常にカラムいっぱい（100%）でよい。
     * 高さは荷台の幅から決まる縦横比なので、トラックごとに変わる。
     */
    stageStyle(slot) {
      const { w, d } = this.stageBox(slot);
      return `width:100%; aspect-ratio:${w} / ${d}`;
    },

    /** 尺規の余白を含めた描画領域の実寸。renderer.jsのviewBoxと一致させる。 */
    stageBox(slot) {
      const view = viewSize(workingBedOf(slot));
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

    /**
     * 登録済みのデータを「共通テンプレート」と「自分のデータ」の間で移すために、
     * 所有者を切り替えたときだけ user_id を更新値へ足す（機材・トラック共通）。
     *
     * user_id を毎回送ると、他人のデータを開いたときに所有者を奪ってしまう。
     * RLSは「更新前の行」と「更新後の行」を別々のポリシーで判定するため、
     * 自分のデータ（*_update_own）→ テンプレート（*_update_template）の
     * 移動はそのまま通る。追加のポリシーは要らない。
     */
    withOwnerChange(form, values) {
      // テンプレートを扱えるのはAdminだけ。Editor/Viewerからは所有者を一切送らない。
      if (!this.isAdmin) return values;
      const ownerId = form.asTemplate ? null : this.session.user.id;
      if (ownerId === (form.user_id ?? null)) return values;
      return { ...values, user_id: ownerId };
    },

    /** 新規作成時の所有者。Admin以外はテンプレートを作れないので、必ず自分のデータにする。 */
    ownerIdForCreate(form) {
      return this.isAdmin && form.asTemplate ? null : this.session.user.id;
    },

    // ---------------- 機材フォーム ----------------

    openEquipmentForm(item) {
      this.equipmentForm = item
        ? { ...item, shape: item.shape ? JSON.parse(JSON.stringify(item.shape)) : null, asTemplate: item.user_id === null }
        : {
            id: null,
            name: '',
            category_id: this.defaultCategoryId,
            width_mm: 600,
            depth_mm: 400,
            height_mm: 500,
            weight_kg: 0,
            // 開いた直後からカテゴリと色が一致するよう、既定カテゴリの色から始める。
            color: this.categoryDefaultColor(this.defaultCategoryId) ?? PALETTE[0].hex,
            shape: null,
            asTemplate: false
          };
    },

    async saveEquipment() {
      this.saving = true;
      this.errorMessage = '';
      try {
        const form = this.equipmentForm;
        prepareEquipmentShape(form);
        const values = {
          name: form.name,
          category_id: form.category_id || this.defaultCategoryId,
          width_mm: form.width_mm,
          depth_mm: form.depth_mm,
          height_mm: form.height_mm,
          weight_kg: form.weight_kg ?? 0,
          color: form.color,
          shape: form.shape
        };

        if (form.id) {
          await updateEquipment(form.id, this.withOwnerChange(form, values));
        } else {
          await createEquipment(values, this.ownerIdForCreate(form));
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
          ? await updateTruck(form.id, this.withOwnerChange(form, values))
          : await createTruck(values, this.ownerIdForCreate(form));

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
            clearanceMm: this.clearanceMm,
            slots: this.rawSlots()
          },
          this.session.user.id
        );

        this.layoutId = id;
        this.layoutName = dialog.name;
        this.layoutNote = dialog.note;
        this.layoutOwnerId = this.session.user.id;
        this.saveDialog = null;
        this.notice('保存しました。');
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
      // 004以前に保存されたレイアウトには列が無いので既定値で開く。
      this.clearanceMm = this.normalizeClearance(row.clearance_mm ?? DEFAULT_CLEARANCE_MM);

      // 他人のレイアウトは編集できない（RLSでも弾かれる）。読み取り専用で開く。
      if (row.user_id !== this.session.user.id) {
        this.readOnly = true;
        // これは操作の結果ではなく画面の状態なので、消えないほうを使う。
        this.stateMessage =
          '他のユーザーのレイアウトです。編集するには「別のレイアウトとして保存」してください。';
      }

      // 「機材置き場」が独立したスロット（slot 0）だった頃に保存されたレイアウトが
      // 対象の場合、そのスロットは読み込み時に無視する（トラック本体の配置には
      // 影響しない。旧・機材置き場に仮置きしたままだった分だけ読み込まれない）。
      const slots = toSlots(row).filter((slot) => slot.truck?.kind !== 'staging');

      this.resetHistory(slots);
      this.activeSlot = slots[0]?.slot ?? null;
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
