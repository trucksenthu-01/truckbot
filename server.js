import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { extractIntent, getBestAffiliateLinks } from "./recommend.js";

/* -----------------------------
   Load affiliate data
------------------------------ */
let affiliateMap = [];
function safeLoadJSON(p, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("[server] Could not load", p, e.message);
    return fallback;
  }
}
affiliateMap = safeLoadJSON(path.resolve("./data/affiliateMap_enriched.json"), []);
console.log(`[server] ✅ Loaded ${affiliateMap.length} affiliate items`);

/* -----------------------------
   App setup
------------------------------ */
const app = express();
app.use(bodyParser.json());

const allowed = (process.env.ALLOWED_ORIGINS || "https://trucksenthusiasts.com")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
}));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.MODEL || "gpt-4o-mini";
const PORT   = process.env.PORT || 3000;

/* -----------------------------
   Helpers
------------------------------ */
function amazonImageFromASIN(asin, marketplace = "US") {
  if (!asin) return null;
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL400_&ID=AsinImage&MarketPlace=${marketplace}&ServiceVersion=20070822`;
}

const stopwords = new Set(["the","a","an","for","to","of","on","with","and","or","best","good","great","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota"]);
function norm(s="") {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
}
function tokens(s="") {
  return norm(s).split(" ").filter(t => t && !stopwords.has(t));
}
function jaccard(aSet, bSet) {
  const a = new Set(aSet); const b = new Set(bSet);
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
}

/** Fuzzy match products mentioned in the text. */
function fuzzyFindProducts(text, max = 3) {
  const tks = tokens(text);
  const scored = affiliateMap.map(item => {
    const name = [item.brand || "", item.name || ""].join(" ");
    const score = jaccard(tks, tokens(name));
    return { item, score };
  }).filter(x => x.score > 0.12); // loose threshold
  scored.sort((a,b) => b.score - a.score);
  return scored.slice(0, max).map(x => x.item);
}

/** Build HTML product cards. */
function renderCards(items) {
  return items.map(p => {
    const title = p.name || `${p.brand || ""} ${p.type || ""}`.trim() || "Product";
    const img = p.asin ? amazonImageFromASIN(p.asin) : null;
    const url = p.url || "#";
    return `
      <div style="border:1px solid #233244;border-radius:12px;padding:12px;margin:8px 0;background:#0f1620;color:#fff;max-width:520px">
        <div style="font-weight:600;margin-bottom:6px">${title}</div>
        ${img ? `<img src="${img}" alt="${title}" width="320" loading="lazy" style="border-radius:10px;margin:6px 0">` : ""}
        <a href="${url}" target="_blank" rel="nofollow sponsored noopener"
           style="display:inline-block;padding:8px 12px;border-radius:10px;background:#1f6feb;color:#fff;text-decoration:none">
          👉 View on Amazon
        </a>
      </div>
    `;
  }).join("");
}

/** Append affiliate block to a plain-text reply. */
function appendAffiliate(message, reply) {
  // 1) Try fuzzy match from what the model wrote
  let picks = fuzzyFindProducts(reply);

  // 2) If none, fall back to our recommender using the user's message intent
  if (!picks.length) {
    const intent = extractIntent(message || "");
    picks = getBestAffiliateLinks({ ...intent, query: message, limit: 3 }) || [];
  }

  if (!picks.length) return reply; // nothing to add

  const cardsHtml = renderCards(picks);
  return `${reply}
<br><br><div style="font-weight:600;margin-top:6px">💡 You might like these:</div>
${cardsHtml}
<p style="font-size:12px;opacity:.75;margin-top:6px">
  As an Amazon Associate, we may earn from qualifying purchases.
</p>`;
}

/* -----------------------------
   Diagnostics
------------------------------ */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/diag", (_req,res)=>res.json({
  ok:true, model: MODEL, has_api_key: !!process.env.OPENAI_API_KEY,
  affiliate_entries: affiliateMap.length, allowed_origins: allowed
}));

/* -----------------------------
   Chat endpoint
------------------------------ */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string")
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });

    const systemPrompt = `
You are "Trucks Helper" — a friendly, concise truck expert.
STYLE:
- Plain text only (NO markdown, NO **bold**, NO links).
- Short, natural sentences with emojis when helpful.
- 2–3 specific product names if relevant; keep it brief.
- Never paste URLs. The system will add links/cards afterwards.
- Add one practical tip when useful.
`;

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ]
    });

    let reply = r?.choices?.[0]?.message?.content || "I couldn't find a good answer. Tell me your truck year and bed length.";
    // Add affiliate content (fuzzy + fallback recommender), rendered as HTML cards
    reply = appendAffiliate(message, reply);

    res.json({ reply });
  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    res.json({
      reply: "I’m having trouble reaching the AI right now. Meanwhile, UnderCover, BAKFlip and Retrax are solid choices for hard folding covers."
    });
  }
});

/* ----------------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running on :${PORT}`));
