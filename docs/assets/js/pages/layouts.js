// レイアウト一覧画面。
//
// 「自分のレイアウト」と「他のユーザーのレイアウト」を別々の表に分けて出す。
// 保存したレイアウトは全ユーザーが閲覧できるが、編集できるのは作成者だけなので、
// 同じ表に混ぜると「開いたのに編集できない」理由が分かりにくい。

import { initAuthenticatedPage } from '../layout.js';
import { canEdit } from '../auth.js';
import { translateError, withSaving } from '../error-messages.js';
import { listLayouts, listOwnerNames, deleteLayout, renameLayout, loadLayout, saveLayout, toSlots }
  from '../layouts.js';
import { renderTruck } from '../renderer.js';
import { summarize } from '../packing.js';
import { DEFAULT_CLEARANCE_MM } from '../geometry.js';
import { downloadSvgAsJpeg } from '../export-png.js';

/**
 * 1ユーザーが保存できるレイアウトの上限。担保は DB トリガ（006_layout_limit.sql）で、
 * ここは残り枠を見せるためだけの値。変えるときは必ず両方を揃えること。
 */
const LAYOUT_LIMIT = 300;

export function layoutList() {
  return {
    layoutLimit: LAYOUT_LIMIT,

    loading: true,
    saving: false,
    errorMessage: '',
    noticeMessage: '',

    session: null,
    profile: null,
    layouts: [],
    ownerNames: new Map(),
    query: '',

    renameForm: null,

    async init() {
      const context = await initAuthenticatedPage();
      if (!context) return;

      this.session = context.session;
      this.profile = context.profile;

      try {
        await this.reload();
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.loading = false;
      }
    },

    async reload() {
      const [layouts, ownerNames] = await Promise.all([listLayouts(), listOwnerNames()]);
      this.layouts = layouts.map((layout) => decorate(layout));
      this.ownerNames = ownerNames;
    },

    get canEditLayouts() {
      return canEdit(this.profile);
    },

    filtered(layouts) {
      const needle = this.query.trim().toLowerCase();
      if (!needle) return layouts;
      return layouts.filter((layout) =>
        `${layout.name} ${layout.note ?? ''} ${layout.truckNames}`.toLowerCase().includes(needle)
      );
    },

    get myLayouts() {
      return this.filtered(this.mine);
    },

    /** 絞り込み前の自分のレイアウト。上限に対する残り枠を数えるのに使う。 */
    get mine() {
      return this.layouts.filter((layout) => layout.user_id === this.session?.user?.id);
    },

    get otherLayouts() {
      return this.filtered(this.layouts.filter((layout) => layout.user_id !== this.session?.user?.id));
    },

    ownerName(layout) {
      return this.ownerNames.get(layout.user_id) ?? 'ユーザー';
    },

    open(layout) {
      window.location.href = `./simulator.html?layout=${encodeURIComponent(layout.id)}`;
    },

    // モバイルでは一覧上での編集もシミュレーターへの遷移も不可のため、
    // 画面には出さない<svg>を作ってその場でJPGを書き出す（simulator.jsの
    // renderAll()と同じ手順を、Alpineの状態を介さず直接呼んでいるだけ）。
    async exportJpg(layout) {
      await withSaving(this, async () => {
        const row = await loadLayout(layout.id);
        const slot = toSlots(row).find((item) => item.truck?.kind !== 'staging');
        if (!slot) return;

        const clearanceMm = row.clearance_mm ?? DEFAULT_CLEARANCE_MM;
        const raw = JSON.parse(JSON.stringify(slot));

        // widthとheightを指定しないと、幅/高さのないreplace要素として扱われ、
        // viewBox（実寸mm）がそのままCSS pxのボックスサイズとして使われてしまう
        // （荷台1台分は数千mm四方あり、left:-9999pxだけでは右端が画面内に
        // はみ出す）。1pxに固定して、どんな寸法の荷台でも画面外に収まるようにする。
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.position = 'fixed';
        svg.style.left = '-9999px';
        svg.style.top = '-9999px';
        svg.style.width = '1px';
        svg.style.height = '1px';
        svg.style.opacity = '0';
        svg.style.pointerEvents = 'none';
        document.body.appendChild(svg);

        try {
          renderTruck(svg, raw, { invalidIds: summarize(raw, clearanceMm).invalidIds, clearanceMm });

          const base = (row.name || 'loadsym').replace(/[\\/:*?"<>|]/g, '_');
          const title = `${row.name || '無題のレイアウト'} : ${slot.truck.name}`;
          await downloadSvgAsJpeg(svg, `${base}_${slot.truck.name}.jpg`, title);
        } finally {
          svg.remove();
        }
      });
    },

    openRenameForm(layout) {
      this.renameForm = { id: layout.id, name: layout.name, note: layout.note ?? '' };
    },

    async saveRename() {
      await withSaving(this, async () => {
        await renameLayout(this.renameForm.id, this.renameForm.name, this.renameForm.note || null);
        await this.reload();
        this.renameForm = null;
      });
    },

    async remove(layout) {
      if (!window.confirm(`「${layout.name}」を削除しますか？この操作は元に戻せません。`)) return;

      await withSaving(this, async () => {
        await deleteLayout(layout.id);
        await this.reload();
        this.noticeMessage = '削除しました。';
      });
    },

    /**
     * 他ユーザーのレイアウトを自分のものとして複製する。
     * 配置は保存時のスナップショットをそのまま引き継ぐため、複製元の機材マスタが
     * 変更・削除されていても図はそのまま残る。
     */
    async duplicate(layout) {
      await withSaving(this, async () => {
        const row = await loadLayout(layout.id);
        const name = `${row.name} のコピー`;
        const id = await saveLayout({ name, note: row.note, slots: toSlots(row) }, this.session.user.id);
        await this.reload();
        this.noticeMessage = `「${name}」として複製しました。`;
        window.location.href = `./simulator.html?layout=${encodeURIComponent(id)}`;
      });
    },

    formatDate(value) {
      return new Date(value).toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  };
}

/** 一覧の表示と絞り込みに使うトラック名をあらかじめ組み立てておく。 */
function decorate(layout) {
  const trucks = (layout.layout_trucks ?? [])
    .filter((area) => area.truck_snapshot?.kind !== 'staging');

  return {
    ...layout,
    truckNames: trucks.map((area) => area.truck_snapshot?.name ?? '（不明）').join('、') || '—'
  };
}
