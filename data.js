import fs from "fs";

/**
 * Safe JSON loader – prevents crashes if file missing or invalid.
 * @param {string} path - file path
 * @param {any} fallback - fallback value if file cannot be read
 * @returns {any}
 */
function safeLoad(path, fallback) {
  try {
    const data = fs.readFileSync(path, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.warn(`[data.js] Could not load ${path}: ${error.message}`);
    return fallback;
  }
}

/**
 * Loads all data JSON files.
 * These files contain affiliate products and pre-computed top picks.
 * Make sure both files exist in the /data folder at the root of your repo.
 */
export const affiliateMap = safeLoad("./data/affiliateMap_enriched.json", []);
export const topPicksIndex = safeLoad("./data/top_picks_index.json", {});

console.log(`[data.js] ✅ Loaded ${affiliateMap.length} affiliate entries`);
console.log(
  `[data.js] ✅ Loaded top picks for ${Object.keys(topPicksIndex).length} vehicles`
);
