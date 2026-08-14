// 管理画面（Admin専用）。ユーザー管理 / カテゴリ管理 / テンプレート機材 / CSVインポート。
//
// ページ側でもロールを見てリダイレクトするが、これはURL直打ちへの目隠しにすぎない。
// 実際の権限はすべてRLSとRPC内のチェックが担保している。

import { initAuthenticatedPage } from '../layout.js';
import { translateError } from '../error-messages.js';
import { listUsers, updateUser } from '../admin-users.js';
import { listCategories, createCategory, updateCategory, deleteCategory, countEquipmentsByCategory }
  from '../categories.js';
import { listEquipments, createEquipment, updateEquipment, deleteEquipment, createEquipments }
  from '../equipments.js';
import { readTextFile, parseCsv, toEquipmentRows, EQUIPMENT_CSV_HEADERS } from '../csv.js';

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

    async init() {
      const context = await initAuthenticatedPage();
      if (!context) return;

      this.session = context.session;
      this.profile = context.profile;

      if (context.profile?.role !== 'Admin') {
        window.location.href = './simulator.html';
        return;
      }

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
      this.saving = true;
      this.errorMessage = '';
      this.noticeMessage = '';
      try {
        await updateUser(user.id, values);
        this.users = await listUsers();
        this.noticeMessage = `${user.email} を更新しました。`;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
        // 失敗したときに画面の見た目だけ変わったままにならないよう、必ず取り直す。
        this.users = await listUsers();
      } finally {
        this.saving = false;
      }
    },

    // ---------------- カテゴリ管理 ----------------

    categoryCount(category) {
      return this.categoryCounts.get(category.id) ?? 0;
    },

    openCategoryForm(category) {
      this.categoryForm = category
        ? { ...category }
        : { id: null, name: '', sort_order: nextSortOrder(this.categories) };
    },

    async saveCategory() {
      this.saving = true;
      this.errorMessage = '';
      try {
        const form = this.categoryForm;
        const values = { name: form.name.trim(), sort_order: form.sort_order ?? 0 };

        if (form.id) await updateCategory(form.id, values);
        else await createCategory(values);

        await this.reload();
        this.categoryForm = null;
        this.noticeMessage = 'カテゴリを保存しました。';
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async removeCategory() {
      const used = this.categoryCount(this.categoryForm);
      if (used > 0) {
        this.errorMessage = `このカテゴリは ${used} 件の機材に使われているため削除できません。先に別のカテゴリへ移してください。`;
        return;
      }
      if (!window.confirm(`カテゴリ「${this.categoryForm.name}」を削除しますか？`)) return;

      this.saving = true;
      this.errorMessage = '';
      try {
        await deleteCategory(this.categoryForm.id);
        await this.reload();
        this.categoryForm = null;
        this.noticeMessage = 'カテゴリを削除しました。';
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    /** 並び順を1つ入れ替える。sort_order を直接編集させるより誤りが少ない。 */
    async moveCategory(category, direction) {
      const index = this.categories.findIndex((item) => item.id === category.id);
      const swapWith = this.categories[index + direction];
      if (!swapWith) return;

      this.saving = true;
      this.errorMessage = '';
      try {
        await updateCategory(category.id, { sort_order: swapWith.sort_order });
        await updateCategory(swapWith.id, { sort_order: category.sort_order });
        await this.reload();
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    // ---------------- テンプレート機材 ----------------

    get defaultCategoryId() {
      const fallback = this.categories.find((category) => category.name === 'その他');
      return (fallback ?? this.categories[0])?.id ?? null;
    },

    openEquipmentForm(item) {
      this.equipmentForm = item
        ? { ...item }
        : {
            id: null,
            name: '',
            category_id: this.defaultCategoryId,
            width_mm: 600,
            depth_mm: 400,
            height_mm: 500,
            weight_kg: 0,
            color: '#64748b'
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

        // 管理画面から作るものは常に共通テンプレート（user_id = null）。
        if (form.id) await updateEquipment(form.id, values);
        else await createEquipment(values, null);

        await this.reload();
        this.equipmentForm = null;
        this.noticeMessage = 'テンプレート機材を保存しました。';
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    async removeEquipment() {
      if (!window.confirm(`「${this.equipmentForm.name}」を削除しますか？`)) return;
      this.saving = true;
      this.errorMessage = '';
      try {
        await deleteEquipment(this.equipmentForm.id);
        await this.reload();
        this.equipmentForm = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    },

    // ---------------- CSVインポート ----------------

    get csvHeaderSample() {
      return EQUIPMENT_CSV_HEADERS.join(',');
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

      this.saving = true;
      this.errorMessage = '';
      try {
        // 管理画面からの取り込みは共通テンプレートとして登録する。
        await createEquipments(rows, null);
        await this.reload();
        this.noticeMessage = `${rows.length} 件のテンプレート機材を取り込みました。`;
        this.importPreview = null;
      } catch (error) {
        console.error(error);
        this.errorMessage = translateError(error);
      } finally {
        this.saving = false;
      }
    }
  };
}

function nextSortOrder(categories) {
  const max = categories.reduce((total, category) => Math.max(total, category.sort_order), 0);
  return max + 10;
}
