import { supabase } from "./supabase";
import { BARCODE_FORMAT, BARCODE_LOOKUP_MIN } from "./barcodeRules";

/**
 * One place for the barcode rules every product screen shares (Fiche
 * Produit main/extra/variant barcodes, the product & stock lists' search,
 * the importer): SUMA Web's format rule, the friendly cross-table
 * pre-check, and the mapping of the database's own uniqueness errors.
 *
 * The database is the real guarantee — trigger enforce_store_barcode_unique
 * (constraint name uq_store_barcode_any, SQLSTATE 23505) makes a code
 * unique per store across products.barcode, product_barcodes.barcode and
 * product_variants.barcode, even for two rows of the SAME product. The
 * pre-check only exists to say *which* product already owns the code
 * before the round trip fails.
 */

export { BARCODE_FORMAT, BARCODE_LOOKUP_MIN, BARCODE_MAX, validateBarcode, type BarcodeCheck } from "./barcodeRules";

export type BarcodeOwnerExclusion = {
  /** products.id whose MAIN barcode is being edited. */
  productId?: string | null;
  /** product_barcodes.id being edited in place. */
  extraBarcodeId?: string | null;
  /** product_variants.id being edited. */
  variantId?: string | null;
};

/**
 * Looks for `code` in all three barcode tables of the store (3 parallel
 * point lookups, each backed by its per-store unique index) and returns a
 * specific Arabic message naming the owner, or null when it's free. Only
 * the row being edited itself is excluded — the database rejects a code
 * shared between two rows of the same product too, so that case gets its
 * own message instead of being waved through.
 */
export async function findBarcodeConflict(
  storeId: string,
  code: string,
  exclude: BarcodeOwnerExclusion = {},
  ownProductId?: string | null,
): Promise<string | null> {
  const value = code.trim();
  if (!value) return null;

  let productQuery = supabase.from("products").select("id, name").eq("store_id", storeId).eq("barcode", value);
  if (exclude.productId) productQuery = productQuery.neq("id", exclude.productId);
  let extraQuery = supabase
    .from("product_barcodes")
    .select("id, product_id")
    .eq("store_id", storeId)
    .eq("barcode", value);
  if (exclude.extraBarcodeId) extraQuery = extraQuery.neq("id", exclude.extraBarcodeId);
  let variantQuery = supabase
    .from("product_variants")
    .select("id, product_id, variant_name")
    .eq("store_id", storeId)
    .eq("barcode", value);
  if (exclude.variantId) variantQuery = variantQuery.neq("id", exclude.variantId);

  const [p, b, v] = await Promise.all([productQuery.limit(1), extraQuery.limit(1), variantQuery.limit(1)]);
  // A failed pre-check never blocks the save — the database still decides.
  const productHit = p.data?.[0];
  if (productHit) {
    return productHit.id === ownProductId
      ? "هذا هو الباركود الأساسي لنفس المنتج."
      : `هذا الباركود مستعمل كباركود أساسي للمنتج «${productHit.name}».`;
  }
  const extraHit = b.data?.[0];
  const variantHit = v.data?.[0];
  const ownerIds = [extraHit?.product_id, variantHit?.product_id].filter((id): id is string => Boolean(id));
  let names: Record<string, string> = {};
  if (ownerIds.length > 0) {
    const { data } = await supabase.from("products").select("id, name").in("id", ownerIds);
    names = Object.fromEntries((data ?? []).map((r) => [r.id, r.name]));
  }
  if (extraHit) {
    return extraHit.product_id === ownProductId
      ? "هذا الباركود مسجّل أصلاً كباركود إضافي لنفس المنتج."
      : `هذا الباركود مستعمل كباركود إضافي للمنتج «${names[extraHit.product_id] ?? "منتج آخر"}».`;
  }
  if (variantHit) {
    return variantHit.product_id === ownProductId
      ? `هذا الباركود مستعمل أصلاً للتنويعة «${variantHit.variant_name}» من نفس المنتج.`
      : `هذا الباركود مستعمل للتنويعة «${variantHit.variant_name}» من المنتج «${names[variantHit.product_id] ?? "منتج آخر"}».`;
  }
  return null;
}

/**
 * Translates a PostgREST error from any product / barcode / variant write
 * into the message a shop owner should see. The cross-table trigger
 * already raises a specific Arabic message (which table owns the code),
 * so that one is passed through as-is; the per-table unique indexes only
 * surface their constraint name, so those get mapped here.
 */
export function mapProductError(error: { message: string; code?: string | null } | string): string {
  const message = typeof error === "string" ? error : error.message;
  const code = typeof error === "string" ? null : (error.code ?? null);
  const lower = message.toLowerCase();

  if (message.includes("uq_store_barcode_any")) return "هذا الباركود مستعمل من قبل في محلك.";
  if (message.includes("uq_products_store_barcode")) return "هذا الباركود مستعمل كباركود أساسي لمنتج آخر في محلك.";
  if (message.includes("uq_product_barcodes_store_barcode")) return "هذا الباركود مستعمل كباركود إضافي في محلك.";
  if (message.includes("uq_variants_store_barcode")) return "هذا الباركود مستعمل لتنويعة في محلك.";
  if (message.includes("uq_products_store_internal")) return "الكود الداخلي مستعمل من قبل في محلك.";
  // The trigger's own message is Arabic and names the owning table.
  if (code === "23505" && message.includes("الباركود")) return message;
  if (code === "23505") return "هذه القيمة مستعملة من قبل في محلك (باركود أو كود مكرر).";
  if (message.includes("تغيير السعر محجوز")) return "تغيير السعر محجوز لصاحب المحل فقط.";
  if (lower.includes("row-level security") || code === "42501") return "ما عندكش الصلاحية باش تدير هذا التغيير.";
  return message;
}

const ALT_BARCODE_SEARCH_CAP = 200;

/**
 * Product ids whose EXTRA or VARIANT barcodes contain `term` — the first
 * step of SUMA Web's two-step search, so the list query can OR in
 * `id.in.(...)` instead of fetching per row. Capped per table (a search
 * that broad is already served by the name/barcode columns), and skipped
 * for terms that can't be a barcode or are shorter than the lookup
 * minimum.
 */
export async function findProductIdsByAltBarcode(storeId: string, term: string): Promise<string[]> {
  const value = term.trim();
  if (value.length < BARCODE_LOOKUP_MIN || !BARCODE_FORMAT.test(value)) return [];
  const pattern = `%${value.replace(/_/g, "\\_")}%`;
  const [extra, variants] = await Promise.all([
    supabase.from("product_barcodes").select("product_id").eq("store_id", storeId).ilike("barcode", pattern).limit(ALT_BARCODE_SEARCH_CAP),
    supabase.from("product_variants").select("product_id").eq("store_id", storeId).ilike("barcode", pattern).limit(ALT_BARCODE_SEARCH_CAP),
  ]);
  const ids = new Set<string>();
  for (const r of extra.data ?? []) ids.add(r.product_id);
  for (const r of variants.data ?? []) ids.add(r.product_id);
  return Array.from(ids);
}

/** Search term safe to embed in a PostgREST `or=(...)` filter: commas,
 * parentheses and wildcard/quote characters would otherwise change the
 * filter's structure. */
export function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*"\\]/g, " ").replace(/\s+/g, " ").trim();
}
