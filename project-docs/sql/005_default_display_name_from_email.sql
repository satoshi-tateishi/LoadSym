-- LoadSym: ユーザーの表示名(profiles.display_name)の既定値を、メールアドレスの
-- ローカル部（@ より左）にする。
--
-- レイアウト一覧の「作成者」列と画面右上の名前は display_name を出しているが、
-- これまで display_name を設定する手段が Supabase ダッシュボードでの手入力しか
-- なかったため、実際にはロール名（管理者 / 編集者 / 閲覧者）が入っていた。
-- これでは同じロールの利用者を見分けられず、「誰が作った図か」が分からない。
--
-- メールアドレスは1人1つで必ず異なるため、ローカル部を既定値にすれば
-- 手入力なしで一意な表示名になる。あとから本人や管理者が読みやすい名前へ
-- 変更できるよう、display_name は引き続き自由に書き換えられる列のままにする
-- （変更UIは別途用意する）。
--
-- ローカル部が取れない場合（メール以外の手段で作成されたアカウントなど）は
-- null のままにする。呼び出し側の layout_owner_names() が「ユーザー」で補う。

-- 新規ユーザー: 作成時にローカル部を入れる。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(split_part(coalesce(new.email, ''), '@', 1), ''));
  return new;
end;
$$;

-- 既存ユーザー: 現在入っている値は全てダッシュボードでの手入力（ロール名）であり、
-- ユーザー本人が付けた名前ではないため、ここで一度ローカル部に揃える。
-- 表示名の変更UIができたあとは、この種の一括更新は行わないこと。
update public.profiles p
set display_name = split_part(u.email::text, '@', 1)
from auth.users u
where u.id = p.id
  and nullif(split_part(u.email::text, '@', 1), '') is not null;
