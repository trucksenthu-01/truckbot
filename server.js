// server.js — Precise, session-aware bot + inline affiliate hyperlinks in main text
// - Remembers conversation per session (year/make/model, etc.)
// - Gives task-focused answers (how-to when asked) with safety notes
// - Finds vehicle-specific products and appends tiny "View on Amazon" lines
// - NEW: Injects affiliate hyperlinks directly into the assistant's main text

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
   In-memory session store (simple)
   - For production HA, swap to Redis
---------------------------------------- */
const SESSIONS = new Map(); // sessionId -> { history: Message[], vehicle: {...} }
const MAX_TURNS = 12;

function getSession(sessionId) {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, { history: [], vehicle: {} });
  }
  return SESSIONS.get(sessionId);
}
function pushHistory(sess, role, content) {
  sess.history.push({ role, content });
  if (sess.history.length > MAX_TURNS) {
    sess.history.splice(0, sess.history.length - MAX_TURNS);
  }
}

/* ---------------------------------------
   Utilities for precise recommendations
---------------------------------------- */
const HOWTO_KEYWORDS = [
  "how to", "how do i", "procedure", "steps", "install", "replace", "change", "fix", "tutorial"
];
function looksLikeHowTo(text="") {
  const t = text.toLowerCase();
  return HOWTO_KEYWORDS.some(k => t.includes(k));
}
function mergeVehicleMemory(sess, fromIntent = {}) {
  const v = sess.vehicle || {};
  const merged = {
    year:   fromIntent.year   || v.year   || null,
    make:   fromIntent.make   || v.make   || null,
    model:  fromIntent.model  || v.model  || null,
    bed:    fromIntent.bed    || v.bed    || null,
    trim:   fromIntent.trim   || v.trim   || null,
    engine: fromIntent.engine || v.engine || null,
  };
  sess.vehicle = merged;
  return merged;
}
function missingFitment(vehicle) {
  const missing = [];
  if (!vehicle.year)  missing.push("year");
  if (!vehicle.make)  missing.push("make");
  if (!vehicle.model) missing.push("model");
  return missing; // bed/trim optional
}

