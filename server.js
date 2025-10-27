// server.js — Chat + memory that *actually* remembers fitment (no repeat asks)
// - Fitment memory is sticky per session (year/make/model/trim/engine/bed)
// - Built-in fallback vehicle parser (F150/F-150, Ram 1500, etc.)
// - Only asks for fitment if 2+ core fields are missing *and* we haven't asked before
// - If 1 core field missing: answer anyway and add a single soft ask at the end
// - If user already gave fitment once, never ask again unless they clearly change trucks
// - Brand follow-ups (“why AMP?”) don’t re-trigger the fitment gate
// - Small-liners output + natural follow-ups + GEO Amazon links

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { extractIntent as externalIntent } from "./recommend.js"; // optional

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

/* ---------------- CORS: Android/AMP-safe ---------------- */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------- OpenAI ---------------- */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.MODEL || "gpt-4o-mini";
const PORT   = process.env.PORT || 3000;

/* ---------------- Session memory ---------------- */
const SESSIONS = new Map(); // sessionId -> { history: [], vehicle:{}, flags:{} }
const MAX_TURNS = 18;

function getSession(sessionId) {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, {
      history: [],
      vehicle: {},
      flags: {
        askedFitmentOnce: false,  // we asked at least once in this session
        fitmentConfirmed: false,  // we *have* year+make+model memorized
        offeredAfterHowTo: false,
        lastTopic: null
      }
    });
  }
  return SESSIONS.get(sessionId);
}
function pushHistory(sess, role, content) {
  sess.history.push({ role, content });
  if (sess.history.length > MAX_TURNS) {
    sess.history.splice(0, sess.history.length - MAX_TURNS);
  }
}

/* ---------------- Utilities ---------------- */
const HOWTO_KEYWORDS = ["how to","how do i","procedure","steps","install","replace","change","fix","tutorial","guide"];
function looksLikeHowTo(s=""){const t=s.toLowerCase();return HOWTO_KEYWORDS.some(k=>t.includes(k));}
function saidYes(s=""){return /\b(yes|yeah|yup|sure|ok|okay|please do|go ahead|why not|y|proceed)\b/i.test(s);}

