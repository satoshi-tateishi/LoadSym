// equipments テーブルへのアクセスを集約する。
// ページ側から生の supabase を触らないための層。

import { supabase } from './supabase-client.js';

// カテゴリ名は毎回結合して取る。一覧の絞り込みと表示で必ず使うため。
const COLUMNS =
  'id, user_id, name, category_id, width_mm, depth_mm, height_mm, weight_kg, color, note, sort_order,' +
  ' equipment_categories (id, name, sort_order)';

/**
 * 読める機材をすべて取得する（RLSにより、テンプレート・自分・他ユーザーのすべてが返る）。
 * 呼び出し側で user_id を見て3セクションに振り分ける。
 */
export async function listEquipments() {
  const { data, error } = await supabase
    .from('equipments')
    .select(COLUMNS)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw error;
  return data.map(withCategoryName);
}

/** 結合したカテゴリを画面が使いやすい形（categoryName）に平すヘルパー。 */
export function withCategoryName(equipment) {
  return { ...equipment, categoryName: equipment.equipment_categories?.name ?? '未分類' };
}

export async function createEquipment(values, userId) {
  const { data, error } = await supabase
    .from('equipments')
    .insert({ ...values, user_id: userId })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return withCategoryName(data);
}

export async function updateEquipment(id, values) {
  const { data, error } = await supabase
    .from('equipments')
    .update(values)
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return withCategoryName(data);
}

export async function deleteEquipment(id) {
  const { error } = await supabase.from('equipments').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 並び順を id の配列どおりに振り直す。
 * sort_order は 10 刻みで採番する（後から手で間に差し込めるように）。
 * 渡された id の行だけを読み書きするので、対象外の機材には触れない。
 *
 * @param {Array<string>} orderedIds 表示順に並べた機材id
 * @returns {number} 実際に更新した行数
 */
export async function updateEquipmentOrder(orderedIds) {
  const { data: current, error } = await supabase
    .from('equipments')
    .select('id, sort_order')
    .in('id', orderedIds);
  if (error) throw error;

  const currentById = new Map(current.map((row) => [row.id, row.sort_order]));
  const changed = orderedIds
    .map((id, index) => ({ id, sortOrder: (index + 1) * 10 }))
    .filter((row) => currentById.get(row.id) !== row.sortOrder);

  for (const row of changed) {
    const { error: updateError } = await supabase
      .from('equipments')
      .update({ sort_order: row.sortOrder })
      .eq('id', row.id);
    if (updateError) throw updateError;
  }

  return changed.length;
}

/** CSVインポート用の一括登録。件数制限トリガはDB側で効く。 */
export async function createEquipments(rows, userId) {
  const { data, error } = await supabase
    .from('equipments')
    .insert(rows.map((row) => ({ ...row, user_id: userId })))
    .select(COLUMNS);

  if (error) throw error;
  return data.map(withCategoryName);
}
