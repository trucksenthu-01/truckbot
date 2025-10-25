import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function safeLoad(absPath, fallback) {
  try {
    const data = fs.readFileSync(absPath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.warn(`[data.js] Could not load ${absPath}: ${error.message}`);
    return fallback;
  }
}

// Preferred (correct) locations
const PREFERRED_AFF = path.join(__dirname, "data", "affiliateMap_enriched.json");
const PREFERRED_TOP = path.join(__dirname, "data", "top_picks_index.json");

// Fallback (root) locations – because your current deploy has them in root
const ROOT_AFF = path.join(__dirname, "affiliateMap_enriched.json");
const ROOT_TOP = path.join(__dirname, "top_picks_index.json");

// Choose actual paths to use
const AFF_PATH = fs.existsSync(PREFERRED_AFF) ? PREFERRED_AFF : ROOT_AFF;
const TOP_PATH = fs.existsSync(PREFERRED_TOP) ? PREFERRED_TOP : ROOT_TOP;

// Debug listing
try {
  console.log("[data.js] __dirname =", __dirname);
  console.log("[data.js] ls __dirname:", fs.readdirSync(__dirname));
  const dataDir = path.join(__dirname, "data");
  console.log("[data.js] ls data:", fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : "(no data dir)");
} catch (e) {
  console.warn("[data.js] Could not list directories:", e.message);
}

export const affiliateMap  = safeLoad(AFF_PATH, []);
export const topPicksIndex = safeLoad(TOP_PATH, {});

console.log(`[data.js] Using AFF_PATH: ${AFF_PATH}`);
console.log(`[data.js] Using TOP_PATH: ${TOP_PATH}`);
console.log(`[data.js] ✅ Loaded ${affiliateMap.length} affiliate entries`);
console.log(`[data.js] ✅ Loaded top picks for ${Object.keys(topPicksIndex).length} vehicles`);
