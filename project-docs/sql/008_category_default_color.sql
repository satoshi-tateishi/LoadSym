-- 機材の識別カラーは追加のたびに255色のパレットから手で選んでいたが、実データを数えると
-- カテゴリごとに全件が1色へ揃っていた（ミキシングコンソール=オレンジ、スピーカー=黄緑、
-- パワーアンプ=青緑、ケース=シアン）。「カテゴリ＝色」という運用がすでに手作業で
-- 成立しているので、その対応をカテゴリ側に持たせ、機材フォームでカテゴリを選んだ時点で
-- 色が入るようにする。
--
-- 配色はコードに焼き付けず、この列を管理画面から編集できるようにする。現場ごとに
-- 色の好みが違うため。
--
-- 形式チェックは equipments.color（001_initial_schema.sql）と同じにする。値の供給元は
-- どちらも palette.js のパレットで、#rrggbb しか出さない。

alter table public.equipment_categories
  add column default_color text not null default '#64748b'
    check (default_color ~ '^#[0-9a-fA-F]{6}$');


-- 初期値。機材が存在する4カテゴリは、いま実際に使われている色をそのまま入れる。
-- 機材が無い3カテゴリ（ラック・スタンド・その他）は、既存4色と色相がぶつからない
-- shade 5 を割り当てる。いずれも後から管理画面で変更できる。
--
-- 003_equipment_categories.sql が初期カテゴリを名前で投入しているので、ここも名前で当てる。
update public.equipment_categories set default_color = '#e6ad74' where name = 'ミキシングコンソール';  -- C005 オレンジ5（実データ）
update public.equipment_categories set default_color = '#b7e674' where name = 'スピーカー';            -- C050 黄緑5（実データ）
update public.equipment_categories set default_color = '#74e6ba' where name = 'パワーアンプ';          -- C110 青緑5（実データ）
update public.equipment_categories set default_color = '#74e6dc' where name = 'ケース';                -- C125 シアン5（実データ）
update public.equipment_categories set default_color = '#74aae6' where name = 'ラック';                -- C155 青5（未使用色相）
update public.equipment_categories set default_color = '#a474e6' where name = 'スタンド';              -- C200 紫5（未使用色相）
update public.equipment_categories set default_color = '#e674c0' where name = 'その他';                -- C245 マゼンタ5（未使用色相）
