// Admin専用のユーザー管理。
//
// auth.users の email は PostgREST から参照できないため、一覧は security definer の
// RPC 経由で取る。ロール変更・無効化は profiles への通常のUPDATEで、
// 「Adminのみ・自分以外」という制約はRLS側（profiles_update_admin）が担保する。

import { supabase } from './supabase-client.js';

export async function listUsers() {
  const { data, error } = await supabase.rpc('admin_list_users');
  if (error) throw error;
  return data;
}

export async function updateUser(id, values) {
  const { data, error } = await supabase
    .from('profiles')
    .update(values)
    .eq('id', id)
    .select('id, role, display_name, disabled');

  if (error) throw error;

  // RLSで弾かれた場合、エラーではなく0件更新として返る（自分自身の行を更新しようとしたときなど）。
  // 黙って成功したように見えるのを防ぐため、ここで明示的に失敗にする。
  if (data.length === 0) {
    throw new Error('この行は更新できませんでした（自分自身のロールは変更できません）。');
  }
  return data[0];
}
