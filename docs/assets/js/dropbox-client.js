// Dropboxとの連携（PKCE OAuth + Content/RPC API）。
//
// service_roleキーやDropboxのApp secretを使わず、ブラウザ完結で「App folder」に
// バックアップJSONを保存・一覧・取得する。アクセストークンは短命なので保持せず、
// token_access_type=offline で得たリフレッシュトークンをlocalStorageに保存して、
// 必要になるたびアクセストークンを取り直す（supabase-jsのセッションもlocalStorage任せ、
// という既存方針と揃えてある）。

import { DROPBOX_APP_KEY, DROPBOX_REDIRECT_PATH } from './dropbox-config.js';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const LIST_FOLDER_URL = 'https://api.dropboxapi.com/2/files/list_folder';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';

const VERIFIER_KEY = 'loadsym.dropbox.pkce_verifier';
const REFRESH_TOKEN_KEY = 'loadsym.dropbox.refresh_token';

function redirectUri() {
  return new URL(DROPBOX_REDIRECT_PATH, window.location.href).toString();
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function isConnected() {
  return Boolean(localStorage.getItem(REFRESH_TOKEN_KEY));
}

export function disconnect() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/** Dropboxの認可画面へ遷移する。戻り先は dropbox-callback.html。 */
export async function connect() {
  const verifier = randomVerifier();
  localStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await challengeFor(verifier);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', DROPBOX_APP_KEY);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('redirect_uri', redirectUri());
  window.location.href = url.toString();
}

/** dropbox-callback.html から呼ぶ。認可コードをトークンに交換してリフレッシュトークンを保存する。 */
export async function handleCallback(code) {
  const verifier = localStorage.getItem(VERIFIER_KEY);
  localStorage.removeItem(VERIFIER_KEY);
  if (!verifier) {
    throw new Error('Dropbox連携の途中経過が見つかりません。管理画面からもう一度「Dropboxに接続」をお試しください。');
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: DROPBOX_APP_KEY,
      redirect_uri: redirectUri(),
      code_verifier: verifier
    })
  });
  if (!response.ok) throw new Error('Dropboxとの連携に失敗しました。');

  const json = await response.json();
  if (!json.refresh_token) throw new Error('Dropboxからrefresh_tokenを取得できませんでした。');
  localStorage.setItem(REFRESH_TOKEN_KEY, json.refresh_token);
}

async function getAccessToken() {
  const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new Error('Dropboxに接続してください。');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: DROPBOX_APP_KEY
    })
  });
  if (!response.ok) {
    disconnect();
    throw new Error('Dropboxの認証が切れました。もう一度接続してください。');
  }
  const json = await response.json();
  return json.access_token;
}

/** pathは`/`始まりのフルパス（例: `/2026/08/17/231045.json`）。存在しない親フォルダは自動で作られる。 */
export async function uploadJson(path, jsonText) {
  const accessToken = await getAccessToken();
  const response = await fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode: 'add',
        autorename: false,
        mute: true
      })
    },
    body: jsonText
  });
  if (!response.ok) throw new Error('Dropboxへのアップロードに失敗しました。');
  return response.json();
}

/**
 * App folder内のバックアップJSONを、日付フォルダをまたいで（recursive）新しい順で返す。
 * パス自体が `/YYYY/MM/DD/HHmmss.json` で固定幅ゼロ埋めのため、path_lower の文字列比較が
 * そのまま日時順になる。
 */
export async function listBackups() {
  const accessToken = await getAccessToken();
  const response = await fetch(LIST_FOLDER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: '', recursive: true })
  });
  if (!response.ok) throw new Error('Dropboxのバックアップ一覧を取得できませんでした。');
  const json = await response.json();
  return (json.entries ?? [])
    .filter((entry) => entry['.tag'] === 'file' && entry.name.endsWith('.json'))
    .sort((a, b) => (a.path_lower < b.path_lower ? 1 : -1));
}

export async function downloadJson(path) {
  const accessToken = await getAccessToken();
  const response = await fetch(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path })
    }
  });
  if (!response.ok) throw new Error('Dropboxからのダウンロードに失敗しました。');
  return response.json();
}
