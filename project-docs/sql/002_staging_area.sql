-- LoadSym: 機材置き場（ステージングエリア）を追加する。
--
-- 積み込み作業では「その現場に必要な機材を先に置き場へ並べ、そこからトラックへ
-- 積んでいく」という進め方をする。画面上でも同じ流れをなぞれるよう、トラックの
-- 下に機材置き場を常設し、そこからトラックへドラッグして移動できるようにする。
--
-- 置き場は「矩形のエリア」という点でトラックの荷台とまったく同じ性質を持つため、
-- 専用テーブルは作らず layout_trucks / placements をそのまま使い回す。
-- 描画・スナップ・押し出し・保存の仕組みを丸ごと再利用できる。
--
-- スロット番号 0 を機材置き場に割り当てる（トラックは従来どおり 1〜3）。
-- 置き場はマスタ登録しないため truck_id は null で、寸法と種別は truck_snapshot に
-- { kind: 'staging', ... } として持たせる。

alter table public.layout_trucks drop constraint layout_trucks_slot_check;

alter table public.layout_trucks add constraint layout_trucks_slot_check
  check (slot between 0 and 3);
