// Supabase/PostgreSQLから返る生のエラーメッセージを、わかりやすい日本語に変換する。
// 該当する変換ルールがない場合は元のメッセージをそのまま返す
// （登録数制限トリガなど、DB側で最初から日本語のメッセージを投げているものがあるため）。
const CHECK_CONSTRAINT_MESSAGES = [
  {
    constraint: /_color_check/i,
    message: '識別カラーの形式が正しくありません（#rrggbb で指定してください）。'
  },
  {
    constraint: /clearance/i,
    message: 'クリアランスの値が許容範囲外です。'
  }
];

export function translateError(error) {
  const message = error?.message ?? String(error);

  if (/row-level security/i.test(message)) {
    return 'この操作を行う権限がありません（自分が作成したデータのみ編集できます）。';
  }

  if (/not authorized/i.test(message)) {
    return 'この操作を行う権限がありません。';
  }

  if (/violates check constraint/i.test(message)) {
    const matched = CHECK_CONSTRAINT_MESSAGES.find(({ constraint }) => constraint.test(message));
    if (matched) return matched.message;
    return '入力値が許容範囲外です。寸法や重量を確認してください。';
  }

  if (/duplicate key value violates unique constraint .*layout_trucks/i.test(message)) {
    return '同じスロットに別のトラックが読み込まれています。画面を更新してもう一度お試しください。';
  }

  // カテゴリは on delete restrict にしてあるので、使用中は削除できない。
  if (/violates foreign key constraint .*equipments_category_id/i.test(message)) {
    return 'このカテゴリは機材に使われているため削除できません。先に対象の機材を別のカテゴリへ移してください。';
  }

  if (/duplicate key value violates unique constraint .*equipment_categories/i.test(message)) {
    return '同じ名前のカテゴリがすでに存在します。';
  }

  if (/violates foreign key constraint/i.test(message)) {
    return '参照先のデータが見つかりません。画面を更新してもう一度お試しください。';
  }

  if (error instanceof TypeError || /failed to fetch/i.test(message)) {
    return '通信に失敗しました。ネットワーク接続を確認してもう一度お試しください。';
  }

  return message;
}

/**
 * 保存系の非同期処理に共通する saving/errorMessage の状態を管理する。
 * task 内では noticeMessage など、ページ固有の状態を自由に更新できる。
 * @param {object} self Alpineコンポーネント（saving / errorMessage を持つ）
 * @param {() => Promise<void>} task
 * @param {{onError?: (error: unknown) => Promise<void> | void}} [options]
 */
export async function withSaving(self, task, options = {}) {
  self.saving = true;
  self.errorMessage = '';
  try {
    await task();
  } catch (error) {
    console.error(error);
    self.errorMessage = translateError(error);
    await options.onError?.(error);
  } finally {
    self.saving = false;
  }
}
