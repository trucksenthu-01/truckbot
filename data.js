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

// Resolve paths RELATIVE TO THIS FILE, not process cwd
const AFF_PATH  = path.join(__dirname, "data", "affiliateMap_enriched.json");
const TOP_PATH  = path.join(__dirname, "data", "top_picks_index.json");

// Optional debug: list the folder contents so you can see what exists at runtime
try {
  console.log("[data.js] __dirname =", __dirname);
  console.log("[data.js] ls __dirname:", fs.readdirSync(__dirname));
  console.log("[data.js] ls data:", fs.readdirSync(path.join(__dirname, "data")));
} catch (e) {
  console.warn("[data.js] Could not list directories:", e.message);
}

export const affiliateMap  = safeLoad(AFF_PATH, []);
export const topPicksIndex = safeLoad(TOP_PATH, {});

console.log(`[data.js] ✅ Loaded ${affiliateMap.length} affiliate entries`);
console.log(`[data.js] ✅ Loaded top picks for ${Object.keys(topPicksIndex).length} vehicles`);
