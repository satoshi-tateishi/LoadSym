-- クリアランスの設定範囲をアプリ側の実装（1〜20mm・既定10mm）に合わせる。
--
-- 004_layout_clearance.sql でこの列を追加したときは「範囲 1〜10mm・既定 5mm」だったが、
-- その後アプリ側で範囲を 1〜20mm へ広げ、既定を 10mm へ戻した（geometry.js の
-- MAX_SETTING_CLEARANCE_MM / DEFAULT_CLEARANCE_MM、SPECIFICATION.md 6.2節）。
-- このときDB側のマイグレーションを追加し忘れていたため、CHECK制約だけが 1〜10 のまま残った。
--
-- その結果、シミュレーターでクリアランスを 11mm 以上に設定すると、画面上は値が反映されて
-- 赤色表示まで更新されるのに、保存だけが 23514（check constraint 違反）で失敗していた。
-- しかも error-messages.js の汎用文言により「入力値が許容範囲外です。寸法や重量を確認して
-- ください。」と表示され、原因がクリアランスだと分からなかった。
--
-- 既定値も 10mm へ揃える。アプリは新規レイアウトで clearance_mm を明示的に送るため実害は
-- 出ていなかったが、列の既定値だけ 5mm が残っていると、DBを直接見たときに
-- 「どちらが本当の既定か」が分からなくなるため。
--
-- 保存済みのレイアウトの値は変更しない。クリアランスは吸着先を決める値であって、
-- 確定済みの座標を動かすものではなく、既存の値（1〜10mm）は新しい範囲にすべて収まるため。

alter table public.layouts
  drop constraint layouts_clearance_mm_check;

alter table public.layouts
  add constraint layouts_clearance_mm_check
    check (clearance_mm between 1 and 20);

alter table public.layouts
  alter column clearance_mm set default 10;

comment on column public.layouts.clearance_mm is
  '機材どうし・機材と壁のクリアランス(mm)。スナップと押し出しの目標値。1〜20、既定10。';