/* ----- Vehicle parsing: robust local fallback (in addition to external extractor) ----- */
const MAKE_LIST = [
  "Ford","Chevrolet","Chevy","GMC","Ram","Dodge","Toyota","Nissan","Honda","Jeep",
  "Mazda","Hyundai","Kia","Volkswagen","VW","Subaru","Mitsubishi","Lincoln","Cadillac"
];
const MAKE_RE = new RegExp("\\b(" + MAKE_LIST.map(m=>m.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")).join("|") + ")\\b","i");

// Normalize common model tokens
function normModelToken(s=""){
  return s
    .replace(/\bF\s*[- ]?\s*150\b/i, "F-150")
    .replace(/\bF\s*[- ]?\s*250\b/i, "F-250")
    .replace(/\bF\s*[- ]?\s*350\b/i, "F-350")
    .replace(/\bSilverado\s*1500\b/i, "Silverado 1500")
    .replace(/\bSierra\s*1500\b/i, "Sierra 1500")
    .replace(/\bRam\s*1500\b/i, "Ram 1500")
    .trim();
}
function parseVehicleFallback(text=""){
  const t = text.replace(/’/g,"'").replace(/–|—/g,"-");
  // Patterns:
  // 1) Year + Make + Model (loose)
  //    e.g., "2020 Ford F150", "2019 Toyota Tacoma", "’18 F-150"
  const yearMatch = t.match(/\b(20\d{2}|19\d{2}|'\d{2})\b/);
  let year = null;
  if (yearMatch) {
    const y = yearMatch[1];
    year = y.startsWith("'") ? (y.length===3 ? ("20"+y.slice(1)) : null) : y;
  }
  const makeMatch = t.match(MAKE_RE);
  let make = makeMatch ? makeMatch[1] : null;

  // Model: grab the token(s) after the make or common truck models if no make
  let model = null;
  if (make) {
    const after = t.slice(makeMatch.index + make.length).trim();
    const m = after.match(/\b([A-Za-z0-9\-]+(?:\s?[A-Za-z0-9\-]+){0,2})\b/);
    if (m) model = m[1];
  } else {
    // Try common trucks without make provided
    const common = t.match(/\b(F\s*[- ]?\s*150|F\s*[- ]?\s*250|F\s*[- ]?\s*350|Tacoma|Tundra|Silverado\s*1500|Sierra\s*1500|Ram\s*1500|Ranger|Colorado|Frontier)\b/i);
    if (common) model = common[1];
  }

  if (model) model = normModelToken(model);
  // Normalize make names
  if (make && /chevy/i.test(make)) make = "Chevrolet";

  // Optional extras
  const bed = (/\b(5\.5|6\.5|8)\s*(ft|foot|feet|')\b/i.test(t)) ? RegExp.$1 + " ft" : null;
  const trim = (/\b(Lariat|XLT|XL|Limited|Platinum|TRD\s*Pro|TRD|Rebel|Big Horn|LTZ|LT|Raptor)\b/i.exec(t) || [])[1] || null;
  const engine = (/\b(3\.5L|2\.7L|5\.0L|5\.7L|6\.2L)\b/i.exec(t) || [])[1] || null;

  const out = {};
  if (year) out.year = String(year);
  if (make) out.make = make;
  if (model) out.model = model;
  if (bed) out.bed = bed;
  if (trim) out.trim = trim;
  if (engine) out.engine = engine;
  return out;
}

function mergeVehicleMemory(sess, from = {}) {
  const v = sess.vehicle || {};
  const merged = {
    year:   from.year   ?? v.year   ?? null,
    make:   from.make   ?? v.make   ?? null,
    model:  from.model  ?? v.model  ?? null,
    bed:    from.bed    ?? v.bed    ?? null,
    trim:   from.trim   ?? v.trim   ?? null,
    engine: from.engine ?? v.engine ?? null,
  };
  // Mark confirmed once we have core trio
  if (merged.year && merged.make && merged.model) sess.flags.fitmentConfirmed = true;
  sess.vehicle = merged;
  return merged;
}
function missingFitment(vehicle) {
  const miss=[]; if(!vehicle.year) miss.push("year"); if(!vehicle.make) miss.push("make"); if(!vehicle.model) miss.push("model"); return miss;
}

// Detect an explicit new truck statement → refresh memory
function looksLikeNewTruck(text=""){
  return /\b(my|new|another)\b.*\b(19|20)\d{2}\b/i.test(text) ||
         (MAKE_RE.test(text) && /\b(19|20)\d{2}\b/.test(text));
}

/* ---------------- GEO -> marketplace ---------------- */
const COUNTRY_TO_TLD_LIMITED = { US:"com", GB:"co.uk", UK:"co.uk", CA:"ca" };
function normalizeCountry(c){ if(!c) return null; const s=String(c).trim();
  if(s.length===2) return s.toUpperCase(); const m=s.match(/[-_](\w{2})$/); return m?m[1].toUpperCase():s.substring(0,2).toUpperCase();}
function detectCountryLimited(req, explicit) {
  const d=normalizeCountry(explicit); if(d) return d;
  const h=req.headers||{};
  return normalizeCountry(h["cf-ipcountry"]) ||
         normalizeCountry(h["x-vercel-ip-country"]) ||
         normalizeCountry(h["x-country-code"]) ||
         normalizeCountry((h["accept-language"]||"").split(",")[0]) || null;
}
function resolveMarketplace(cc){ return (cc && COUNTRY_TO_TLD_LIMITED[cc]) ? COUNTRY_TO_TLD_LIMITED[cc] : (process.env.AMAZON_MARKETPLACE||"com"); }

/* ---------------- Amazon affiliate helpers ---------------- */
function amazonDomainFromCC(cc="com"){ return `https://www.amazon.${(cc||"com").toLowerCase()}`; }
function buildAmazonSearchURL(query,{tag,marketplace}={}) {
  const base = amazonDomainFromCC(marketplace || process.env.AMAZON_MARKETPLACE || "com");
  const params = new URLSearchParams(); params.set("k", query);
  const assoc = tag || process.env.AFFILIATE_TAG; if (assoc) params.set("tag", assoc);
  return `${base}/s?${params.toString()}`;
}
function tinySearchLine(q, market){ const url = buildAmazonSearchURL(q,{marketplace:market});
  return `• ${escapeHtml(q)} 👉 <a href="${url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* ---------------- Link helpers ---------------- */
function stripMarkdownBasic(s=""){return s
  .replace(/(\*{1,3})([^*]+)\1/g,"$2").replace(/`([^`]+)`/g,"$1")
  .replace(/^#+\s*(.+)$/gm,"$1").replace(/!\[[^\]]*\]\([^)]+\)/g,"")
  .replace(/\[[^\]]+\]\([^)]+\)/g,"$&");}
const _STOP = new Set(["the","a","an","for","to","of","on","with","and","or","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great","kit","pads","brakes"]);
const _norm = s => (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
const _toks = s => _norm(s).split(" ").filter(t=>t&&!_STOP.has(t));
function buildOrderedTokenRegex(name){ const ts=_toks(name); if(!ts.length) return null;
  const chosen=ts.slice(0,Math.min(3,ts.length)); const pattern=chosen.map(t=>`(${t})`).join(`\\s+`);
  return new RegExp(`\\b${pattern}\\b`,"gi"); }
function injectAffiliateLinks(replyText="", products=[]) {
  if(!replyText || !products?.length) return replyText;
  let out = stripMarkdownBasic(replyText);
  for(const p of products){
    const url=p?.url, full=p?.name; if(!url||!full) continue;
    const tokenRe=buildOrderedTokenRegex(full);
    if(tokenRe && tokenRe.test(out)){
      out = out.replace(tokenRe, m=>`<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`);
      continue;
    }
    const esc = full.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const exactRe = new RegExp(`\\b(${esc})\\b`, "gi");
    if(exactRe.test(out)){
      out = out.replace(exactRe, `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">$1</a>`);
    }
  }
  return out;
}

/* ---------------- Product detection + extraction ---------------- */
const BRAND_WHITELIST = [
  "AMP Research","PowerStep","BAKFlip","UnderCover","TruXedo","Extang","Retrax",
  "Gator","Rough Country","Bilstein","DiabloSport","Hypertech","Motorcraft",
  "Power Stop","WeatherTech","Tyger","Nitto","BFGoodrich","Falken","K&N",
  "Borla","Flowmaster","Gator EFX","ArmorFlex","MX4","Ultra Flex","Lo Pro",
  "Sentry CT","Solid Fold","Husky","FOX","Rancho","Monroe","Moog","ACDelco",
  "Dorman","Bosch","NGK","Mopar","N-Fab","NFab","Westin","Go Rhino","Ionic",
  "Luverne","ARIES","Dee Zee","Tyger Auto","AMP"
];
const PRODUCT_TERMS =
  /(tonneau|bed\s*cover|lift\s*kit|level(ing)?\s*kit|tire|wheel|brake|pad|rotor|shock|strut|bumper|nerf\s*bar|nerf\s*bars|running\s*board|running\s*boards|side\s*step|side\s*steps|step\s*bar|step\s*bars|power ?step|tuner|programmer|intake|filter|exhaust|coilover|spring|winch|hitch|battery|floor\s*mat|bed\s*liner|rack|headlight|taillight)/i;

function isProductLike(text=""){
  if(!text) return false;
  if(PRODUCT_TERMS.test(text)) return true;
  return BRAND_WHITELIST.some(b => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(text));
}

function extractProductQueries({ userMsg, modelReply, vehicle, productType, max=4 }){
  const out=[];
  if(productType){
    const veh=[vehicle?.year,vehicle?.make,vehicle?.model].filter(Boolean).join(" ");
    if(veh) out.push(`${veh} ${productType}`);
  }
  const rx = /\b([A-Z][a-zA-Z]+(?:\s[A-Z0-9][a-zA-Z0-9\.\-]+){0,3})\b/g;
  const rep = (modelReply||"").match(rx)||[];
  const usr = (userMsg||"").match(rx)||[];
  [...rep,...usr].forEach(c=>{ if(BRAND_WHITELIST.some(b=>c.toLowerCase().includes(b.toLowerCase()))) out.push(c); });
  if(!out.length && isProductLike(userMsg||"")) out.push(userMsg.trim());
  const seen=new Set(), ded=[]; for(const s of out){ const k=s.toLowerCase().trim(); if(!k||seen.has(k)) continue; seen.add(k); ded.push(s.trim()); if(ded.length>=max) break; }
  return ded;
}

/* ---------------- Small-liners formatter ---------------- */
function toSmallLines(htmlOrText="") {
  if (/<(ul|ol|br|table|li)\b/i.test(htmlOrText)) return htmlOrText;
  const parts = String(htmlOrText).split(/\n\s*\n/g).map(s => s.trim()).filter(Boolean);
  const items = (parts.length ? parts : [htmlOrText])
    .flatMap(p => {
      const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z(])/g).filter(Boolean);
      return sentences.length ? sentences : [p];
    })
    .map(s => s.trim())
    .filter(Boolean);
  return items.map(line => `• ${escapeHtmlExceptAnchors(line)}`).join("<br>");
}
function escapeHtmlExceptAnchors(s=""){
  const keepA = s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return keepA.replace(/&lt;a\s/gi, "<a ").replace(/&lt;\/a&gt;/gi, "</a>");
}
function escapeHtml(s=""){
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ---------------- Diagnostics ---------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.post("/echo", (req,res)=>res.json({ ok:true, origin:req.headers.origin||null, ua:req.headers["user-agent"]||null }));

/* ---------------- Chat ---------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message, session, country:bodyCountry, market:bodyMarket } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(200).json({ reply: "Missing 'message' (string) in body." });
    }

    const country = normalizeCountry(bodyCountry) || detectCountryLimited(req);
    const marketplace = (bodyMarket || resolveMarketplace(country));
    const sessionId = (session || "visitor").toString().slice(0, 60);
    const sess = getSession(sessionId);

    // Parse possible *new* vehicle from this user turn
    const ext = externalIntent ? (externalIntent(message||"") || {}) : {};
    const fb  = parseVehicleFallback(message||"");
    const parsed = { ...ext, ...fb };

    // If user clearly mentioned a new/different truck, refresh (parsed will carry the new values)
    if (looksLikeNewTruck(message) && (parsed.year || parsed.make || parsed.model)) {
      sess.vehicle = {}; // reset old
      sess.flags.fitmentConfirmed = false;
      sess.flags.askedFitmentOnce = false;
    }

    // Merge memory
    const vehicle = mergeVehicleMemory(sess, parsed);

    // Update history after parsing so the model sees the current message too
    pushHistory(sess, "user", message);

    const hasCore = !!(vehicle.year && vehicle.make && vehicle.model);
    const miss = hasCore ? [] : missingFitment(vehicle);

    // Fitment gate: ONLY if clearly shopping AND 2+ core fields are missing AND we haven't asked before AND we don't already have core
    const wantsProducts = isProductLike(message);
    if (wantsProducts && !hasCore && miss.length >= 2 && !sess.flags.askedFitmentOnce) {
      const ask = toSmallLines(`To recommend exact parts, I need your truck’s ${miss.join(" & ")}.\n\nExample: 2020 Ford F-150 5.5 ft bed XLT`);
      sess.flags.askedFitmentOnce = true;
      pushHistory(sess, "assistant", ask);
      return res.status(200).json({ reply: ask });
    }

    // If user says "yes" and we still don't have core, ask once (but not repeatedly)
    if (saidYes(message) && !hasCore && !sess.flags.askedFitmentOnce) {
      const ask = toSmallLines("Great! What’s your truck’s **year, make, and model**?\n\nExample: 2020 Ford F-150 5.5 ft bed XLT");
      sess.flags.askedFitmentOnce = true;
      pushHistory(sess, "assistant", ask);
      return res.status(200).json({ reply: ask });
    }

    // Compose system prompt + history
    const systemPrompt = `
You are "Trucks Helper" — a precise, friendly truck expert.
- Be concise and skimmable: 1–3 sentences per idea, separate ideas with blank lines.
- When asked "how to", give clear steps + safety notes first.
- Use the known vehicle profile for fitment/product guidance.
- Ask at most ONE follow-up for missing fitment (only if 2+ core fields are missing).
- If only ONE core field is missing, answer anyway and add a single soft ask at the end.
- Do not paste URLs; the system injects links afterwards.
- Tone: practical, human.`;

    const isHowTo = looksLikeHowTo(message);
    const base = [{ role:"system", content:systemPrompt }, ...sess.history];

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: isHowTo ? 0.35 : 0.55,
      messages: base
    });

    let replyRaw = r?.choices?.[0]?.message?.content
      || "I couldn’t find a clear answer.";

    // Small-liners formatting first
    let reply = toSmallLines(replyRaw);

    // Product-type heuristic for link seeding
    const low = message.toLowerCase();
    let productType = null;
    if (isHowTo && /brake|pad|rotor/.test(low)) productType = "brake pads";
    else if (/brake pad|brakes|rotor/.test(low)) productType = "brake pads";
    else if (/tonneau|bed cover/.test(low)) productType = "tonneau cover";
    else if (/lift kit|leveling/.test(low)) productType = "lift kit";
    else if (/tire|all terrain|mud terrain/.test(low)) productType = "tires";
    else if (/tuner|programmer|diablosport|hypertech|hyper tuner/.test(low)) productType = "tuner";
    else if (/(nerf bar|nerf bars|running board|running boards|side step|side steps|step bar|step bars|power ?step|rock slider|rock sliders)/i.test(low)) productType = "running boards";

    // Build product queries (before footer)
    let queries = extractProductQueries({ userMsg: message, modelReply: replyRaw, vehicle, productType, max: 4 });

    // Fallback seed if clearly shopping
    if (!queries.length && (isProductLike(message) || isProductLike(replyRaw))) {
      const veh = hasCore ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : "";
      const seedType = productType || "truck accessories";
      queries = [veh ? `${veh} ${seedType}` : seedType];
    }

    // Inject links if any queries
    if (queries.length) {
      reply = injectAffiliateLinks(
        reply,
        queries.map(q => ({ name:q, url: buildAmazonSearchURL(q, { marketplace }) }))
      );
      const lines = queries.map(q => tinySearchLine(q, marketplace)).join("<br>");
      reply = `${reply}<br><br>${toSmallLines("You might consider:")}<br>${lines}<br>${toSmallLines("As an Amazon Associate, we may earn from qualifying purchases.")}`;
    }

    // Soft ask ONLY if exactly one core field is missing (we answered already)
    if (!hasCore && missingFitment(vehicle).length === 1 && !sess.flags.askedFitmentOnce) {
      const one = missingFitment(vehicle)[0];
      reply += `<br><br>${toSmallLines(`What’s your **${one}**? That lets me verify exact fitment.`)}`;
      sess.flags.askedFitmentOnce = true;
    }

    // Natural follow-up to keep convo going
    if (isHowTo && !sess.flags.offeredAfterHowTo) {
      reply += `<br><br>${toSmallLines("Want me to pull **parts that fit your vehicle** for this job?")}`;
      sess.flags.offeredAfterHowTo = true;
      sess.flags.lastTopic = productType || sess.flags.lastTopic || "project";
    } else {
      const follow = productType
        ? `Do you want me to compare a few **${productType}** options for your${hasCore ? ` ${vehicle.year} ${vehicle.make} ${vehicle.model}` : ""}?`
        : looksLikeHowTo(message)
          ? "Do you already have tools and torque specs, or should I list them?"
          : "Want quick fitment checks or price ranges for that?";
      reply += `<br><br>${toSmallLines(follow)}`;
      if (productType) sess.flags.lastTopic = productType;
    }

    pushHistory(sess, "assistant", reply);
    return res.status(200).json({ reply });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.status(200).json({
      reply: toSmallLines("I’m having trouble reaching the AI right now.\n\nShare your truck year, make, and model — I’ll fetch exact parts that fit.")
    });
  }
});

/* ---------------- Widget demo (optional) ---------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/widget", (_req,res)=>res.type("html").send("<html><body>OK</body></html>"));

/* ---------------- Start ---------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running with sticky fitment memory on :${PORT}`));
