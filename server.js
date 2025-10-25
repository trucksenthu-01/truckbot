// server.js — Precise, session-aware bot with tailored how-to + vehicle-specific product links

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
   In-memory session store (simple & fast)
   - For production, swap to Redis for persistence
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
  // bed/trim are optional, but we’ll ask if relevant
  return missing;
}

function buildToolQuery(userMessage, sessVehicle, extra = {}) {
  const base = extractIntent(userMessage || "");
  const vehicle = mergeVehicleMemory({ vehicle: sessVehicle }, base); // non-mutating copy
  return { ...base, ...extra, vehicle: `${vehicle.year||""} ${vehicle.make||""} ${vehicle.model||""}`.trim() };
}

/* ---------------------------------------
   HTML line helper for tiny links
---------------------------------------- */
function tinyLinkLine(name, url, ownerNote = "owners like the fit and performance") {
  const safe = name || "View on Amazon";
  const link = url || "#";
  return `• ${safe} — ${ownerNote}. 👉 <a href="${link}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* ---------------------------------------
   Endpoints
---------------------------------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/diag", (_req,res)=>res.json({
  ok:true, model: MODEL, has_api_key: !!process.env.OPENAI_API_KEY,
  affiliate_entries: affiliateMap.length, allowed_origins: allowed,
  sessions: SESSIONS.size
}));

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
    const wantsProducts = /cover|lift|tire|wheel|brake|pad|rotor|shock|bumper|intake|exhaust|light|rack|liner/i.test(message);
    if (wantsProducts && miss.length >= 2) {
      const ask = `To recommend exact parts, what is your truck's ${miss.join(" & ")}? (Example: 2019 Ford F-150 5.5 ft bed XLT)`;
      pushHistory(sess, "assistant", ask);
      return res.json({ reply: ask });
    }

    // 4) Prepare base messages (system + memory + current)
    const systemPrompt = `
You are "Trucks Helper" — a precise, friendly truck expert.
- Keep answers concise and task-focused. No generic lists.
- Use the user's known vehicle profile when giving fitment or product guidance.
- If the user asks a HOW-TO (e.g., "how to change brake pads"), first give a clear step-by-step procedure with safety notes, then suggest exact parts for that vehicle.
- If a fitment detail is missing, ask a SINGLE follow-up question (once).
- Do not paste URLs; the system will attach links afterwards.
`;

    const base = [{ role: "system", content: systemPrompt }, ...sess.history];

    // 5) Generate the assistant response
    const isHowTo = looksLikeHowTo(message);
    const temperature = isHowTo ? 0.4 : 0.5;

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature,
      messages: base
    });

    let reply = r?.choices?.[0]?.message?.content
      || "I couldn't find a clear answer. Tell me your truck year, make and model.";

    // 6) After we write the answer, fetch ONLY the relevant products
    let productType = null;
    if (isHowTo && /brake/i.test(message)) {
      productType = "brake pads";
    } else if (/brake pad|brakes|rotor/i.test(message)) {
      productType = "brake pads";
    } else if (/tonneau|bed cover/i.test(message)) {
      productType = "tonneau cover";
    } else if (/lift kit|leveling/i.test(message)) {
      productType = "lift kit";
    } else if (/tire|all terrain|mud terrain/i.test(message)) {
      productType = "tires";
    }
    // You can extend the mapping above as needed…

    let lines = [];
    if (productType) {
      // Build a precise tool query using remembered vehicle
      const q = {
        query: `${vehicle.year||""} ${vehicle.make||""} ${vehicle.model||""} ${productType}`.trim(),
        vehicle: `${vehicle.year||""} ${vehicle.make||""} ${vehicle.model||""}`.trim(),
        type: productType,
        limit: 3
      };
      const picks = getBestAffiliateLinks(q) || [];

      // Only output if we truly have product matches (Amazon links)
      const amazonOnly = picks.filter(p => /(^https?:\/\/(www\.)?(amzn\.to|amazon\.[a-z.]+)\/)/i.test(p.url)).slice(0,3);

      if (amazonOnly.length) {
        lines = amazonOnly.map(p => tinyLinkLine(p.name || `${p.brand||""} ${p.type||""}`.trim(), p.url));
      }
    }

    // 7) Compose final reply (assistant text + tiny amazon links)
    if (lines.length) {
      reply = `${reply}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    // 8) Save assistant message in memory and return
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
app.listen(PORT, () => console.log(`🚀 Truckbot running (precise + session memory) on :${PORT}`));
