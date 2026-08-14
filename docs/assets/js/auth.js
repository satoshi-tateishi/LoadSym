import { supabase } from './supabase-client.js';

export async function loginWithPassword(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function logout() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = './index.html';
    return null;
  }
  return session;
}

export async function getCurrentProfile() {
  const session = await getSession();
  if (!session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('role, display_name, disabled')
    .eq('id', session.user.id)
    .single();

  if (error) throw error;
  return data;
}

/** 機材・トラック・レイアウトを新規作成できるロールか。Viewerは閲覧のみ。 */
export function canEdit(profile) {
  return ['Admin', 'Editor'].includes(profile?.role);
}

/**
 * 既存データを編集できるか。作成者本人のみ（Adminでも他人のデータは編集不可）。
 * テンプレート（user_id が null）はAdminのみ。
 * この判定はUI表示のためのもので、権限の最終的な担保はRLS。
 */
export function canEditRecord(profile, session, ownerId) {
  if (!canEdit(profile)) return false;
  if (ownerId === null || ownerId === undefined) return profile.role === 'Admin';
  return ownerId === session?.user?.id;
}
