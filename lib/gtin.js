// lib/gtin.js
// Canonicalize GTIN/UPC strings consistently across scripts + routes.

function normalizeDigits(raw) {
  return (raw ?? "")
    .toString()
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^0-9]/g, "");
}

/**
 * Canonical rule (updated):
 * - 8-digit stays 8-digit
 * - 12/13/14 usually stays unchanged
 * - BUT: if length is 12/13/14 AND the prefix (everything before the last 8 digits)
 *   is ALL zeros, treat it as zero-padded 8-digit -> last 8 digits.
 *
 * Examples:
 *   000002785123  -> last8=02785123 (prefix 0000... -> collapse)
 *   000008240402  -> last8=08240402 (prefix 0000 -> collapse)
 *   008421372232  -> unchanged (prefix 0084 is NOT all zeros)
 */
function canonicalGtin(raw) {
  const digits = normalizeDigits(raw);
  if (!digits) return "";

  if (digits.length === 8) return digits;

  // If longer than 8 and prefix is ALL zeros -> collapse to last 8
  if (digits.length > 8) {
    const last8 = digits.slice(-8);
    const prefix = digits.slice(0, -8);
    if (/^0+$/.test(prefix)) return last8;
  }

  // keep common GTIN lengths (and everything else) as-is
  return digits;
}

/**
 * Useful for UI/API search:
 * If user types digits, convert to canonical the same way.
 */
function canonicalizeQuery(q) {
  return canonicalGtin(q);
}

module.exports = {
  normalizeDigits,
  canonicalGtin,
  canonicalizeQuery,
};
