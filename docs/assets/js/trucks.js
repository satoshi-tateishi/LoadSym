// trucks / truck_obstacles テーブルへのアクセスを集約する。

import { supabase } from './supabase-client.js';

const COLUMNS =
  'id, user_id, name, bed_width_mm, bed_depth_mm, bed_height_mm, max_payload_kg, note, sort_order';
const OBSTACLE_COLUMNS = 'id, truck_id, label, x_mm, y_mm, width_mm, depth_mm, height_mm';

/** 読めるトラックをすべて取得する。障害物も同時に引く（1台あたり数件なので join で十分）。 */
export async function listTrucks() {
  const { data, error } = await supabase
    .from('trucks')
    .select(`${COLUMNS}, truck_obstacles (${OBSTACLE_COLUMNS})`)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

export async function createTruck(values, userId) {
  const { data, error } = await supabase
    .from('trucks')
    .insert({ ...values, user_id: userId })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateTruck(id, values) {
  const { data, error } = await supabase
    .from('trucks')
    .update(values)
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTruck(id) {
  const { error } = await supabase.from('trucks').delete().eq('id', id);
  if (error) throw error;
}

/**
 * 障害物をまとめて置き換える。1台あたり数件しかないため、
 * 差分を取らず「全削除して入れ直す」ほうが単純で取りこぼしがない。
 */
export async function replaceObstacles(truckId, obstacles) {
  const { error: deleteError } = await supabase
    .from('truck_obstacles')
    .delete()
    .eq('truck_id', truckId);
  if (deleteError) throw deleteError;

  if (obstacles.length === 0) return [];

  const { data, error } = await supabase
    .from('truck_obstacles')
    .insert(obstacles.map((obstacle) => ({ ...obstacle, truck_id: truckId })))
    .select(OBSTACLE_COLUMNS);

  if (error) throw error;
  return data;
}

export async function createTrucks(rows, userId) {
  const { data, error } = await supabase
    .from('trucks')
    .insert(rows.map((row) => ({ ...row, user_id: userId })))
    .select(COLUMNS);

  if (error) throw error;
  return data;
}
