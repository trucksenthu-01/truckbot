// server.js — Chat + memory + guarded Amazon links + ALWAYS-ON FALLBACK + GEO (US/UK/CA)
// - Remembers conversation per session (year/make/model, etc.)
// - Gives how-to steps when asked, then suggests parts
// - Builds Amazon SEARCH links with your affiliate tag (no product DB needed)
// - Injects clickable links ONLY for product-like queries
// - Adds a small "You might consider" block when appropriate
// - Fallback: if detection finds nothing, builds safe vehicle/product search
// - GEO: only for US/UK/CA -> .com / .co.uk / .ca (others use AMAZON_MARKETPLACE or .com)

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import { extractIntent } from "./recommend.js";

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
   Utilities: intent, vehicle memory, product-type detection
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
   GEO (US/UK/CA only) -> marketplace TLD
---------------------------------------- */
const COUNTRY_TO_TLD_LIMITED = {
  US: "com",
  GB: "co.uk", // UK / Great Britain
  UK: "co.uk", // accept UK as well
  CA: "ca",
};

function normalizeCountry(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (s.length === 2) return s.toUpperCase();
  // handle "en-US" or "en_US"
  const m = s.match(/[-_](\w{2})$/);
  return m ? m[1].toUpperCase() : s.substring(0,2).toUpperCase();
}

function detectCountryLimited(req, explicitCountry) {
  // precedence: explicit -> common proxy headers -> accept-language
  const direct = normalizeCountry(explicitCountry);
  if (direct) return direct;

  const h = req.headers || {};
  const cf = normalizeCountry(h["cf-ipcountry"]);           // Cloudflare
  if (cf) return cf;
  const ver = normalizeCountry(h["x-vercel-ip-country"]);   // Vercel
  if (ver) return ver;
  const gen = normalizeCountry(h["x-country-code"]);        // generic proxy/CDN header
  if (gen) return gen;

  const al = h["accept-language"];
  if (al) {
    const first = al.split(",")[0].trim(); // e.g., en-US
    const cc = normalizeCountry(first);
    if (cc) return cc;
  }
  return null;
}

function resolveMarketplace(countryLimited) {
  // Only US/UK/CA are mapped here; otherwise fall back to env default (or .com)
  if (countryLimited && COUNTRY_TO_TLD_LIMITED[countryLimited]) {
    return COUNTRY_TO_TLD_LIMITED[countryLimited];
  }
  return process.env.AMAZON_MARKETPLACE || "com";
}

/* ---------------------------------------
   Amazon search links (affiliate)
---------------------------------------- */
function amazonDomainFromCC(cc="com") {
  const tld = (cc || "com").toLowerCase();
  return `https://www.amazon.${tld}`;
}
function buildAmazonSearchURL(query, { tag, marketplace } = {}) {
  const base = amazonDomainFromCC(marketplace || process.env.AMAZON_MARKETPLACE || "com");
  const params = new URLSearchParams();
  params.set("k", query);
  const assoc = tag || process.env.AFFILIATE_TAG;
  if (assoc) params.set("tag", assoc);
  return `${base}/s?${params.toString()}`;
}