/* ---------------------------------------
   Tiny link line (for the suggestion block)
---------------------------------------- */
function tinyLinkLine(name, url, ownerNote = "owners like the fit and performance") {
  const safe = name || "View on Amazon";
  const link = url || "#";
  return `• ${safe} — ${ownerNote}. 👉 <a href="${link}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* ---------------------------------------
   NEW: Inject inline affiliate hyperlinks
   - Wraps product names inside the assistant's MAIN TEXT with <a href="...">
   - Uses exact-name matching (case-insensitive), safe-escaped
---------------------------------------- */
function injectAffiliateLinks(replyText, products) {
  if (!replyText || !Array.isArray(products) || !products.length) return replyText;

  let result = replyText;
  for (const p of products) {
    if (!p?.url) continue;
    const name = p.name || `${p.brand || ""} ${p.type || ""}`.trim();
    if (!name) continue;

    // Escape special regex chars in the product name
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word-boundary match, case-insensitive
    const regex = new RegExp(`\\b(${escaped})\\b`, "gi");

    // Replace occurrences with a hyperlink (preserve original case via $1)
    if (regex.test(result)) {
      result = result.replace(
        regex,
        `<a href="${p.url}" target="_blank" rel="nofollow sponsored noopener">$1</a>`
      );
    }
  }
  return result;
}

/* ---------------------------------------
   Diagnostics
---------------------------------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/diag", (_req,res)=>res.json({
  ok:true, model: MODEL, has_api_key: !!process.env.OPENAI_API_KEY,
  affiliate_entries: affiliateMap.length, allowed_origins: allowed,
  sessions: SESSIONS.size
}));

/* ---------------------------------------
   Chat endpoint
---------------------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message, session } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });
    }

    const sessionId = (session || "visitor").toString().slice(0, 60);
    const sess = getSession(sessionId);

    // 1) Update memory with the user's message
    pushHistory(sess, "user", message);

    // 2) Extract/update vehicle profile from this turn
    const parsed = extractIntent(message || "");
    const vehicle = mergeVehicleMemory(sess, parsed);

    // 3) If critical fitment is missing and user is asking for products, ask once.
    const miss = missingFitment(vehicle);
    const wantsProducts = /cover|lift|tune|tuner|tire|wheel|brake|pad|rotor|shock|bumper|intake|exhaust|light|rack|liner/i.test(message);
    if (wantsProducts && miss.length >= 2) {
      const ask = `To recommend exact parts, what is your truck's ${miss.join(" & ")}? (Example: 2019 Ford F-150 5.5 ft bed XLT)`;
      pushHistory(sess, "assistant", ask);
      return res.json({ reply: ask });
    }

    // 4) Compose messages (system + memory + current)
    const systemPrompt = `
You are "Trucks Helper" — a precise, friendly truck expert.
- Keep answers concise and task-focused. No generic lists.
- Use the user's known vehicle profile when giving fitment or product guidance.
- If the user asks a HOW-TO (e.g., "how to change brake pads"), first give a clear step-by-step procedure with safety notes, then suggest exact parts for that vehicle.
- If a fitment detail is missing, ask a SINGLE follow-up question (once).
- Do not paste URLs; the system will attach links afterwards.
`;

    const base = [{ role: "system", content: systemPrompt }, ...sess.history];

    // 5) Generate assistant response
    const isHowTo = looksLikeHowTo(message);
    const temperature = isHowTo ? 0.4 : 0.5;

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature,
      messages: base
    });

    let reply = r?.choices?.[0]?.message?.content
      || "I couldn't find a clear answer. Tell me your truck year, make and model.";

    // 6) Figure out the product type requested (to fetch targeted picks)
    let productType = null;
    const m = message.toLowerCase();
    if (isHowTo && /brake|pad|rotor/.test(m)) {
      productType = "brake pads";
    } else if (/brake pad|brakes|rotor/.test(m)) {
      productType = "brake pads";
    } else if (/tonneau|bed cover/.test(m)) {
      productType = "tonneau cover";
    } else if (/lift kit|leveling/.test(m)) {
      productType = "lift kit";
    } else if (/tire|all terrain|mud terrain/.test(m)) {
      productType = "tires";
    } else if (/tuner|programmer|diablosport|hypertech|hyper tuner/.test(m)) {
      productType = "tuner";
    }
    // Extend mappings as needed…

    // 7) If we know the product type, fetch 1–3 exact Amazon picks
    let lines = [];
    let amazonOnly = [];
    if (productType) {
      const q = {
        query: `${vehicle.year||""} ${vehicle.make||""} ${vehicle.model||""} ${productType}`.trim(),
        vehicle: `${vehicle.year||""} ${vehicle.make||""} ${vehicle.model||""}`.trim(),
        type: productType,
        limit: 3
      };
      const picks = getBestAffiliateLinks(q) || [];
      amazonOnly = picks.filter(p => /(^https?:\/\/(www\.)?(amzn\.to|amazon\.[a-z.]+)\/)/i.test(p.url)).slice(0,3);
      if (amazonOnly.length) {
        lines = amazonOnly.map(p => tinyLinkLine(p.name || `${p.brand||""} ${p.type||""}`.trim(), p.url));
      }
    }

    // 8) Inject affiliate hyperlinks directly in the MAIN TEXT (for any known product names)
    //    Use the subset of Amazon picks (if we have them) to prioritize relevant names;
    //    fall back to all affiliateMap to catch other names the model mentioned.
    if (amazonOnly.length) {
      reply = injectAffiliateLinks(reply, amazonOnly);
    } else {
      reply = injectAffiliateLinks(reply, affiliateMap);
    }

    // 9) Append tiny suggestion lines if we have targeted picks
    if (lines.length) {
      reply = `${reply}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    // 10) Save and return
    pushHistory(sess, "assistant", reply);
    return res.json({ reply });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.json({
      reply: "I’m having trouble reaching the AI right now. Meanwhile, if you share your truck year/make/model, I’ll fetch exact parts that fit."
    });
  }
});

/* --------------------------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running (precise + memory + inline links) on :${PORT}`));
