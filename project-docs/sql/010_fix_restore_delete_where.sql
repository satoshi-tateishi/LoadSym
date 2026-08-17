-- LoadSym: admin_restore_backup() のDELETEにWHERE句を付ける。
--
-- SupabaseはWHERE句のない全件DELETE/UPDATEを事故防止のためブロックしており
-- （実行すると「DELETE requires a WHERE clause」で失敗する）、この保護は
-- security definer関数の中で実行した場合も働く。復元は仕様上「全件を洗い替える」
-- ための意図的な全件削除なので、`where true`を付けて明示的な全件削除であることを示す。
-- 動作は009_backup_restore.sqlのときと変わらない（削除・挿入の順序もそのまま）。

create or replace function public.admin_restore_backup(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
begin
  if (select p.role from public.profiles p where p.id = auth.uid()) is distinct from 'Admin' then
    raise exception 'not authorized';
  end if;

  if (payload->>'schema_version') is distinct from '1' then
    raise exception 'バックアップのschema_versionが不正です（%）', payload->>'schema_version';
  end if;

  -- 子 → 親の順で全件削除する（FK制約に沿う）。`where true`はSupabaseの
  -- WHERE句なしDELETE保護を満たすためのもので、実質は全件削除。
  delete from public.placements where true;
  delete from public.layout_trucks where true;
  delete from public.layouts where true;
  delete from public.truck_obstacles where true;
  delete from public.trucks where true;
  delete from public.equipments where true;
  delete from public.equipment_categories where true;

  -- 親 → 子の順で復元する。UUID・created_at・updated_atはバックアップ時点の値をそのまま使う
  -- （set_updated_atはbefore updateトリガのためINSERTには効かない）。
  -- 登録数の上限トリガ（equipments_enforce_limit等）はbefore insertのROWトリガなので、
  -- 同一INSERT文の中でも直前までに挿入済みの行を正しく数える。バックアップ時点で
  -- 上限を超えていない以上、復元時にブロックされることはない。

  insert into public.equipment_categories
    (id, name, sort_order, default_color, created_at, updated_at)
  select * from jsonb_to_recordset(payload->'tables'->'equipment_categories') as t(
    id uuid, name text, sort_order integer, default_color text,
    created_at timestamptz, updated_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('equipment_categories', v_n);

  insert into public.equipments
    (id, user_id, name, category_id, width_mm, depth_mm, height_mm, weight_kg, color, note,
     stackable, max_stack_load_kg, shape, sort_order, created_at, updated_at)
  select * from jsonb_to_recordset(payload->'tables'->'equipments') as t(
    id uuid, user_id uuid, name text, category_id uuid, width_mm integer, depth_mm integer,
    height_mm integer, weight_kg numeric(8,2), color text, note text,
    stackable boolean, max_stack_load_kg numeric(8,2), shape jsonb, sort_order integer,
    created_at timestamptz, updated_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('equipments', v_n);

  insert into public.trucks
    (id, user_id, name, bed_width_mm, bed_depth_mm, bed_height_mm, max_payload_kg, note,
     sort_order, created_at, updated_at)
  select * from jsonb_to_recordset(payload->'tables'->'trucks') as t(
    id uuid, user_id uuid, name text, bed_width_mm integer, bed_depth_mm integer,
    bed_height_mm integer, max_payload_kg numeric(8,2), note text, sort_order integer,
    created_at timestamptz, updated_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('trucks', v_n);

  insert into public.truck_obstacles
    (id, truck_id, label, x_mm, y_mm, width_mm, depth_mm, height_mm, created_at)
  select * from jsonb_to_recordset(payload->'tables'->'truck_obstacles') as t(
    id uuid, truck_id uuid, label text, x_mm integer, y_mm integer, width_mm integer,
    depth_mm integer, height_mm integer, created_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('truck_obstacles', v_n);

  insert into public.layouts
    (id, user_id, name, note, clearance_mm, created_at, updated_at)
  select * from jsonb_to_recordset(payload->'tables'->'layouts') as t(
    id uuid, user_id uuid, name text, note text, clearance_mm smallint,
    created_at timestamptz, updated_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('layouts', v_n);

  insert into public.layout_trucks
    (id, layout_id, slot, truck_id, truck_snapshot, created_at)
  select * from jsonb_to_recordset(payload->'tables'->'layout_trucks') as t(
    id uuid, layout_id uuid, slot smallint, truck_id uuid, truck_snapshot jsonb,
    created_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('layout_trucks', v_n);

  insert into public.placements
    (id, layout_truck_id, equipment_id, equipment_snapshot, x_mm, y_mm, rotation,
     stack_level, stack_parent_id, created_at, updated_at)
  select * from jsonb_to_recordset(payload->'tables'->'placements') as t(
    id uuid, layout_truck_id uuid, equipment_id uuid, equipment_snapshot jsonb,
    x_mm integer, y_mm integer, rotation smallint, stack_level smallint,
    stack_parent_id uuid, created_at timestamptz, updated_at timestamptz
  );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('placements', v_n);

  -- profilesはauth.usersを参照するため削除・挿入はせず、既存ユーザー行の更新のみ行う。
  -- バックアップ後に追加されたユーザーはそのまま残る。
  with src as (
    select * from jsonb_to_recordset(payload->'tables'->'profiles') as t(
      id uuid, role text, display_name text, disabled boolean, created_at timestamptz
    )
  )
  update public.profiles p
  set role = src.role,
      display_name = src.display_name,
      disabled = src.disabled
  from src
  where p.id = src.id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('profiles', v_n);

  return v_counts;
end;
$$;
