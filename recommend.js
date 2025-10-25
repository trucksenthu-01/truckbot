import { affiliateMap, topPicksIndex } from "./data.js";

/**
 * Vehicles and product types we recognize.
 * You can freely add more here (e.g., "silverado-2500", "raptor", etc.).
 */
const VEHICLES = [
  "f150", "super-duty", "maverick",
  "ram-1500", "ram-2500", "ram-3500",
  "silverado-1500", "sierra-1500",
  "tacoma", "tundra", "gladiator",
  "colorado", "ranger"
];

const TYPES = [
  "tonneau cover", "wheels", "tires", "lift kit", "shocks/struts",
  "cold air intake", "exhaust", "tuner/programmer", "brakes",
  "lighting", "floor mats", "running boards/steps", "bed accessories"
];

/**
 * Brand lists used to (a) extract brand intent from user query
 * and (b) give a small score boost for well-known tonneau brands.
 */
const KNOWN_TONNEAU_BRANDS = [
  "BAK", "UnderCover", "Retrax", "TruXedo", "Extang",
  "GatorTrax", "TonnoPro", "Bestop", "Leer"
];

const KNOWN_BRANDS = [
  ...KNOWN_TONNEAU_BRANDS,
  "Tyger", "Rough Country", "Bilstein", "FOX", "ICON",
  "Method", "Fuel", "Go Rhino", "AMP Research",
  "WeatherTech", "Husky", "Airaid", "K&N",
  "MBRP", "Borla", "MagnaFlow", "PowerStop"
];

/**
 * Basic text normalization helpers
 */
const norm = (s = "") => String(s || "").trim();
const lc = (s = "") => norm(s).toLowerCase();

/**
 * Extracts coarse user intent (vehicle, product type, brand) from a raw query.
 * - Vehicle: tries both with/without hyphen (e.g., "super duty" → "super-duty")
 * - Type: direct match against TYPES, or "bed cover"/"tonneau" → "tonneau cover"
 * - Brand: scans for any known brand in the text
 */
export function extractIntent(query = "") {
  const q = lc(query);

  // Vehicle
  let vehicle =
    VEHICLES.find(v => q.includes(v.replace("-", " "))) ||
    VEHICLES.find(v => q.includes(v));

  // Type
  let type =
    TYPES.find(t => q.includes(t)) ||
    (q.includes("bed cover") || q.includes("tonneau") ? "tonneau cover" : null);

  // Brand
  let brand = null;
  for (const b of KNOWN_BRANDS) {
    if (q.includes(lc(b))) { brand = b; break; }
  }

  return { vehicle, type, brand };
}

/**
 * Scoring function for a catalog item against an intent.
 * The higher the score, the better the match.
 * You can tweak weights to better fit your preferences.
 */
export function scoreItem(item, intent) {
  let s = 0;
  const tags = new Set(item?.tags || []);

  // Match on vehicle/type/brand
  if (intent.vehicle && tags.has(intent.vehicle)) s += 5;
  if (intent.type && item?.type === intent.type) s += 5;
  if (intent.brand && item?.brand && lc(item.brand) === lc(intent.brand)) s += 2;

  // Marketplace + data completeness
  if (tags.has("amazon")) s += 1;
  if (item?.asin && String(item.asin).length === 10) s += 1;

  // Known tonneau brands get a tiny boost when type is tonneau
  if (intent.type === "tonneau cover" && KNOWN_TONNEAU_BRANDS.includes(item?.brand)) s += 1;

  // Example: prefer Amazon India links slightly (you can remove if not needed)
  if ((tags.has("amazon") && /amazon\.in|amzn\.to/i.test(item?.url || ""))) s += 0.5;

  return s;
}

/**
 * Finds top affiliate links for a user's request.
 * Args may include an explicit asin/sku/vehicle/type/brand to force-filter results.
 * Returns up to {limit} items with (sku, name, asin, url, brand, type).
 */
export function getBestAffiliateLinks({
  query,
  asin,
  sku,
  vehicle,
  type,
  brand,
  limit = 3
} = {}) {
  const intent = {
    ...extractIntent(query || ""),
    vehicle: vehicle || undefined,
    type: type || undefined,
    brand: brand || undefined
  };

  // 1) Fast path: curated picks for (vehicle × type)
  if (intent.vehicle && intent.type) {
    const bucket = topPicksIndex?.[intent.vehicle]?.[intent.type];
    if (bucket?.length) {
      return bucket.slice(0, limit).map(({ sku, name, asin, url, brand, type }) => ({
        sku, name, asin, url, brand, type
      }));
    }
  }

  // 2) Fallback: score the entire catalog
  const catalog = Array.isArray(affiliateMap) ? affiliateMap : [];
  if (catalog.length === 0) return [];

  const filtered = catalog.filter((it) =>
    (asin ? it.asin === asin : true) &&
    (sku ? it.sku === sku : true)
  );

  const ranked = filtered
    .map((it) => ({ it, score: scoreItem(it, intent) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ it }) => ({
      sku: it.sku,
      name: it.name,
      asin: it.asin,
      url: it.url,
      brand: it.brand,
      type: it.type
    }));

  return ranked;
}
// See chat for full version
