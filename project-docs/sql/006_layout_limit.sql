-- LoadSym: 保存できるレイアウトを1ユーザーあたり300件までに制限する。
--
-- 容量のためではない。実測ではレイアウト1件は満載でも 6〜8KB（1配置あたり約300B）で、
-- 300件でも1ユーザー 2MB 程度にしかならず、無料プランの 500MB に対して余裕がある。
--
-- 目的は暴走したときの歯止め。レイアウトは保存操作のたびに placements を作り直すため、
-- 誤操作やクライアント側の不具合で保存が繰り返されると、レイアウトと配置が
-- 際限なく増える。DB層で頭を打たせておけば、気づかないうちに無料枠を
-- 使い切ることがない。
--
-- 上限を300件にしたのは、通常の運用では到達しない値にするため。1現場1レイアウトで
-- 月20件保存しても1年以上かかる。機材(100個)やトラック(5台)と違ってレイアウトは
-- 成果物そのものなので、実運用で頭打ちになる値を設定してはいけない。
--
-- メッセージは日本語のまま画面に出る（error-messages.js は変換ルールが無ければ
-- 元のメッセージを返す）。既存の機材・トラックの制限トリガと同じ書き方に揃えてある。

create function public.enforce_layout_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- UPDATEで所有者が変わらないなら件数は増えないので検査しない。
  if tg_op = 'UPDATE' and new.user_id is not distinct from old.user_id then
    return new;
  end if;

  select count(*) into v_count from public.layouts where user_id = new.user_id;
  if v_count >= 300 then
    raise exception '保存できるレイアウトは1ユーザーあたり300件までです（現在%件）。不要なレイアウトを削除してください', v_count;
  end if;
  return new;
end;
$$;

create trigger layouts_enforce_limit
  before insert or update of user_id on public.layouts
  for each row execute function public.enforce_layout_limit();
