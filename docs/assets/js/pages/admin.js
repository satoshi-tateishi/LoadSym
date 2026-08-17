// 管理画面（Admin専用）。ユーザー管理 / カテゴリ管理 / テンプレート機材 / CSVインポート。
//
// ページ側でもロールを見てリダイレクトするが、これはURL直打ちへの目隠しにすぎない。
// 実際の権限はすべてRLSとRPC内のチェックが担保している。

import { initAuthenticatedPage } from '../layout.js';
import { translateError, withSaving } from '../error-messages.js';
import { listUsers, updateUser } from '../admin-users.js';
import {
  listCategories, createCategory, updateCategory, deleteCategory, countEquipmentsByCategory,
  updateCategoryOrder
} from '../categories.js';
import {
  listEquipments, createEquipment, updateEquipment, deleteEquipment, createEquipments,
  updateEquipmentOrder
} from '../equipments.js';
import { readTextFile, parseCsv, toEquipmentRows, EQUIPMENT_CSV_HEADERS } from '../csv.js';
import { exportBackup, restoreBackup, backupSummary, backupFilename } from '../backup.js';
import {
  connect as dropboxConnect, isConnected as dropboxIsConnected,
  uploadJson as dropboxUpload, listBackups as dropboxListBackups,
  downloadJson as dropboxDownloadJson
} from '../dropbox-client.js';
import { PALETTE, PALETTE_SHADES, paletteToCsv } from '../palette.js';
import { shapeEditor, prepareEquipmentShape } from '../shape-editor.js';
import {
  defaultCategoryIdOf, categoryDefaultColorOf, emptyEquipmentDraft, buildEquipmentValues
} from '../equipment-form.js';

// 機材フォーム内の共有Alpineコンポーネントから参照する。
window.shapeEditor = shapeEditor;

// iOS Safariはドラッグハンドルへのtouchstartを配信しないため、SortableJSでの
// ドラッグ並び替えはPC/Mac相当の入力デバイスに限定し、タッチ環境では↑↓ボタンを使う。
// 画面幅だけで判定すると横向きiPadのような広いタッチ端末も含んでしまうので、
// hover/pointer でマウス・トラックパッド操作かどうかも合わせて見る。
const DESKTOP_QUERY = '(min-width: 768px) and (hover: hover) and (pointer: fine)';

function swapAdjacent(items, item, direction) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const target = index + direction;
  if (target < 0 || target >= items.length) return null;
  const reordered = [...items];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  return reordered;
}

