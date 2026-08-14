-- LoadSym: パイロット版 初期スキーマ
-- Supabase SQL Editorで、このファイルの内容をそのまま貼り付けて実行してください。
--
-- 設計の要点:
--  * テンプレート（全ユーザー共通）とユーザーデータを同一テーブルに同居させ、
--    user_id が null かどうかで区別する。
--  * 社内ツールであり「他人の組み方を参考にできる」ことに価値があるため、
--    参照は全ロールに開き、書き込みだけを所有者に絞る。
--  * ロール判定は security definer 関数 current_user_role() に集約する。
--    RLSポリシー内から profiles を直接参照すると再帰するため。
--  * 高さ関連のカラム（stackable / max_stack_load_kg / stack_level /
--    stack_parent_id）はパイロット版では使わない。将来の2.5D（段積み）対応時に
--    スキーマ変更なしで移行できるよう、最初から用意しておく。

create extension if not exists pgcrypto;


-- =========================================================
-- 共通トリガ関数
-- =========================================================

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =========================================================
-- profiles（ロール管理）
-- =========================================================
-- サインアップ画面は存在しないため、ユーザー作成は管理者が
-- Supabaseダッシュボード（Authentication > Users）から行う。
-- ユーザーの削除にはサービスロールキーが必要なため、アプリからは
-- disabled フラグの切り替えのみを行い、削除の代替とする。

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'Viewer'
    check (role in ('Admin', 'Editor', 'Viewer')),
  display_name text,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ロール判定用ヘルパー。security definerによりRLSを経由せず参照できる（再帰防止）。
-- 無効化されたユーザーはroleに関わらずnull（無権限）を返すため、
-- disabled を立てるだけで、この関数で判定している全ポリシーが一斉に閉じる。
create function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when disabled then null else role end
  from public.profiles where id = auth.uid();
$$;

alter table public.profiles enable row level security;

create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- PostgreSQLのRLSでは、UPDATEの対象行は「SELECTポリシーでも可視であること」が
-- 前提になる。Adminが他人の行を更新できるよう、Admin用のSELECTを追加する。
create policy profiles_select_admin
  on public.profiles for select
  to authenticated
  using (public.current_user_role() = 'Admin');

-- 自分自身の行は対象外（id <> auth.uid()）。これによりAdmin自身の権限降格・
-- 無効化をRLSレベルで禁止し、「最後の1人のAdmin」がUI経由で0人になることを
-- 構造的に防ぐ。
create policy profiles_update_admin
  on public.profiles for update
  to authenticated
  using (public.current_user_role() = 'Admin' and id <> auth.uid())
  with check (public.current_user_role() = 'Admin' and id <> auth.uid());


-- =========================================================
-- equipments（機材）
-- =========================================================

