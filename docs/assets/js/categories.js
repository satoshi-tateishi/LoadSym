// equipment_categories（機材カテゴリのマスタ）へのアクセス。
// 参照は全ロール、作成・更新・削除はAdminのみ（RLSで担保）。

import { supabase } from './supabase-client.js';

const COLUMNS = 'id, name, sort_order';

export async function listCategories() {
  const { data, error } = await supabase
    .from('equipment_categories')
    .select(COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

export async function createCategory(values) {
  const { data, error } = await supabase
    .from('equipment_categories')
    .insert(values)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateCategory(id, values) {
  const { data, error } = await supabase
    .from('equipment_categories')
    .update(values)
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCategory(id) {
  const { error } = await supabase.from('equipment_categories').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 並び順を id の配列どおりに振り直す。
 * sort_order は 10 刻みで採番する（後から手で間に差し込めるように）。
 * 値が変わらない行は更新しない。
 *
 * @param {Array<string>} orderedIds 表示順に並べたカテゴリid
 */
export async function updateCategoryOrder(orderedIds) {
  const { data: current, error } = await supabase
    .from('equipment_categories')
    .select('id, sort_order');
  if (error) throw error;

  const currentById = new Map(current.map((row) => [row.id, row.sort_order]));
  const changed = orderedIds
    .map((id, index) => ({ id, sortOrder: (index + 1) * 10 }))
    .filter((row) => currentById.get(row.id) !== row.sortOrder);

  for (const row of changed) {
    const { error: updateError } = await supabase
      .from('equipment_categories')
      .update({ sort_order: row.sortOrder })
      .eq('id', row.id);
    if (updateError) throw updateError;
  }

  return changed.length;
}

/** カテゴリごとの機材数。削除してよいかの判断と、管理画面の表示に使う。 */
export async function countEquipmentsByCategory() {
  const { data, error } = await supabase.from('equipments').select('category_id');
  if (error) throw error;

  const counts = new Map();
  for (const row of data) {
    counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
  }
  return counts;
}
