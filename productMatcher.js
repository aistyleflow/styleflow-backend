// ─────────────────────────────────────────────────────────
// PHASE 4 — Voice AI result → Supabase product matching.
//
// SCOPE (strict):
//   Voice AI result (Phase 3 Gemini output) → search existing
//   StyleFlow "products" table → return real product data.
//
// This file does NOT touch cart, checkout, payment, orders, or
// customer confirmation messaging. It has exactly one job:
// figure out which real product (if any) a voice request refers to.
//
// Reuses:
//   - The existing Supabase client passed in from index.js
//     (no second client is created here).
//   - The same products table and the same ilike search shape
//     already used by processIncomingMessage's text-search block
//     (product_name/category/color/size), so there is one search
//     system, not two.
//   - The same field names as the rest of the app: product_name,
//     price, image_url, stock, size, color, store_id, id.
// ─────────────────────────────────────────────────────────

/**
 * Normalizes a customer's spoken product query for matching.
 * Only harmless differences are normalized — no aggressive rewriting.
 */
function normalizeQuery(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?'"]/g, "")   // strip common punctuation
    .replace(/\s+/g, " ");      // collapse extra spaces
}

/**
 * matchProductFromVoiceRequest(supabase, storeId, voiceResult)
 *
 * @param {object} supabase - the EXISTING Supabase client from index.js
 * @param {number|string} storeId - the store to scope the search to
 * @param {object} voiceResult - Phase 3 Gemini output:
 *        { product_query, size, quantity, understood }
 *
 * @returns one of:
 *   { status: "invalid_request", product: null, matches: [] }
 *   { status: "not_found",       product: null, matches: [], size, quantity }
 *   { status: "multiple_matches",product: null, matches: [...], size, quantity }
 *   { status: "matched",         product: {...}, matches: [product], size, quantity }
 *   { status: "error",           product: null, matches: [] }
 */
async function matchProductFromVoiceRequest(supabase, storeId, voiceResult) {
  // ── 1. Validate input ──
  if (
    !voiceResult ||
    voiceResult.understood === false ||
    !voiceResult.product_query ||
    !voiceResult.product_query.trim()
  ) {
    console.log("⚠️ productMatcher: invalid/unclear voice request — skipping search");
    return { status: "invalid_request", product: null, matches: [] };
  }

  const rawQuery = voiceResult.product_query;
  const query = normalizeQuery(rawQuery);
  const size = voiceResult.size ? String(voiceResult.size).trim() : null;
  const quantity = Number.isFinite(voiceResult.quantity) && voiceResult.quantity > 0
    ? Math.floor(voiceResult.quantity)
    : 1;

  console.log(`🔎 Searching products for voice query: ${query}`);

  try {
    // ── 2. Search existing Supabase products table ──
    // Same shape as the existing text-search block: ilike across
    // product_name/category/color/size, scoped to the store.
    let supabaseQuery = supabase
      .from("products")
      .select("id, product_name, price, image_url, stock, size, color")
      .or(
        `product_name.ilike.%${query}%,category.ilike.%${query}%,color.ilike.%${query}%,size.ilike.%${query}%`
      )
      .order("id", { ascending: false });

    if (storeId) {
      supabaseQuery = supabaseQuery.eq("store_id", storeId);
    }

    const { data: results, error } = await supabaseQuery;

    if (error) {
      console.error("❌ productMatcher: Supabase search error:", error.message);
      return { status: "error", product: null, matches: [] };
    }

    // ── 3. No match ──
    if (!results || results.length === 0) {
      console.log("❌ No matching product found");
      return { status: "not_found", product: null, matches: [], size, quantity };
    }

    // ── 4. Single strong match ──
    if (results.length === 1) {
      const product = results[0];
      console.log(`✅ Product matched: ${product.product_name}`);
      return {
        status: "matched",
        product,
        matches: [product],
        size,
        quantity
      };
    }

    // ── 5. Multiple plausible matches — never guess ──
    console.log(`⚠️ Multiple products matched (${results.length}) for query: ${query}`);
    return {
      status: "multiple_matches",
      product: null,
      matches: results,
      size,
      quantity
    };

  } catch (err) {
    console.error("❌ productMatcher: unexpected error:", err.message);
    return { status: "error", product: null, matches: [] };
  }
}

module.exports = {
  matchProductFromVoiceRequest
};