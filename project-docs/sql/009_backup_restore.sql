-- LoadSym: DBバックアップからの復元用RPCを追加する。
--
-- 社内ツールとして運用しており、Supabase無料プランには自動バックアップの仕組みがない。
-- 誤操作・CSV誤インポート等からの復旧手段として、Admin画面から
-- 「全テーブルをJSONとしてダンプしDropboxへ保存」「Dropbox上のJSONから全テーブルを
-- 洗い替えて復元」を行えるようにする。
--
-- バックアップ（読み取り）は既存のSELECTポリシー（Adminはprofiles含む全テーブルを読める）で
-- RLSの範囲内に収まるため、クライアント側のSELECTだけで完結し追加のRPCは不要。
-- 一方、復元（書き込み）は他ユーザーのuser_id行を書き換える必要があり通常のRLSでは
-- 通らないため、admin_list_users()と同じ「security definer + 関数内でAdmin判定」の
-- パターンでRLSをバイパスするRPCを用意する。service_roleキーやEdge Functionは使わない
-- （このリポジトリは公開かつ静的サイトのため、client側にsecretを置けない）。
--
-- 復元は「同一プロジェクト内での巻き戻し」に限定する。auth.usersは一切操作しない
-- （profilesは既存ユーザー行の更新のみで、新規アカウント作成は行わない）。
-- 全テーブル一括の洗い替えのみで、テーブル単位の部分復元には対応しない。

create function public.admin_restore_backup(payload jsonb)
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

  -- 子 → 親の順で全件削除する（FK制約に沿う）。
  delete from public.placements;
  delete from public.layout_trucks;
  delete from public.layouts;
  delete from public.truck_obstacles;
  delete from public.trucks;
  delete from public.equipments;
  delete from public.equipment_categories;

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

grant execute on function public.admin_restore_backup(jsonb) to authenticated;