/* ---------------------------------------
   Tiny suggestion line (footer block)
---------------------------------------- */
function tinySearchLine(q, market) {
  const url = buildAmazonSearchURL(q, { marketplace: market });
  return `• ${q} 👉 <a href="${url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* ========= Inline link helpers (fuzzy + markdown strip) ========= */

// Basic markdown stripper so your UI sees clean text (no **bold** etc.)
function stripMarkdownBasic(s = "") {
  return s
    .replace(/(\*{1,3})([^*]+)\1/g, "$2")      // **bold**, *italic*, ***both***
    .replace(/`([^`]+)`/g, "$1")               // `code`
    .replace(/^#+\s*(.+)$/gm, "$1")            // # headings
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")      // remove images
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$&");    // keep markdown links as-is
}

// Token utilities for fuzzy matching
const _STOP = new Set(["the","a","an","for","to","of","on","with","and","or","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great"]);
const _norm = s => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const _toks = s => _norm(s).split(" ").filter(t => t && !_STOP.has(t));

// Build regex matching main tokens in order (like "bakflip mx4")
function buildOrderedTokenRegex(name) {
  const ts = _toks(name);
  if (!ts.length) return null;
  const chosen = ts.slice(0, Math.min(3, ts.length)); // 2–3 core tokens
  const pattern = chosen.map(t => `(${t})`).join(`\\s+`);
  return new RegExp(`\\b${pattern}\\b`, "gi");
}

/**
 * Inject affiliate hyperlinks directly into the reply text.
 * products = [{ name: "BakFlip MX4", url: "<amazon search link>" }, ...]
 */
function injectAffiliateLinks(replyText = "", products = []) {
  if (!replyText || !Array.isArray(products) || !products.length) return replyText;
  let out = stripMarkdownBasic(replyText);

  for (const p of products) {
    const url = p?.url;
    const full = p?.name;
    if (!url || !full) continue;

    // 1) token-ordered fuzzy match (brand + model)
    const tokenRe = buildOrderedTokenRegex(full);
    if (tokenRe && tokenRe.test(out)) {
      out = out.replace(tokenRe, (m) =>
        `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`
      );
      continue;
    }

    // 2) fallback: exact full-name (case-insensitive), word-bounded
    const escaped = full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactRe = new RegExp(`\\b(${escaped})\\b`, "gi");
    if (exactRe.test(out)) {
      out = out.replace(
        exactRe,
        `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">$1</a>`
      );
    }
  }
  return out;
}

/* ---------------------------------------
   Build Amazon search queries from reply/message
   (STRONGER FILTER: only return queries when we truly see products)
---------------------------------------- */
const BRAND_WHITELIST = [
  "BAKFlip","UnderCover","TruXedo","Extang","Retrax","Gator","Rough Country",
  "Bilstein","DiabloSport","Hypertech","Motorcraft","Power Stop","WeatherTech",
  "Tyger","Nitto","BFGoodrich","Falken","K&N","Borla","Flowmaster","Gator EFX",
  "ArmorFlex","MX4","Ultra Flex","Lo Pro","Sentry CT","Solid Fold","Husky",
  "FOX","Rancho","Monroe","Moog","ACDelco","Dorman","Bosch","NGK","Mopar"
];

// Shopping-ish nouns to gate generic queries
const PRODUCT_TERMS = /(cover|tonneau|lift kit|leveling kit|tire|wheel|brake|pad|rotor|shock|strut|bumper|intake|exhaust|tuner|programmer|filter|floor mat|bed liner|rack|light|headlight|taillight|coilover|spring|winch|hitch|oil|battery)/i;

function extractProductQueries({ userMsg, modelReply, vehicle, productType, max = 3 }) {
  const out = [];

  // 1) If we confidently detected a productType, build vehicle-scoped searches
  if (productType) {
    const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
    if (veh) out.push(`${veh} ${productType}`);
    out.push(`${productType} ${vehicle?.make || ""} ${vehicle?.model || ""}`.trim());
  }

  // 2) Scan the model reply for brand phrases (only from whitelist)
  const phrases = (modelReply || "").match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z0-9\.\-]+){0,3})\b/g) || [];
  phrases.forEach(s => {
    if (BRAND_WHITELIST.some(w => s.toLowerCase().includes(w.toLowerCase()))) out.push(s);
  });

  // 3) DO NOT fall back to the raw user message unless it clearly looks like shopping
  if (!out.length && userMsg && PRODUCT_TERMS.test(userMsg)) {
    out.push(userMsg);
  }

  // de-dup + trim + top-N
  const seen = new Set();
  const deduped = [];
  for (const s of out) {
    const key = s.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(s.trim());
    if (deduped.length >= max) break;
  }
  return deduped;
}

/* ---------------------------------------
   Diagnostics
---------------------------------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/diag", (req,res)=> {
  const country = detectCountryLimited(req);
  const marketplace = resolveMarketplace(country);
  res.json({
    ok:true,
    model: MODEL,
    has_api_key: !!process.env.OPENAI_API_KEY,
    allowed_origins: allowed,
    sessions: SESSIONS.size,
    affiliate_tag: process.env.AFFILIATE_TAG || null,
    default_marketplace: process.env.AMAZON_MARKETPLACE || "com",
    detected_country: country,
    resolved_marketplace: marketplace
  });
});

// Quick UI test: if this isn't clickable in your chat, switch to innerHTML in the widget
app.get("/debug/anchor", (_req,res) => {
  res.send('Test anchor → <a href="https://amazon.com" target="_blank" rel="nofollow">Amazon</a>');
});

/* ---------------------------------------
   Chat endpoint
---------------------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message, session, country: bodyCountry, market: bodyMarket } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });
    }

    // GEO resolve: body override (market or country) -> headers -> env default
    const country = normalizeCountry(bodyCountry) || detectCountryLimited(req);
    const marketplace = (bodyMarket || resolveMarketplace(country));

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

    // 6) Product-type routing for targeted queries
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

    // 7) Build Amazon search queries from message + model reply (STRICT FILTER)
    let queries = extractProductQueries({
      userMsg: message,
      modelReply: reply,
      vehicle,
      productType,
      max: 3
    });

    // 7.1 ALWAYS-ON FALLBACK:
    if (!queries.length) {
      const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
      const looksProducty = productType || PRODUCT_TERMS.test(message) || BRAND_WHITELIST.some(b => message.includes(b));
      if (looksProducty) {
        const genericType = productType || "truck accessories";
        const seed = veh ? `${veh} ${genericType}` : genericType;
        queries = [seed];
      }
    }

    // 8) ONLY link when we have queries (detected or fallback)
    if (queries.length) {
      // Inline hyperlinks in MAIN TEXT to Amazon search with GEO marketplace + tag
      reply = injectAffiliateLinks(
        reply,
        queries.map(q => ({ name: q, url: buildAmazonSearchURL(q, { marketplace }) }))
      );

      // 9) Append a small suggestion block (GEO aware)
      const lines = queries.map(q => tinySearchLine(q, marketplace));
      reply = `${reply}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }
    // else: informational answers won't get links

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
app.listen(PORT, () => console.log(`🚀 Truckbot running (chat + memory + guarded links + fallback + GEO US/UK/CA) on :${PORT}`));
