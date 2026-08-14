export function loginForm() {
  return {
    email: '',
    password: '',
    loading: false,
    errorMessage: '',
    init() {
      if (new URLSearchParams(window.location.search).get('reason') === 'disabled') {
        this.errorMessage = 'このアカウントは無効化されています。管理者にお問い合わせください。';
      }
    },
    async submit() {
      this.loading = true;
      this.errorMessage = '';
      try {
        // 初期ロードを軽くするため、認証モジュールは送信時に動的importする。
        const { loginWithPassword } = await import('../auth.js');
        await loginWithPassword(this.email, this.password);
        window.location.href = './simulator.html';
      } catch (error) {
        console.error(error);
        // アカウントの存在を推測されないよう、原因を問わず同じ文言に丸める。
        this.errorMessage = 'ログインに失敗しました。メールアドレスとパスワードを確認してください。';
      } finally {
        this.loading = false;
      }
    }
  };
}