export function admin() {
  return {
    loading: true,
    saving: false,
    errorMessage: '',
    noticeMessage: '',

    session: null,
    profile: null,
    tab: 'users',

    users: [],
    categories: [],
    categoryCounts: new Map(),
    templates: [],

    categoryForm: null,
    equipmentForm: null,
    importPreview: null,

    dropboxConnected: false,
    lastBackup: null,
    backupList: [],
    restorePreview: null,
    restoreConfirmText: '',

    equipmentFormLabel: 'テンプレート機材',
    showTemplateOwnershipControl: false,

    get categoryManagementHint() {
      return '';
    },

    isDesktop: false,
    /** 並び替え可能なリストごとのSortableインスタンス。 */
    sortables: { categories: null, templates: null },

    /** 識別カラーの選択肢。赤はエラー表示に使うためパレットから除外してある。 */
    palette: PALETTE,
    paletteShades: PALETTE_SHADES,

    async init() {
      const desktopQuery = window.matchMedia(DESKTOP_QUERY);
      this.isDesktop = desktopQuery.matches;
      desktopQuery.addEventListener('change', (event) => {
        this.isDesktop = event.matches;
        this.$nextTick(() => this.syncSortable());
      });

      const context = await initAuthenticatedPage();
      if (!context) return;

      this.session = context.session;
      this.profile = context.profile;

      if (context.profile?.role !== 'Admin') {
        window.location.href = './simulator.html';
        return;
      }

      // dropbox-callback.html からの戻り先。接続直後にバックアップタブを開けるようにする。
      if (new URLSearchParams(window.location.search).get('tab') === 'backup') {
        this.tab = 'backup';
      }
      this.dropboxConnected = dropboxIsConnected();

      try {
        await this.reload();
        if (this.dropboxConnected) await this.refreshBackupList();
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.loading = false;
        this.$nextTick(() => this.syncSortable());
      }
    },

    async reload() {
      const [users, categories, counts, equipments] = await Promise.all([
        listUsers(),
        listCategories(),
        countEquipmentsByCategory(),
        listEquipments()
      ]);
      this.users = users;
      this.categories = categories;
      this.categoryCounts = counts;
      // テンプレート = user_id が null のもの。管理画面で扱うのはこれだけ。
      this.templates = equipments.filter((item) => item.user_id === null);
    },

    // ---------------- ユーザー管理 ----------------

    isSelf(user) {
      return user.id === this.session?.user?.id;
    },

    async changeRole(user, role) {
      await this.applyUserChange(user, { role });
    },

    async toggleDisabled(user) {
      await this.applyUserChange(user, { disabled: !user.disabled });
    },

    async applyUserChange(user, values) {
      this.noticeMessage = '';
      await withSaving(this, async () => {
        await updateUser(user.id, values);
        this.users = await listUsers();
        this.noticeMessage = `${user.email} を更新しました。`;
      }, {
        // 失敗したときに画面の見た目だけ変わったままにならないよう、必ず取り直す。
        onError: async () => { this.users = await listUsers(); }
      });
    },

    // ---------------- カテゴリ管理 ----------------

    categoryCount(category) {
      return this.categoryCounts.get(category.id) ?? 0;
    },

    openCategoryForm(category) {
      this.categoryForm = category
        ? { ...category }
        : {
            id: null,
            name: '',
            sort_order: nextSortOrder(this.categories),
            default_color: PALETTE[0].hex
          };
    },

    async saveCategory() {
      await withSaving(this, async () => {
        const form = this.categoryForm;
        const values = {
          name: form.name.trim(),
          sort_order: form.sort_order ?? 0,
          default_color: form.default_color
        };

        if (form.id) await updateCategory(form.id, values);
        else await createCategory(values);

        await this.reload();
        this.categoryForm = null;
        this.noticeMessage = 'カテゴリを保存しました。';
      });
    },

    async removeCategory() {
      const used = this.categoryCount(this.categoryForm);
      if (used > 0) {
        this.errorMessage = `このカテゴリは ${used} 件の機材に使われているため削除できません。先に別のカテゴリへ移してください。`;
        return;
      }
      if (!window.confirm(`カテゴリ「${this.categoryForm.name}」を削除しますか？`)) return;

      await withSaving(this, async () => {
        await deleteCategory(this.categoryForm.id);
        await this.reload();
        this.categoryForm = null;
        this.noticeMessage = 'カテゴリを削除しました。';
      });
    },

    /**
     * ↑↓ボタンで1つ入れ替える。タッチ環境ではこちらが唯一の並び替え手段になる。
     * 表示中の並びをそのまま採番し直すので、ドラッグ並び替えと結果が揃う。
     */
    async moveCategory(category, direction) {
      const reordered = swapAdjacent(this.categories, category, direction);
      if (!reordered) return;
      await this.persistCategoryOrder(reordered);
    },

    /** PC/Mac相当の入力デバイスのときだけドラッグ並び替えを有効にする。 */
    syncSortable() {
      this.bindSortable(
        'categories',
        'category-list',
        () => this.categories,
        (reordered) => this.persistCategoryOrder(reordered)
      );
      this.bindSortable(
        'templates',
        'template-list',
        () => this.templates,
        (reordered) => this.persistTemplateOrder(reordered)
      );
    },

    /**
     * 並び替え可能なリスト1つ分のSortableを付け外しする。
     * カテゴリとテンプレート機材で同じ挙動にするため、1か所にまとめている。
     */
    bindSortable(key, elementId, getItems, persist) {
      if (!this.isDesktop) {
        if (this.sortables[key]) {
          this.sortables[key].destroy();
          this.sortables[key] = null;
        }
        return;
      }
      if (this.sortables[key]) return;

      const container = document.getElementById(elementId);
      if (!container || typeof Sortable === 'undefined') return;

      // oldIndex/newIndex は信用せず、ドロップ後のDOMの実並び（data-id）を正とする。
      // SortableJSがDOMを動かした結果とAlpineの再描画がずれるのを避けるため、
      // 並べ替えたデータをそのまま代入してAlpineに追従させる。
      this.sortables[key] = new Sortable(container, {
        animation: 150,
        handle: '.drag-handle',
        ghostClass: 'opacity-40',
        onEnd: async () => {
          const orderedIds = Array.from(container.children).map((row) => row.dataset.id);
          const items = getItems();
          const byId = new Map(items.map((item) => [item.id, item]));
          const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
          if (reordered.length !== items.length) return;

          const changed = reordered.some((item, index) => item.id !== items[index].id);
          if (!changed) return;

          await persist(reordered);
        }
      });
    },

    async persistCategoryOrder(reordered) {
      const previous = this.categories;
      this.categories = reordered;
      await this.saveOrder(
        () => updateCategoryOrder(reordered.map((category) => category.id)),
        () => {
          this.categories = previous;
        }
      );
    },

    async persistTemplateOrder(reordered) {
      const previous = this.templates;
      this.templates = reordered;
      await this.saveOrder(
        () => updateEquipmentOrder(reordered.map((item) => item.id)),
        () => {
          this.templates = previous;
        }
      );
    },

    /** 画面の並びを確定してDBへ反映する。失敗したらサーバーの状態に戻す。 */
    async saveOrder(save, rollback) {
      await withSaving(this, async () => {
        await save();
        await this.reload();
      }, { onError: rollback });
    },

    // ---------------- テンプレート機材 ----------------

    get defaultCategoryId() {
      return defaultCategoryIdOf(this.categories);
    },

    /** カテゴリの既定色。未設定・不明なら null。 */
    categoryDefaultColor(categoryId) {
      return categoryDefaultColorOf(this.categories, categoryId);
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

    /** ↑↓ボタンで1つ入れ替える。タッチ環境ではこちらが唯一の並び替え手段になる。 */
    async moveTemplate(item, direction) {
      const reordered = swapAdjacent(this.templates, item, direction);
      if (!reordered) return;
      await this.persistTemplateOrder(reordered);
    },

    openEquipmentForm(item) {
      this.equipmentForm = item
        ? { ...item, shape: item.shape ? JSON.parse(JSON.stringify(item.shape)) : null }
        // 開いた直後からカテゴリと色が一致するよう、既定カテゴリの色から始める。
        : emptyEquipmentDraft(
            this.defaultCategoryId,
            this.categoryDefaultColor(this.defaultCategoryId) ?? PALETTE[0].hex
          );
    },

    async saveEquipment() {
      await withSaving(this, async () => {
        const form = this.equipmentForm;
        prepareEquipmentShape(form);
        const values = buildEquipmentValues(form, this.defaultCategoryId);

        // 管理画面から作るものは常に共通テンプレート（user_id = null）。
        if (form.id) await updateEquipment(form.id, values);
        else await createEquipment(values, null);

        await this.reload();
        this.equipmentForm = null;
        this.noticeMessage = 'テンプレート機材を保存しました。';
      });
    },

    async removeEquipment() {
      if (!window.confirm(`「${this.equipmentForm.name}」を削除しますか？`)) return;
      await withSaving(this, async () => {
        await deleteEquipment(this.equipmentForm.id);
        await this.reload();
        this.equipmentForm = null;
      });
    },

    // ---------------- CSVインポート ----------------

    get csvHeaderSample() {
      return EQUIPMENT_CSV_HEADERS.join(',');
    },

    /**
     * パレット255色をCSVで書き出す。スプレッドシートで機材リストを作るとき、
     * color 列に貼る値をここから選べるようにするため。
     * ExcelがUTF-8と判別できるようBOMを付ける。
     */
    downloadPaletteCsv() {
      const blob = new Blob(['\ufeff' + paletteToCsv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'loadsym-color-palette.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    /** 取り込み前に必ずプレビューを挟む。誤ったCSVで一気に登録されるのを防ぐ。 */
    async previewCsv(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      this.errorMessage = '';
      this.noticeMessage = '';
      try {
        const text = await readTextFile(file);
        const rows = parseCsv(text);
        const byName = new Map(this.categories.map((category) => [category.name, category.id]));
        const result = toEquipmentRows(rows, byName, this.defaultCategoryId);

        this.importPreview = {
          fileName: file.name,
          ...result,
          importable: result.items.filter((item) => !item.fatal).length
        };
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        // 同じファイルを選び直せるように値をクリアする
        event.target.value = '';
      }
    },

    async confirmImport() {
      const rows = this.importPreview.items.filter((item) => !item.fatal).map((item) => item.values);
      if (rows.length === 0) return;

      await withSaving(this, async () => {
        // 管理画面からの取り込みは共通テンプレートとして登録する。
        await createEquipments(rows, null);
        await this.reload();
        this.noticeMessage = `${rows.length} 件のテンプレート機材を取り込みました。`;
        this.importPreview = null;
      });
    },

    // ---------------- バックアップ・復元 ----------------

    async connectDropbox() {
      this.errorMessage = '';
      try {
        // Dropboxの認可画面へ遷移する（このページを離れる）。
        await dropboxConnect();
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      }
    },

    async createBackup() {
      this.noticeMessage = '';
      await withSaving(this, async () => {
        const payload = await exportBackup();
        const filename = backupFilename(payload.created_at);
        await dropboxUpload(filename, JSON.stringify(payload));
        this.lastBackup = { filename, createdAt: payload.created_at, payload };
        this.noticeMessage = `バックアップ「${filename}」をDropboxへ保存しました。`;
        await this.refreshBackupList();
      });
    },

    /** Dropboxとは別に、作成直後のバックアップをローカルにも保存できるようにする。 */
    downloadLastBackup() {
      if (!this.lastBackup) return;
      const blob = new Blob([JSON.stringify(this.lastBackup.payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = this.lastBackup.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    async refreshBackupList() {
      await withSaving(this, async () => {
        this.backupList = await dropboxListBackups();
      });
    },

    async selectBackupFromDropbox(entry) {
      await withSaving(this, async () => {
        const payload = await dropboxDownloadJson(entry.path_lower ?? `/${entry.name}`);
        this.openRestorePreview(payload);
      });
    },

    /** Dropbox未接続時や手元にファイルがある場合の代替経路。 */
    async selectLocalBackupFile(event) {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      this.errorMessage = '';
      try {
        const payload = JSON.parse(await file.text());
        this.openRestorePreview(payload);
      } catch (error) {
        console.error(error);
        this.errorMessage = 'バックアップファイルを読み込めませんでした。JSON形式を確認してください。';
      }
    },

    openRestorePreview(payload) {
      if (payload?.schema_version !== 1) {
        this.errorMessage = 'このファイルはLoadSymのバックアップ形式ではありません。';
        return;
      }
      this.errorMessage = '';
      this.restoreConfirmText = '';
      this.restorePreview = { payload, summary: backupSummary(payload) };
    },

    /** 全テーブルを丸ごと洗い替える復元。取り消せないため、確認テキストの入力を必須にしてある。 */
    async confirmRestore() {
      if (this.restoreConfirmText !== '復元') return;
      await withSaving(this, async () => {
        const counts = await restoreBackup(this.restorePreview.payload);
        this.restorePreview = null;
        await this.reload();
        const summary = Object.entries(counts).map(([table, n]) => `${table}: ${n}件`).join(' / ');
        this.noticeMessage = `復元が完了しました（${summary}）。`;
      });
    }
  };
}

function nextSortOrder(categories) {
  const max = categories.reduce((total, category) => Math.max(total, category.sort_order), 0);
  return max + 10;
}
