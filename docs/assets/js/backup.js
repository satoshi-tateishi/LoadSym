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

/** 復元プレビュー・完了通知でテーブル名の代わりに表示する日本語ラベル。 */
const BACKUP_TABLE_LABELS = {
  equipment_categories: '機材カテゴリ',
  equipments: '機材',
  trucks: 'トラック',
  truck_obstacles: '障害物',
  layouts: 'レイアウト',
  layout_trucks: '使用トラック',
  placements: '配置',
  profiles: 'ユーザー'
};

export function backupTableLabel(table) {
  return BACKUP_TABLE_LABELS[table] ?? table;
}

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

/**
 * created_at（UTC ISO文字列）をJST（UTC+9固定。日本にサマータイムはない）の
 * 年/月/日/時刻に分解する。Dropboxの保存先を日付ごとのフォルダへ分けるのと、
 * 画面表示もJSTへ揃えるために使う。
 */
function jstParts(createdAtIso) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(createdAtIso)).map((part) => [part.type, part.value])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    time: `${parts.hour}${parts.minute}${parts.second}`
  };
}

/** Dropboxの保存先パス。`/YYYY/MM/DD/HHmmss.json`（JST）。フォルダはアップロード時に自動で作られる。 */
export function backupDropboxPath(createdAtIso) {
  const { year, month, day, time } = jstParts(createdAtIso);
  return `/${year}/${month}/${day}/${time}.json`;
}

/** ローカルダウンロード用のファイル名。Dropboxと違いフォルダを持てないため、日付も含める。 */
export function backupLocalFilename(createdAtIso) {
  const { year, month, day, time } = jstParts(createdAtIso);
  return `loadsym-backup-${year}${month}${day}-${time}.json`;
}

/** 画面表示用（JST）。 */
export function formatJst(createdAtIso) {
  const { year, month, day, time } = jstParts(createdAtIso);
  return `${year}-${month}-${day} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)} JST`;
}
