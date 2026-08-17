// DBバックアップ・復元（Admin専用）のデータアクセス層。
//
// バックアップの読み取りは既存RLS（Adminはprofiles含む全テーブルを読める）の範囲内で
// 完結するため、クライアント側のSELECTだけで組み立てる。復元の書き込みはRLSを越えるため
// security definer RPC（009_backup_restore.sql の admin_restore_backup）に委ねる。

import { supabase } from './supabase-client.js';

export const BACKUP_SCHEMA_VERSION = 1;

// admin_restore_backup() の削除・挿入順（親→子）と揃えてある。
export const BACKUP_TABLES = [
  'equipment_categories', 'equipments', 'trucks', 'truck_obstacles',
  'layouts', 'layout_trucks', 'placements', 'profiles'
];

export async function exportBackup() {
  const tables = {};
  await Promise.all(BACKUP_TABLES.map(async (table) => {
    const { data, error } = await supabase.from(table).select('*');
    if (error) throw error;
    tables[table] = data ?? [];
  }));

  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    app: 'LoadSym',
    created_at: new Date().toISOString(),
    tables
  };
}

export async function restoreBackup(payload) {
  const { data, error } = await supabase.rpc('admin_restore_backup', { payload });
  if (error) throw error;
  return data;
}

/** テーブルごとの件数（復元前プレビュー・バックアップ後の確認どちらにも使う）。 */
export function backupSummary(payload) {
  const counts = {};
  for (const table of BACKUP_TABLES) {
    counts[table] = payload?.tables?.[table]?.length ?? 0;
  }
  return counts;
}

/** ローカル保存・Dropboxアップロードの両方で使うファイル名。 */
export function backupFilename(createdAtIso) {
  return `loadsym-backup-${createdAtIso.replace(/[:.]/g, '-')}.json`;
}
