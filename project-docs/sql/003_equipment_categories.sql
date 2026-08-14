-- LoadSym: 機材カテゴリをマスタ化する。
--
-- これまで equipments.category は自由入力の text だった。表記ゆれ（「SP」「スピーカー」など）で
-- 絞り込みが効かなくなるため、Admin が管理するマスタテーブルに切り出して参照させる。
--
-- 削除は on delete restrict にする。使われているカテゴリを消せてしまうと、
-- 既存の機材の分類が黙って失われるため、先に付け替えさせる。
--
-- 既存データは名前の一致で移し、一致しないものは「その他」に寄せる。

create table public.equipment_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger equipment_categories_set_updated_at
  before update on public.equipment_categories
  for each row execute function public.set_updated_at();

-- 初期カテゴリ。舞台音響の現場でよく使う区分。並び順は後から画面で変えられる。
insert into public.equipment_categories (name, sort_order) values
  ('ミキシングコンソール', 10),
  ('スピーカー',           20),
  ('パワーアンプ',         30),
  ('ラック',               40),
  ('ケース',               50),
  ('スタンド',             60),
  ('その他',               70);


-- equipments を text から参照に置き換える
alter table public.equipments
  add column category_id uuid references public.equipment_categories(id) on delete restrict;

update public.equipments e
  set category_id = c.id
  from public.equipment_categories c
  where c.name = e.category;

update public.equipments
  set category_id = (select id from public.equipment_categories where name = 'その他')
  where category_id is null;

alter table public.equipments alter column category_id set not null;
alter table public.equipments drop column category;

create index equipments_category_id_idx on public.equipments (category_id);


-- RLS: 参照は有効なログインユーザー全員、更新はAdminのみ。
alter table public.equipment_categories enable row level security;

create policy equipment_categories_select
  on public.equipment_categories for select
  to authenticated
  using (public.current_user_role() is not null);

create policy equipment_categories_insert
  on public.equipment_categories for insert
  to authenticated
  with check (public.current_user_role() = 'Admin');

create policy equipment_categories_update
  on public.equipment_categories for update
  to authenticated
  using (public.current_user_role() = 'Admin')
  with check (public.current_user_role() = 'Admin');

create policy equipment_categories_delete
  on public.equipment_categories for delete
  to authenticated
  using (public.current_user_role() = 'Admin');
