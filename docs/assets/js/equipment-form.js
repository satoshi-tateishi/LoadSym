/** 「その他」があればそれ、無ければ先頭。カテゴリが1件も無ければ null。 */
export function defaultCategoryIdOf(categories) {
  const fallback = categories.find((category) => category.name === 'その他');
  return (fallback ?? categories[0])?.id ?? null;
}

/** カテゴリの既定色。未設定・不明なら null。 */
export function categoryDefaultColorOf(categories, categoryId) {
  return categories.find((category) => category.id === categoryId)?.default_color ?? null;
}

/** 新規作成時の初期フォーム値。ページ固有のフィールドは呼び出し側で追加する。 */
export function emptyEquipmentDraft(categoryId, color) {
  return {
    id: null,
    name: '',
    category_id: categoryId,
    width_mm: 600,
    depth_mm: 400,
    height_mm: 500,
    weight_kg: 0,
    color,
    shape: null
  };
}

/** prepareEquipmentShape(form) 後のフォームから、DBへ渡す値を組み立てる。 */
export function buildEquipmentValues(form, fallbackCategoryId) {
  return {
    name: form.name,
    category_id: form.category_id || fallbackCategoryId,
    width_mm: form.width_mm,
    depth_mm: form.depth_mm,
    height_mm: form.height_mm,
    weight_kg: form.weight_kg ?? 0,
    color: form.color,
    shape: form.shape
  };
}
