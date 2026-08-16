// layouts / layout_trucks / placements へのアクセスを集約する。
//
// 保存は「レイアウト行をupsertし、配下のlayout_trucksを全削除して入れ直す」方式。
// placementsはlayout_trucksへのon delete cascadeで一緒に消える。
// 差分更新のほうが通信は減るが、連鎖押し出しで多数の座標が同時に変わるため
// 差分を組み立てる手間とバグの余地に見合わない。

import { supabase } from './supabase-client.js';

/**
 * 一覧に出す最小限の情報。配置は一切引かない（一覧はトラック名までしか出さない）。
 * 一覧に十数件並んだときに、全配置を引くと無駄が大きいため。
 */
export async function listLayouts() {
  const { data, error } = await supabase
    .from('layouts')
    .select(
      'id, user_id, name, note, created_at, updated_at, layout_trucks (id, slot, truck_snapshot)'
    )
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function renameLayout(id, name, note) {
  const { error } = await supabase.from('layouts').update({ name, note }).eq('id', id);
  if (error) throw error;
}

/** 作成者の表示名。profilesは直接読めないためRPC経由で最小限だけ取る。 */
export async function listOwnerNames() {
  const { data, error } = await supabase.rpc('layout_owner_names');
  if (error) throw error;
  return new Map(data.map((row) => [row.user_id, row.display_name]));
}

/** レイアウト1件を配置まで含めて読み込む。 */
export async function loadLayout(id) {
  const { data, error } = await supabase
    .from('layouts')
    .select(
      `id, user_id, name, note, clearance_mm,
       layout_trucks (
         id, slot, truck_id, truck_snapshot,
         placements (id, equipment_id, equipment_snapshot, x_mm, y_mm, rotation, stack_level)
       )`
    )
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteLayout(id) {
  const { error } = await supabase.from('layouts').delete().eq('id', id);
  if (error) throw error;
}

/**
 * レイアウトを保存する。idを渡せば上書き、渡さなければ新規作成。
 * @param {{id?: string, name: string, note?: string, clearanceMm: number, slots: Array}} layout
 * @param {string} userId
 * @returns {string} 保存したレイアウトのid
 */
export async function saveLayout(layout, userId) {
  const layoutId = layout.id ? await updateLayoutRow(layout) : await insertLayoutRow(layout, userId);

  // 既存の構成を落としてから入れ直す（placementsはcascadeで消える）。
  const { error: clearError } = await supabase
    .from('layout_trucks')
    .delete()
    .eq('layout_id', layoutId);
  if (clearError) throw clearError;

  const usableSlots = layout.slots.filter((slot) => slot && slot.truck);
  if (usableSlots.length === 0) return layoutId;

  const { data: insertedSlots, error: slotError } = await supabase
    .from('layout_trucks')
    .insert(
      usableSlots.map((slot) => ({
        layout_id: layoutId,
        slot: slot.slot,
        truck_id: slot.truckId ?? null,
        // 障害物もスナップショットに含める。参照元のトラックが編集されても
        // 保存時の図がそのまま再現できることがスナップショットを持つ目的なので、
        // 荷台の寸法だけでは足りない。
        truck_snapshot: { ...slot.truck, obstacles: slot.obstacles ?? [] }
      }))
    )
    .select('id, slot');
  if (slotError) throw slotError;

  const slotIdBySlot = new Map(insertedSlots.map((row) => [row.slot, row.id]));
  const placementRows = usableSlots.flatMap((slot) =>
    slot.placements.map((placement) => ({
      layout_truck_id: slotIdBySlot.get(slot.slot),
      equipment_id: placement.equipmentId ?? null,
      equipment_snapshot: placement.snapshot,
      x_mm: Math.round(placement.x),
      y_mm: Math.round(placement.y),
      rotation: placement.rotation,
      stack_level: placement.stackLevel ?? 0
    }))
  );

  if (placementRows.length > 0) {
    const { error: placementError } = await supabase.from('placements').insert(placementRows);
    if (placementError) throw placementError;
  }

  return layoutId;
}

async function insertLayoutRow(layout, userId) {
  const { data, error } = await supabase
    .from('layouts')
    .insert({
      name: layout.name,
      note: layout.note ?? null,
      clearance_mm: layout.clearanceMm,
      user_id: userId
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function updateLayoutRow(layout) {
  const { data, error } = await supabase
    .from('layouts')
    .update({ name: layout.name, note: layout.note ?? null, clearance_mm: layout.clearanceMm })
    .eq('id', layout.id)
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

/** DBの行を画面が扱う slot の形へ変換する。 */
export function toSlots(layoutRow) {
  return (layoutRow.layout_trucks ?? [])
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((row) => ({
      id: row.id,
      slot: row.slot,
      truckId: row.truck_id,
      truck: row.truck_snapshot,
      obstacles: row.truck_snapshot.obstacles ?? [],
      placements: (row.placements ?? []).map((placement) => ({
        id: placement.id,
        equipmentId: placement.equipment_id,
        snapshot: placement.equipment_snapshot,
        x: placement.x_mm,
        y: placement.y_mm,
        rotation: placement.rotation,
        stackLevel: placement.stack_level
      }))
    }));
}
