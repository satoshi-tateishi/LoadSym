// CSVの読み込み。
//
// 現場のリストはExcelで作られることが多く、UTF-8とShift_JISが混在する。
// どちらで来ても読めるよう、まずUTF-8で厳格にデコードし、失敗したらShift_JISとして読み直す。
// （不正なバイト列を含むUTF-8デコードは fatal:true で例外になる。これを判定に使う）

/**
 * FileをテキストとしてUTF-8/Shift_JISのどちらでも読む。
 * @returns {Promise<string>} BOMを取り除いたテキスト
 */
export async function readTextFile(file) {
  const buffer = await file.arrayBuffer();

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('shift_jis').decode(buffer);
  }

  return text.replace(/^﻿/, '');
}

/**
 * CSVを解析して配列の配列にする。
 * ダブルクォートで囲まれたフィールド、その中の改行・カンマ、"" によるエスケープに対応する。
 * 機材名に「(株)A社, B社」のようなカンマが入ることがあるため、単純なsplitでは足りない。
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // CRLFの\nを二重に数えない
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 末尾の空行を落とす
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** 機材CSVで受け付ける列。1行目のヘッダーで対応付ける。 */
export const EQUIPMENT_CSV_HEADERS = [
  'name',
  'category',
  'width_mm',
  'depth_mm',
  'height_mm',
  'weight_kg',
  'color',
  'note'
];

/**
 * 機材CSVを検証しつつ取り込み用の行に変換する。
 * 1行でも落とさず、行ごとにエラーを付けて返す（画面でプレビューして直せるように）。
 *
 * @param {Array<Array<string>>} rows parseCsvの結果
 * @param {Map<string,string>} categoryIdByName カテゴリ名 → id
 * @param {string} fallbackCategoryId カテゴリ未指定・不明のときに使うid
 */
export function toEquipmentRows(rows, categoryIdByName, fallbackCategoryId) {
  if (rows.length === 0) {
    return { header: [], items: [], errors: ['CSVが空です。'] };
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const errors = [];

  if (!header.includes('name')) {
    errors.push('1行目のヘッダーに name 列が必要です。');
    return { header, items: [], errors };
  }

  const indexOf = (key) => header.indexOf(key);
  const items = rows.slice(1).map((cells, offset) => {
    const lineNumber = offset + 2;
    const value = (key) => {
      const index = indexOf(key);
      return index === -1 ? '' : (cells[index] ?? '').trim();
    };

    const problems = [];
    const name = value('name');
    if (!name) problems.push('名称が空です');

    const number = (key, required) => {
      const raw = value(key);
      if (raw === '') {
        if (required) problems.push(`${key} が空です`);
        return null;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        problems.push(`${key} が数値ではありません（${raw}）`);
        return null;
      }
      return Math.round(parsed);
    };

    const widthMm = number('width_mm', true);
    const depthMm = number('depth_mm', true);
    const heightMm = number('height_mm', true);

    const weightRaw = value('weight_kg');
    let weightKg = 0;
    if (weightRaw !== '') {
      const parsed = Number(weightRaw);
      if (!Number.isFinite(parsed) || parsed < 0) problems.push(`weight_kg が数値ではありません（${weightRaw}）`);
      else weightKg = parsed;
    }

    const categoryName = value('category');
    let categoryId = fallbackCategoryId;
    if (categoryName) {
      const matched = categoryIdByName.get(categoryName);
      if (matched) categoryId = matched;
      else problems.push(`カテゴリ「${categoryName}」が見つかりません（その他として取り込みます）`);
    }

    const colorRaw = value('color');
    let color = '#64748b';
    if (colorRaw) {
      if (/^#[0-9a-fA-F]{6}$/.test(colorRaw)) color = colorRaw;
      else problems.push(`color の形式が不正です（${colorRaw}）`);
    }

    return {
      lineNumber,
      name,
      categoryName: categoryName || '（その他）',
      values: {
        name,
        category_id: categoryId,
        width_mm: widthMm,
        depth_mm: depthMm,
        height_mm: heightMm,
        weight_kg: weightKg,
        color,
        note: value('note') || null
      },
      problems,
      // カテゴリ名の不一致とcolorの不正は既定値で続行できる。寸法と名称の欠落だけを致命とする。
      fatal: !name || widthMm === null || depthMm === null || heightMm === null
    };
  });

  return { header, items, errors };
}
