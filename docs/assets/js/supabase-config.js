// このリポジトリはpublicです。
// ここに書けるのは anon key のみ。クライアント（ブラウザ）に配信される前提のキーであり、
// データの保護はRLSが担う。service_role キーは絶対にここへ書かないでください。
//
// .github/workflows/supabase-keepalive.yml がこのファイルをgrepして値を読むため、
// 変数名と文字列リテラルの形を変える場合はワークフローも合わせて直すこと。

export const SUPABASE_URL = 'https://lrigkakwxzjuenrjhput.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyaWdrYWt3eHpqdWVucmpocHV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MzI3OTksImV4cCI6MjEwMjMwODc5OX0.k5a4SgulHUWrAPi3v0_anFexOQEeUOl9EzKLke8O2b4';
