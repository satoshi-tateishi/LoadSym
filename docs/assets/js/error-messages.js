// Supabase/PostgreSQLから返る生のエラーメッセージを、わかりやすい日本語に変換する。
// 該当する変換ルールがない場合は元のメッセージをそのまま返す
// （登録数制限トリガなど、DB側で最初から日本語のメッセージを投げているものがあるため）。
export function translateError(error) {
  const message = error?.message ?? String(error);

  if (/row-level security/i.test(message)) {
    return 'この操作を行う権限がありません（自分が作成したデータのみ編集できます）。';
  }

  if (/not authorized/i.test(message)) {
    return 'この操作を行う権限がありません。';
  }

  if (/violates check constraint .*_color_check/i.test(message)) {
    return '識別カラーの形式が正しくありません（#rrggbb で指定してください）。';
  }

  // スロット0（機材置き場）は 002_staging_area.sql を適用して初めて保存できる。
  // 「寸法を確認してください」と出すと原因を見誤るので個別に文言を分ける。
  if (/violates check constraint .*layout_trucks_slot_check/i.test(message)) {
    return 'レイアウトを保存できませんでした。機材置き場に対応するデータベースの更新（002_staging_area.sql）が適用されていない可能性があります。管理者にお問い合わせください。';
  }

  if (/violates check constraint/i.test(message)) {
    return '入力値が許容範囲外です。寸法や重量を確認してください。';
  }

  if (/duplicate key value violates unique constraint .*layout_trucks/i.test(message)) {
    return '同じスロットに別のトラックが読み込まれています。画面を更新してもう一度お試しください。';
  }

  if (/violates foreign key constraint/i.test(message)) {
    return '参照先のデータが見つかりません。画面を更新してもう一度お試しください。';
  }

  if (error instanceof TypeError || /failed to fetch/i.test(message)) {
    return '通信に失敗しました。ネットワーク接続を確認してもう一度お試しください。';
  }

  return message;
}
