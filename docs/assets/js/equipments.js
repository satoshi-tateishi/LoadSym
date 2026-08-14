// equipments テーブルへのアクセスを集約する。
// ページ側から生の supabase を触らないための層。

import { supabase } from './supabase-client.js';

const COLUMNS =
  'id, user_id, name, category, width_mm, depth_mm, height_mm, weight_kg, color, note, sort_order';

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
  return data;
}

export async function createEquipment(values, userId) {
  const { data, error } = await supabase
    .from('equipments')
    .insert({ ...values, user_id: userId })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateEquipment(id, values) {
  const { data, error } = await supabase
    .from('equipments')
    .update(values)
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteEquipment(id) {
  const { error } = await supabase.from('equipments').delete().eq('id', id);
  if (error) throw error;
}

/** CSVインポート用の一括登録。件数制限トリガはDB側で効く。 */
export async function createEquipments(rows, userId) {
  const { data, error } = await supabase
    .from('equipments')
    .insert(rows.map((row) => ({ ...row, user_id: userId })))
    .select(COLUMNS);

  if (error) throw error;
  return data;
}