create table public.equipments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,  -- null = 共通テンプレート
  name text not null check (length(btrim(name)) > 0),
  category text not null default 'その他',
  width_mm integer not null check (width_mm > 0 and width_mm <= 20000),
  depth_mm integer not null check (depth_mm > 0 and depth_mm <= 20000),
  height_mm integer not null check (height_mm > 0 and height_mm <= 20000),
  weight_kg numeric(8,2) not null default 0 check (weight_kg >= 0),
  color text not null default '#64748b' check (color ~ '^#[0-9a-fA-F]{6}$'),
  note text,
  -- 将来の2.5D（段積み）用。パイロット版では未使用。
  stackable boolean not null default false,
  max_stack_load_kg numeric(8,2) check (max_stack_load_kg is null or max_stack_load_kg >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index equipments_user_id_idx on public.equipments (user_id);

create trigger equipments_set_updated_at
  before update on public.equipments
  for each row execute function public.set_updated_at();


-- =========================================================
-- trucks（トラック）
-- =========================================================

create table public.trucks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,  -- null = 共通テンプレート
  name text not null check (length(btrim(name)) > 0),
  bed_width_mm integer not null check (bed_width_mm > 0 and bed_width_mm <= 20000),
  bed_depth_mm integer not null check (bed_depth_mm > 0 and bed_depth_mm <= 20000),
  bed_height_mm integer not null check (bed_height_mm > 0 and bed_height_mm <= 20000),
  max_payload_kg numeric(8,2) check (max_payload_kg is null or max_payload_kg > 0),  -- null = 制限なし
  note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trucks_user_id_idx on public.trucks (user_id);

create trigger trucks_set_updated_at
  before update on public.trucks
  for each row execute function public.set_updated_at();


-- =========================================================
-- truck_obstacles（荷台内の配置不可エリア）
-- =========================================================
-- タイヤハウスや柱など。荷台の左前を原点とする矩形で表す。
-- シミュレーター上では不動として扱い、機材の押し出し先にはできない。

create table public.truck_obstacles (
  id uuid primary key default gen_random_uuid(),
  truck_id uuid not null references public.trucks(id) on delete cascade,
  label text,
  x_mm integer not null check (x_mm >= 0),
  y_mm integer not null check (y_mm >= 0),
  width_mm integer not null check (width_mm > 0),
  depth_mm integer not null check (depth_mm > 0),
  height_mm integer check (height_mm is null or height_mm > 0),  -- null = 床から天井まで
  created_at timestamptz not null default now()
);

create index truck_obstacles_truck_id_idx on public.truck_obstacles (truck_id);


-- =========================================================
-- layouts（積み込み計画）
-- =========================================================

create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index layouts_user_id_idx on public.layouts (user_id);

create trigger layouts_set_updated_at
  before update on public.layouts
  for each row execute function public.set_updated_at();


-- =========================================================
-- layout_trucks（レイアウトに読み込んだトラック / 最大3台）
-- =========================================================
-- truck_snapshot に読み込み時点の寸法・名称を保存する。参照先のトラックが
-- 削除・変更されても、保存済みの図が壊れないようにするため。

create table public.layout_trucks (
  id uuid primary key default gen_random_uuid(),
  layout_id uuid not null references public.layouts(id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  truck_id uuid references public.trucks(id) on delete set null,
  truck_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (layout_id, slot)
);

create index layout_trucks_layout_id_idx on public.layout_trucks (layout_id);


-- =========================================================
-- placements（機材の配置）
-- =========================================================

create table public.placements (
  id uuid primary key default gen_random_uuid(),
  layout_truck_id uuid not null references public.layout_trucks(id) on delete cascade,
  equipment_id uuid references public.equipments(id) on delete set null,
  equipment_snapshot jsonb not null,
  x_mm integer not null,   -- 荷台の左前を原点とする位置。はみ出しを保存できるよう負値も許す
  y_mm integer not null,
  rotation smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  -- 将来の2.5D（段積み）用。パイロット版では常に 0 / null。
  stack_level smallint not null default 0 check (stack_level >= 0),
  stack_parent_id uuid references public.placements(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index placements_layout_truck_id_idx on public.placements (layout_truck_id);

create trigger placements_set_updated_at
  before update on public.placements
  for each row execute function public.set_updated_at();


-- =========================================================
-- 登録数制限（機材100個 / トラック5台）
-- =========================================================
-- クライアント側のチェックだけに頼らず、DB層で担保する。
-- テンプレート（user_id is null）は制限の対象外。
-- UPDATEでuser_idを付け替えて制限を回避されないよう、その場合も検査する。

create function public.enforce_equipment_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if new.user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.user_id is not distinct from old.user_id then
    return new;
  end if;

  select count(*) into v_count from public.equipments where user_id = new.user_id;
  if v_count >= 100 then
    raise exception '登録できる機材は1ユーザーあたり100個までです（現在%個）', v_count;
  end if;
  return new;
end;
$$;

create trigger equipments_enforce_limit
  before insert or update of user_id on public.equipments
  for each row execute function public.enforce_equipment_limit();

create function public.enforce_truck_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if new.user_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.user_id is not distinct from old.user_id then
    return new;
  end if;

  select count(*) into v_count from public.trucks where user_id = new.user_id;
  if v_count >= 5 then
    raise exception '登録できるトラックは1ユーザーあたり5台までです（現在%台）', v_count;
  end if;
  return new;
end;
$$;

create trigger trucks_enforce_limit
  before insert or update of user_id on public.trucks
  for each row execute function public.enforce_truck_limit();


-- =========================================================
-- 書き込み権限のヘルパー関数
-- =========================================================
-- 子テーブル（truck_obstacles / layout_trucks / placements）のポリシーから、
-- 親の所有者を辿って判定するために使う。ポリシー内で親テーブルを直接
-- サブクエリすると親側のRLSが二重に効いて分かりにくくなるため、
-- security definer 関数に閉じ込めて意図を1か所に集約する。

create function public.can_write_truck(p_truck_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trucks t
    where t.id = p_truck_id
      and (
        (t.user_id = auth.uid() and public.current_user_role() in ('Admin', 'Editor'))
        or (t.user_id is null and public.current_user_role() = 'Admin')
      )
  );
$$;

-- レイアウトは作成者のみが編集できる（Adminも他人のレイアウトは編集不可）。
create function public.can_write_layout(p_layout_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.layouts l
    where l.id = p_layout_id
      and l.user_id = auth.uid()
      and public.current_user_role() in ('Admin', 'Editor')
  );
$$;

create function public.can_write_layout_truck(p_layout_truck_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_write_layout(
    (select lt.layout_id from public.layout_trucks lt where lt.id = p_layout_truck_id)
  );
$$;


-- =========================================================
-- RLS
-- =========================================================
-- 方針:
--   SELECT ... 有効なログインユーザーなら、テンプレートも他人のデータも読める。
--   書き込み ... 自分のデータは Admin/Editor、テンプレートは Admin のみ。
--                Viewer はどの書き込みポリシーにも合致しないため一切書き込めない。

alter table public.equipments enable row level security;

create policy equipments_select
  on public.equipments for select
  to authenticated
  using (public.current_user_role() is not null);

create policy equipments_insert_own
  on public.equipments for insert
  to authenticated
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy equipments_update_own
  on public.equipments for update
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid())
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy equipments_delete_own
  on public.equipments for delete
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy equipments_insert_template
  on public.equipments for insert
  to authenticated
  with check (public.current_user_role() = 'Admin' and user_id is null);

create policy equipments_update_template
  on public.equipments for update
  to authenticated
  using (public.current_user_role() = 'Admin' and user_id is null)
  with check (public.current_user_role() = 'Admin' and user_id is null);

create policy equipments_delete_template
  on public.equipments for delete
  to authenticated
  using (public.current_user_role() = 'Admin' and user_id is null);


alter table public.trucks enable row level security;

create policy trucks_select
  on public.trucks for select
  to authenticated
  using (public.current_user_role() is not null);

create policy trucks_insert_own
  on public.trucks for insert
  to authenticated
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy trucks_update_own
  on public.trucks for update
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid())
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy trucks_delete_own
  on public.trucks for delete
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy trucks_insert_template
  on public.trucks for insert
  to authenticated
  with check (public.current_user_role() = 'Admin' and user_id is null);

create policy trucks_update_template
  on public.trucks for update
  to authenticated
  using (public.current_user_role() = 'Admin' and user_id is null)
  with check (public.current_user_role() = 'Admin' and user_id is null);

create policy trucks_delete_template
  on public.trucks for delete
  to authenticated
  using (public.current_user_role() = 'Admin' and user_id is null);


alter table public.truck_obstacles enable row level security;

create policy truck_obstacles_select
  on public.truck_obstacles for select
  to authenticated
  using (public.current_user_role() is not null);

create policy truck_obstacles_insert
  on public.truck_obstacles for insert
  to authenticated
  with check (public.can_write_truck(truck_id));

create policy truck_obstacles_update
  on public.truck_obstacles for update
  to authenticated
  using (public.can_write_truck(truck_id))
  with check (public.can_write_truck(truck_id));

create policy truck_obstacles_delete
  on public.truck_obstacles for delete
  to authenticated
  using (public.can_write_truck(truck_id));


alter table public.layouts enable row level security;

create policy layouts_select
  on public.layouts for select
  to authenticated
  using (public.current_user_role() is not null);

create policy layouts_insert_own
  on public.layouts for insert
  to authenticated
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy layouts_update_own
  on public.layouts for update
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid())
  with check (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());

create policy layouts_delete_own
  on public.layouts for delete
  to authenticated
  using (public.current_user_role() in ('Admin', 'Editor') and user_id = auth.uid());


alter table public.layout_trucks enable row level security;

create policy layout_trucks_select
  on public.layout_trucks for select
  to authenticated
  using (public.current_user_role() is not null);

create policy layout_trucks_insert
  on public.layout_trucks for insert
  to authenticated
  with check (public.can_write_layout(layout_id));

create policy layout_trucks_update
  on public.layout_trucks for update
  to authenticated
  using (public.can_write_layout(layout_id))
  with check (public.can_write_layout(layout_id));

create policy layout_trucks_delete
  on public.layout_trucks for delete
  to authenticated
  using (public.can_write_layout(layout_id));


alter table public.placements enable row level security;

create policy placements_select
  on public.placements for select
  to authenticated
  using (public.current_user_role() is not null);

create policy placements_insert
  on public.placements for insert
  to authenticated
  with check (public.can_write_layout_truck(layout_truck_id));

create policy placements_update
  on public.placements for update
  to authenticated
  using (public.can_write_layout_truck(layout_truck_id))
  with check (public.can_write_layout_truck(layout_truck_id));

create policy placements_delete
  on public.placements for delete
  to authenticated
  using (public.can_write_layout_truck(layout_truck_id));


-- =========================================================
-- Admin向けユーザー一覧RPC
-- =========================================================
-- profilesにはemailを持たないためauth.usersと結合する必要があるが、
-- auth.usersはPostgRESTに公開されておらずクライアントから直接参照できない。
-- security definerで結合し、関数内で呼び出し元がAdminであることを明示的に確認する。

create function public.admin_list_users()
returns table (
  id uuid,
  email text,
  role text,
  disabled boolean,
  display_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- RETURNS TABLEの列名と衝突して曖昧参照になるため、必ず別名で修飾する。
  if (select p.role from public.profiles p where p.id = auth.uid()) is distinct from 'Admin' then
    raise exception 'not authorized';
  end if;

  return query
    select p.id, u.email::text, p.role, p.disabled, p.display_name, p.created_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.created_at asc;
end;
$$;

grant execute on function public.admin_list_users() to authenticated;


-- =========================================================
-- レイアウト一覧に作成者名を出すためのRPC
-- =========================================================
-- 「他のユーザーのレイアウト」表に作成者を表示したいが、profilesの参照は
-- 自分の行とAdminのみに絞ってある（メールアドレス等の露出を避けるため）。
-- 表示名だけを返す関数を用意して、必要最小限の情報だけを公開する。

create function public.layout_owner_names()
returns table (
  user_id uuid,
  display_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, coalesce(p.display_name, 'ユーザー')
  from public.profiles p
  where public.current_user_role() is not null
    and exists (select 1 from public.layouts l where l.user_id = p.id);
$$;

grant execute on function public.layout_owner_names() to authenticated;
