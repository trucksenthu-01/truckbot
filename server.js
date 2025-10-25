// server.js — ChatGPT-style replies + small inline Amazon links (no cards)

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { extractIntent, getBestAffiliateLinks } from "./recommend.js";

/* ---------------------------------------
   Load affiliate data (root or /data)
---------------------------------------- */
function safeLoadJSON(p, fallback = []) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.warn("[server] Could not load", p, e.message); return fallback; }
}
const ROOT_AFF = path.resolve("./affiliateMap_enriched.json");
const DATA_AFF = path.resolve("./data/affiliateMap_enriched.json");
const affiliateMap = safeLoadJSON(fs.existsSync(DATA_AFF) ? DATA_AFF : ROOT_AFF, []);
console.log(`[server] ✅ Loaded ${affiliateMap.length} affiliate entries`);

/* ---------------------------------------
   Express + CORS
---------------------------------------- */
const app = express();
app.use(bodyParser.json());

const allowed = (process.env.ALLOWED_ORIGINS || "https://trucksenthusiasts.com")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    const ok = !origin || allowed.length === 0 || allowed.includes(origin);
    cb(null, ok);
  }
}));

/* ---------------------------------------
   OpenAI
---------------------------------------- */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.MODEL || "gpt-4o-mini";
const PORT   = process.env.PORT || 3000;

/* ---------------------------------------
   Diagnostics
---------------------------------------- */
app.get("/health", (_req, res) => res.send("ok"));
app.get("/diag", (_req, res) => res.json({
  ok: true,
  model: MODEL,
  has_api_key: !!process.env.OPENAI_API_KEY,
  affiliate_entries: affiliateMap.length,
  allowed_origins: allowed
}));

/* ---------------------------------------
   Helper utils (fuzzy matching + links)
---------------------------------------- */
const STOP = new Set([
  "the","a","an","for","to","of","on","with","and","or","cover","covers",
  "tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great"
]);
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const toks = s => norm(s).split(" ").filter(t => t && !STOP.has(t));
const jac  = (A,B) => {
  const a = new Set(toks(A)), b = new Set(toks(B));
  const inter = [...a].filter(x => b.has(x)).length;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
};
const isAmazonLink = (url="") => /(^https?:\/\/(www\.)?(amzn\.to|amazon\.[a-z.]+)\/)/i.test(url);

/** Pick up to N relevant Amazon items (prefer ASIN & strong fuzzy score). */
function pickAmazonProducts(userMsg, modelReply, max = 3) {
  const scored = affiliateMap
    .filter(p => isAmazonLink(p.url))
    .map(p => {
      const name = [p.brand || "", p.name || ""].join(" ").trim();
      const score = 0.6*jac(modelReply, name) + 0.4*jac(userMsg, name) + (p.asin ? 0.06 : 0);
      return { p, score };
    })
    .filter(x => x.score > 0.10) // loose threshold
    .sort((a,b) => b.score - a.score);

  // de-dupe by ASIN or URL
  const out = [];
  const seen = new Set();
  for (const {p} of scored) {
    const key = p.asin || p.url;
    if (!seen.has(key)) { out.push(p); seen.add(key); }
    if (out.length >= max) break;
  }
  return out;
}

/** Append small inline links (no cards). Falls back to recommender if needed. */
function appendInlineAmazonLinks(userMsg, replyText) {
  let picks = pickAmazonProducts(userMsg, replyText, 3);

  // Fallback to recommender using the user's intent if fuzzy match finds nothing
  if (!picks.length) {
    const intent = extractIntent(userMsg || "");
    picks = getBestAffiliateLinks({ ...intent, query: userMsg, limit: 3 }) || [];
    picks = (picks || []).filter(p => isAmazonLink(p.url)).slice(0, 3);
  }

  if (!picks.length) return replyText;

  const lines = picks.map(p => {
    const title = p.name || `${p.brand || ""} ${p.type || ""}`.trim();
    // Keep it human & review-aware in one line, with a tiny link at the end
    return `• ${title} — owners like the fit and weather protection. 👉 <a href="${p.url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
  });

  return `${replyText}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
}

/* ---------------------------------------
   Chat endpoint (ChatGPT-style)
---------------------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });
    }

    const systemPrompt = `
You are "Trucks Helper" — a friendly truck expert that talks like a human.
STYLE:
- Plain text only (NO markdown like ** or #).
- Short, natural sentences with the occasional emoji.
- Give 2–3 specific product suggestions when relevant.
- Summarize what owners like/dislike from real-world experience (tone only; no fake numbers).
- Never paste raw URLs in the main text. The system will append small "View on Amazon" links after your message.
- Add one practical tip when useful. Keep it helpful and concise.
`;

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",    content: message }
      ]
    });

    let reply = r?.choices?.[0]?.message?.content
      || "I couldn't find a clear answer. Tell me your truck year, bed length, and typical use.";

    // Add tiny inline Amazon links (no big cards)
    reply = appendInlineAmazonLinks(message, reply);

    return res.json({ reply });
  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.json({
      reply: "I’m having trouble reaching the AI right now. Meanwhile, UnderCover, BAKFlip and Retrax are solid picks for hard folding covers."
    });
  }
});

/* --------------------------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running (chat + inline links) on :${PORT}`));
