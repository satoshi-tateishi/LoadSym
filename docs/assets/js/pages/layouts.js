// レイアウト一覧画面。
//
// 「自分のレイアウト」と「他のユーザーのレイアウト」を別々の表に分けて出す。
// 保存したレイアウトは全ユーザーが閲覧できるが、編集できるのは作成者だけなので、
// 同じ表に混ぜると「開いたのに編集できない」理由が分かりにくい。

import { initAuthenticatedPage } from '../layout.js';
import { canEdit } from '../auth.js';
import { translateError } from '../error-messages.js';
import { listLayouts, listOwnerNames, deleteLayout, renameLayout, loadLayout, saveLayout, toSlots }
  from '../layouts.js';

export function layoutList() {
  return {
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
      return this.filtered(this.layouts.filter((layout) => layout.user_id === this.session?.user?.id));
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

    openRenameForm(layout) {
      this.renameForm = { id: layout.id, name: layout.name, note: layout.note ?? '' };
    },

    async saveRename() {
      this.saving = true;
      this.errorMessage = '';
      try {
        await renameLayout(this.renameForm.id, this.renameForm.name, this.renameForm.note || null);
        await this.reload();
        this.renameForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async remove(layout) {
      if (!window.confirm(`「${layout.name}」を削除しますか？この操作は元に戻せません。`)) return;

      this.saving = true;
      this.errorMessage = '';
      try {
        await deleteLayout(layout.id);
        await this.reload();
        this.noticeMessage = '削除しました。';
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    /**
     * 他ユーザーのレイアウトを自分のものとして複製する。
     * 配置は保存時のスナップショットをそのまま引き継ぐため、複製元の機材マスタが
     * 変更・削除されていても図はそのまま残る。
     */
    async duplicate(layout) {
      this.saving = true;
      this.errorMessage = '';
      try {
        const row = await loadLayout(layout.id);
        const name = `${row.name} のコピー`;
        const id = await saveLayout({ name, note: row.note, slots: toSlots(row) }, this.session.user.id);
        await this.reload();
        this.noticeMessage = `「${name}」として複製しました。`;
        window.location.href = `./simulator.html?layout=${encodeURIComponent(id)}`;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
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
