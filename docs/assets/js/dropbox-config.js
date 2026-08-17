// このリポジトリはpublicです。
// ここに書けるのはDropboxの「App key」（client_id）のみ。PKCE（OAuth 2.0 with PKCE）を
// 使うクライアントはsecretを必要としないため、App keyはブラウザに埋め込んでよい非秘匿値
// （supabase-config.jsのanon keyと同じ位置づけ）。service_role相当のもの（Dropboxの
// App secret）は絶対にここへ書かないこと。
//
// 事前準備: Dropbox App Console で「App folder」アクセス権のアプリを新規作成し、
// 以下のRedirect URIを2つとも登録してからApp keyを設定する。
//   http://localhost:8090/dropbox-callback.html
//   https://<GitHub Pagesの公開URL>/dropbox-callback.html
// 「App folder」を選ぶのは、万一トークンが漏れてもDropbox全体ではなく専用フォルダに
// 被害を限定するため。

export const DROPBOX_APP_KEY = '2cyduhcuy8lqkyr';
export const DROPBOX_REDIRECT_PATH = 'dropbox-callback.html';
