// server.js — Chat + memory + crisp liners + human follow-ups + inline product links only + GEO (US/UK/CA)
// - Strong CORS (Android/AMP-safe), OPTIONS preflight
// - Remembers vehicle per session (year/make/model/etc.)
// - Replies are short, skimmable lines (no big paragraphs)
// - Affiliate links ONLY inline on real product names (no footer "View on Amazon" list)
// - One-time fitment ask per session
// - No affiliate disclaimer text in replies
// - /widget endpoint (works in normal + AMP <amp-iframe>)

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

// keep if you have it
import { extractIntent } from "./recommend.js";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

/* ---------------- CORS: robust for Android/AMP ---------------- */
const RAW_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://trucksenthusiasts.com,https://www.trucksenthusiasts.com,https://cdn.ampproject.org,https://*.ampproject.org,https://www.google.com"
).split(",").map(s => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin, curl, some webviews
  return RAW_ORIGINS.some(pat => {
    if (pat.includes("*")) {
      const re = new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return re.test(origin);
    }
    return origin === pat;
  });
}
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------- OpenAI ---------------- */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.MODEL || "gpt-4o-mini";
const PORT   = process.env.PORT || 3000;

/* ---------------- Session memory ---------------- */
const SESSIONS = new Map(); // sessionId -> { history: [], vehicle:{}, flags:{} }
const MAX_TURNS = 16;

function getSession(sessionId) {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, {
      history: [],
      vehicle: {},
      flags: { askedFitmentOnce: false, offeredUpsellAfterHowTo: false }
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
const HOWTO_KEYWORDS = [
  "how to","how do i","procedure","steps","install","replace","change","fix","tutorial","guide"
];
function looksLikeHowTo(s=""){const t=s.toLowerCase();return HOWTO_KEYWORDS.some(k=>t.includes(k));}

function mergeVehicleMemory(sess, from = {}) {
  const v = sess.vehicle || {};
  const merged = {
    year:   from.year   || v.year   || null,
    make:   from.make   || v.make   || null,
    model:  from.model  || v.model  || null,
    bed:    from.bed    || v.bed    || null,
    trim:   from.trim   || v.trim   || null,
    engine: from.engine || v.engine || null,
  };
  sess.vehicle = merged; return merged;
}
function missingFitment(vehicle) {
  const miss=[]; if(!vehicle.year) miss.push("year"); if(!vehicle.make) miss.push("make"); if(!vehicle.model) miss.push("model"); return miss;
}
function saidYes(s=""){ return /\b(yes|yeah|yup|sure|ok|okay|please do|go ahead|why not)\b/i.test(s); }

/* ---------------- Greetings ---------------- */
const GREET_RE = /^\s*(hi|hello|hey|yo|sup|hola|howdy|good\s*(morning|afternoon|evening))\b[\s!\.\?]*$/i;
function isGreetingOrSmallTalk(text=""){ return GREET_RE.test(text) || text.trim().length < 2; }

/* ---------------- GEO -> Amazon marketplace ---------------- */
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

/* ---------------- Amazon helpers ---------------- */
function amazonDomainFromCC(cc="com"){ return `https://www.amazon.${(cc||"com").toLowerCase()}`; }
function buildAmazonSearchURL(query,{tag,marketplace}={}) {
  const base = amazonDomainFromCC(marketplace || process.env.AMAZON_MARKETPLACE || "com");
  const params = new URLSearchParams(); params.set("k", query);
  const assoc = tag || process.env.AFFILIATE_TAG; if (assoc) params.set("tag", assoc);
  return `${base}/s?${params.toString()}`;
}
function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, (ch) => {
    const map = { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" };
    return map[ch] || ch;
  });
}

/* ---------------- Product intent (brand-agnostic) ---------------- */
const CATEGORY_TERMS = [
  "suspension","suspension system",
  "cold air intake","air intake","intake","intake kit","intake filter","air filter",
  "tonneau cover","bed cover","retractable tonneau","tri-fold tonneau","hard folding cover","soft roll-up cover",
  "lift kit","leveling kit","shocks","struts","coilovers","springs",
  "brake pads","rotors","brakes",
  "running boards","nerf bars","side steps","power steps","rock sliders",
  "floor mats","bed liner","rack","exhaust","muffler","cat-back","header",
  "tuner","programmer","scanner",
  "headlights","taillights","light bar","fog lights",
  "wheels","tires","all terrain","mud terrain"
];
const CATEGORY_RE = new RegExp("\\b(" + CATEGORY_TERMS.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|") + ")\\b","gi");
function detectCategories(text=""){
  const set = new Set(); let m;
  while ((m = CATEGORY_RE.exec(text)) !== null) set.add(m[1].toLowerCase());
  return [...set];
}

// Tire brands so "Brand Model" counts as a product even with no digits.
const TIRE_BRANDS = [
  "Goodyear","BFGoodrich","Michelin","Bridgestone","Nitto","Toyo","Pirelli",
  "Continental","Cooper","Yokohama","Falken","General","Hankook","Kumho","Nokian","Firestone","Dunlop"
];

const NON_PRODUCT_PHRASES = [
  "determine compatibility","choose type","research brands","read reviews",
  "compare prices","check features","warranty & support","warranty and support",
  "safety notes","installation","backup","legal compliance","compatibility",
  "research","compare","check","warranty","support","safety","legal","best"
];

const PRODUCT_TOKENS = [
  "series","kit","intake","filter","pads","rotors","brake","cover","shocks","struts","coilover","springs",
  "tuner","programmer","exhaust","muffler","header","cat-back","nerf","board","boards","steps","step","slider","sliders",
  "mat","mats","liner","rack","headlight","headlights","taillight","taillights","tire","tires","wheel","wheels",
  "bar","light","lights","led","winch","hitch","battery"
];

const MAKES = ["ford","chevrolet","chevy","gmc","ram","dodge","toyota","nissan","jeep","honda","subaru"];
const PROD_PHRASE_RE = /\b([A-Z][A-Za-z0-9&\-]+(?:\s+[A-Z0-9][A-Za-z0-9&\-]+){1,6})\b/g;

function looksLikeVehicleOnly(phrase=""){
  const lc = phrase.toLowerCase();
  if (/\b(19|20)\d{2}\b/.test(lc) && MAKES.some(m=>lc.includes(m))) return true;
  if (/(f[\s-]?150|silverado|sierra|tacoma|tundra|ranger|ram\s?1500|gladiator|maverick|colorado|frontier)/i.test(phrase) && MAKES.some(m=>lc.includes(m))) return true;
  return false;
}
function startsWithTireBrand(phrase=""){
  const first = (phrase.split(/\s+/)[0] || "").replace(/[^\w]/g,"");
  return TIRE_BRANDS.includes(first);
}
function isProductishPhrase(phrase=""){
  const lc = phrase.toLowerCase();
  if (NON_PRODUCT_PHRASES.some(p => lc.includes(p))) return false;
  if (looksLikeVehicleOnly(lc)) return false;
  const hasToken = PRODUCT_TOKENS.some(tok => lc.split(/\s+/).includes(tok)) ||
                   ["cold air intake","light bar","bed liner","floor mats","cat-back"].some(t => lc.includes(t));
  const hasAlphaNumMix = /\b(?:[a-z]*\d+[a-z]+|[a-z]+[0-9]+)\b/i.test(phrase) || /&/.test(phrase);
  const brandModel = startsWithTireBrand(phrase) && phrase.trim().split(/\s+/).length >= 2;
  return hasToken || hasAlphaNumMix || brandModel;
}
function harvestProductPhrases(text=""){
  if (!text) return [];
  const hits = new Set(); let m;
  while ((m = PROD_PHRASE_RE.exec(text)) !== null) {
    const raw = m[1].trim().replace(/\s{2,}/g," ").replace(/[.,;:)\]]+$/,"");
    if (!/[A-Za-z]/.test(raw)) continue;
    if (!isProductishPhrase(raw)) continue;
    hits.add(raw);
  }
  return [...hits];
}
function isShoppingIntent(text=""){
  if (!text) return false;
  if (detectCategories(text).length) return true;
  if (harvestProductPhrases(text).length) return true;
  return /\b(cover|intake|kit|pads?|rotors?|brake|shocks?|struts?|tire|wheel|nerf|running|step|winch|tuner|mat|liner|rack|headlight|taillight|exhaust|filter|suspension)\b/i.test(text);
}

/* ---------------- Safe link injection (inline products only) ---------------- */
function stripMarkdownBasic(s=""){return s
  .replace(/(\*{1,3})([^*]+)\1/g,"$2").replace(/`([^`]+)`/g,"$1")
  .replace(/^#+\s*(.+)$/gm,"$1").replace(/!\[[^\]]*\]\([^)]+\)/g,"")
  .replace(/\[[^\]]+\]\([^)]+\)/g,"$&");}
const _STOP = new Set(["the","a","an","for","to","of","on","with","and","or","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great","kit","pads","brakes","suspension","system"]);
const _norm = s => (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
const _toks = s => _norm(s).split(" ").filter(t=>t&&!_STOP.has(t));
function buildOrderedTokenRegex(name){ const ts=_toks(name); if(!ts.length) return null;
  const chosen=ts.slice(0,Math.min(3,ts.length)); const pattern=chosen.map(t=>`(${t})`).join(`\\s+`);
  return new RegExp(`\\b${pattern}\\b`,"gi"); }
function protectAnchors(text){
  const anchors=[]; const out=text.replace(/<a\b[^>]*>.*?<\/a>/gi, m=>{ anchors.push(m); return `__A${anchors.length-1}__`; });
  return { out, anchors };
}
function restoreAnchors(text, anchors){ return text.replace(/__A(\d+)__/g, (_,i)=>anchors[+i]); }

// IMPORTANT: we accept "items" with { name, url, kind } and SKIP linking for kind === "cat".
function injectAffiliateLinks(replyText="", items=[]) {
  if(!replyText || !items?.length) return replyText;
  let out = stripMarkdownBasic(replyText);
  for (const it of items){
    if (!it || it.kind === "cat") continue; // only products get inline links
    const url=it.url, full=it.name; if(!url||!full) continue;
    let { out: noA, anchors } = protectAnchors(out);
    const tokenRe=buildOrderedTokenRegex(full);
    if(tokenRe && tokenRe.test(noA)){
      noA = noA.replace(tokenRe, m=>`<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`);
    } else {
      const esc = full.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const exactRe = new RegExp(`\\b(${esc})\\b`, "gi");
      if(exactRe.test(noA)){
        noA = noA.replace(exactRe, `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">$1</a>`);
      }
    }
    out = restoreAnchors(noA, anchors);
  }
  return out;
}

/* ---------------- Query extraction (products + categories) ---------------- */
function vehicleString(v){ return [v?.year,v?.make,v?.model].filter(Boolean).join(" "); }
function buildVehicleAwareQuery(vehicle, q) {
  const veh = vehicleString(vehicle);
  return [veh, q].filter(Boolean).join(" ").trim();
}
function buildQueryItems({ userMsg, modelReply, vehicle, max=8 }){
  const items = [];
  const seen = new Set();
  for (const c of detectCategories(userMsg||"")) {
    const key = `cat:${c}`; if (seen.has(key)) continue; seen.add(key);
    items.push({ display: c, query: buildVehicleAwareQuery(vehicle, c), kind: "cat" });
    if (items.length >= max) return items;
  }
  for (const c of detectCategories(modelReply||"")) {
    const key = `cat:${c}`; if (seen.has(key)) continue; seen.add(key);
    items.push({ display: c, query: buildVehicleAwareQuery(vehicle, c), kind: "cat" });
    if (items.length >= max) return items;
  }
  for (const p of harvestProductPhrases(userMsg||"")) {
    const key = `p:${p.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key);
    items.push({ display: p, query: buildVehicleAwareQuery(vehicle, p), kind: "prod" });
    if (items.length >= max) return items;
  }
  for (const p of harvestProductPhrases(modelReply||"")) {
    const key = `p:${p.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key);
    items.push({ display: p, query: buildVehicleAwareQuery(vehicle, p), kind: "prod" });
    if (items.length >= max) return items;
  }
  return items;
}

/* ---------------- Liners: force short, readable lines ---------------- */
function toLiners(text=""){
  if (!text) return text;
  const raw = text
    .replace(/\r/g,"")
    .replace(/[•\u2022]/g,"• ")
    .replace(/\n{2,}/g,"\n")
    .replace(/(\d+)\.\s+/g, "$1) ")
    .replace(/\s*-\s+/g, " — ");
  const chunks = raw.split(/\n/).flatMap(line => {
    return line
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])|(?<=\))\s+|(?<=—)\s+/)
      .map(s => s.trim()).filter(Boolean);
  });
  const bullets = [];
  for (let s of chunks) {
    const parts = s.split(/\s—\s/).map(p=>p.trim()).filter(Boolean);
    for (const p of parts) {
      const line = p.startsWith("•") ? p : `• ${p}`;
      bullets.push(line);
    }
  }
  return bullets.filter((l,i,a)=> i===0 || l !== a[i-1]).join("\n");
}

/* ---------------- Targeted follow-ups (human phrasing) ---------------- */
function primaryCategoryFrom(items, userMsg){
  if (items && items.length) return items[0].display.toLowerCase();
  const cats = detectCategories(userMsg||"");
  return cats.length ? cats[0] : null;
}
function targetedFollowUp(userMsg, vehicle, items){
  const cat = primaryCategoryFrom(items, userMsg);
  const veh = vehicleString(vehicle);

  if (!cat) {
    if (looksLikeHowTo(userMsg)) {
      return veh
        ? "• If you want, I can pull parts and torque specs that fit your setup."
        : "• If you share your year/make/model, I can pull parts and torque specs that fit.";
    }
    return "• If you tell me your budget or a brand you like, I’ll narrow it for you.";
  }

  if (cat.includes("suspension") || cat.includes("lift") || cat.includes("level")) {
    return [
      "• What **lift/level height** are you aiming for (e.g., 1–2\", 3–4\")?",
      "• **2WD or 4WD**, and keep factory ride or firmer?",
      "• Planned **wheel/tire size + offset** (helps with clearance)?",
      "• Any budget range I should stay within?"
    ].join("\n");
  }
  if (cat.includes("tuner") || cat.includes("programmer")) {
    return [
      "• Which **engine** (2.7/3.5 EcoBoost, 5.0)?",
      "• Goal: **power**, **MPG**, or **tow**?",
      "• Preloaded tunes only or **custom dyno** later?",
      "• Ballpark budget?"
    ].join("\n");
  }
  if (cat.includes("intake")) {
    return [
      "• **Open** (more sound) or **sealed box** (quieter/better IATs)?",
      "• Planning a **tune** soon?",
      "• **Dry** vs **oiled** filter?"
    ].join("\n");
  }
  if (cat.includes("brake")) {
    return [
      "• Daily, **towing**, or spirited?",
      "• **Low dust/quiet** or **max bite**?",
      "• Okay with **slotted/drilled** or prefer plain?"
    ].join("\n");
  }
  if (cat.includes("running") || cat.includes("nerf") || cat.includes("step")) {
    return [
      "• **Power-deploying** or **fixed**?",
      "• Need **drop steps**?",
      "• Finish: **black** or **stainless**?"
    ].join("\n");
  }
  if (cat.includes("tonneau") || cat.includes("bed cover")) {
    return [
      "• **Hard** vs **soft**?",
      "• **Tri-fold**, **roll-up**, or **retractable**?",
      "• Priority: **security**, **weather seal**, or **price**?"
    ].join("\n");
  }
  if (cat.includes("tire") || cat.includes("wheels")) {
    return [
      "• Use case: **Highway**, **A/T**, or **M/T**?",
      "• Desired **size** and **wheel offset** (I’ll check rubbing)?",
      "• Preference: **low noise** or **maximum grip**?"
    ].join("\n");
  }
  return "• Any must-have features or a target budget?";
}

/* ---------------- Diagnostics ---------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.post("/echo", (req,res)=>res.json({ ok:true, origin:req.headers.origin||null, ua:req.headers["user-agent"]||null }));

/* ---------------- Chat ---------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message, session, country:bodyCountry, market:bodyMarket } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(200).json({ reply: "• Tell me what you’d like help with (parts, fitment, or a how-to)." });
    }

    const country = normalizeCountry(bodyCountry) || detectCountryLimited(req);
    const marketplace = (bodyMarket || resolveMarketplace(country));
    const sessionId = (session || "visitor").toString().slice(0, 60);
    const sess = getSession(sessionId);

    // Update memory
    pushHistory(sess, "user", message);

    // Parse + merge vehicle
    const parsed = extractIntent ? (extractIntent(message||"") || {}) : {};
    const vehicle = mergeVehicleMemory(sess, parsed);

    // One-time fitment ask (only when needed)
    const miss = missingFitment(vehicle);
    const wantsProducts = isShoppingIntent(message);
    if (!sess.flags.askedFitmentOnce) {
      if (saidYes(message) && miss.length > 0) {
        const ask = "• Great—what’s your **year, make, model**? (e.g., 2020 Ford F-150 5.5 ft bed)";
        sess.flags.askedFitmentOnce = true;
        pushHistory(sess, "assistant", ask);
        return res.status(200).json({ reply: ask });
      }
      if (wantsProducts && miss.length >= 2) {
        const ask = `• To dial this in, what’s your **${miss.join(" & ")}**?\n• Example: 2020 Ford F-150 5.5 ft bed`;
        sess.flags.askedFitmentOnce = true;
        pushHistory(sess, "assistant", ask);
        return res.status(200).json({ reply: ask });
      }
    }

    const systemPrompt = `
You are "Trucks Helper" — precise, friendly, human.
Write short, skimmable lines (bullets). Avoid long paragraphs.
For HOW-TO: steps first, then safety notes.
Use known vehicle details; do not re-ask fitment more than once.
No raw URLs; links are injected later.`;

    const base = [{ role:"system", content:systemPrompt }, ...sess.history];
    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: looksLikeHowTo(message) ? 0.35 : 0.5,
      messages: base
    });

    let reply = r?.choices?.[0]?.message?.content
      || (isGreetingOrSmallTalk(message) ? "• Hi! How can I help today?" : "• Tell me what you’re working on and I’ll jump in.");

    // Build link targets (products + categories), but only inline-link products; NO footer list.
    let items = [];
    if (!isGreetingOrSmallTalk(message)) {
      items = buildQueryItems({ userMsg: message, modelReply: reply, vehicle, max: 8 });

      if (items.length) {
        const linkTargets = items.map(it => ({
          name: it.display,
          url: buildAmazonSearchURL(it.query, { marketplace }),
          kind: it.kind
        }));
        // Inline links for products only (kind !== "cat")
        reply = injectAffiliateLinks(reply, linkTargets);
      }
    }

    // Liners + targeted follow-up (no "You might consider" block anymore)
    let small = toLiners(reply);
    small += `\n\n${toLiners(targetedFollowUp(message, vehicle, items))}`;

    // Pure greeting: super clean
    if (isGreetingOrSmallTalk(message)) {
      small = "• Hi! How can I help today?\n• Parts, fitment, or a quick how-to — ask away.";
    }

    // Optional upsell after HOW-TO (once)
    if (looksLikeHowTo(message) && !sess.flags.offeredUpsellAfterHowTo) {
      small += `\n• Want me to fetch a parts list for this job?`;
      sess.flags.offeredUpsellAfterHowTo = true;
    }

    pushHistory(sess, "assistant", small);
    return res.status(200).json({ reply: small });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.status(200).json({
      reply: "• I’m having trouble reaching the AI.\n• Share your truck **year/make/model** and what you need, and I’ll pick it up next."
    });
  }
});

/* ---------------- Lightweight embeddable widget page ---------------- */
app.get("/widget", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Truck Assistant</title>
<style>
:root{--bg:#0b0f14;--panel:#111923;--border:#213040;--accent:#1f6feb;--text:#e6edf3;--muted:#9bbcff}
html,body{margin:0;height:100%}body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Roboto;display:flex;flex-direction:column}
header{display:flex;gap:10px;align-items:center;padding:12px;background:var(--panel);border-bottom:1px solid var(--border)}
header .logo{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--accent);font-size:16px}
#msgs{flex:1;overflow:auto;padding:12px}
.msg{margin:8px 0}.who{font-size:11px;opacity:.7;margin-bottom:4px}
.bubble{background:#141a22;border:1px solid var(--border);border-radius:12px;padding:10px 12px;white-space:pre-wrap}
.me .bubble{background:rgba(31,111,235,.1);border-color:#2a3b52}
form{display:flex;gap:8px;padding:10px;background:var(--panel);border-top:1px solid var(--border)}
input{flex:1;border:1px solid #2a3b52;border-radius:10px;background:var(--bg);color:var(--text);padding:10px}
button{border:0;border-radius:10px;background:var(--accent);color:#fff;padding:10px 14px;font-weight:700;cursor:pointer}
footer{font-size:11px;text-align:center;opacity:.7;padding:6px 10px}
a{color:var(--muted);text-decoration:underline}
.think{font-size:12px;opacity:.7;margin:4px 0 0 0}
</style>
<header><div class="logo">🚚</div><div><strong>AI Truck Assistant</strong></div></header>
<main id="msgs"></main>
<footer>As an Amazon Associate, we may earn from qualifying purchases.</footer>
<form id="f" autocomplete="off">
  <input id="q" placeholder="Ask about F-150 lifts, tires, covers…">
  <button type="submit">Send</button>
</form>
<script>
(() => {
  const API = "/chat";
  const $m = document.getElementById('msgs');
  const $f = document.getElementById('f');
  const $q = document.getElementById('q');
  const SESS = (Math.random().toString(36).slice(2)) + Date.now();

  function add(role, html){
    const d=document.createElement('div'); d.className='msg '+(role==='You'?'me':'ai');
    d.innerHTML='<div class="who">'+role+'</div><div class="bubble">'+html+'</div>';
    $m.appendChild(d); $m.scrollTop=$m.scrollHeight;
    try{ parent.postMessage({type:'embed-size',height:document.body.scrollHeight},'*'); }catch(e){}
    d.querySelectorAll('a[href]').forEach(a=>{a.target='_blank'; a.rel='nofollow sponsored noopener';});
    return d;
  }
  function addThinking(){
    const d=document.createElement('div'); d.className='msg ai';
    const bubble=document.createElement('div'); bubble.className='bubble';
    const status=document.createElement('div'); status.className='think'; status.textContent='Thinking…';
    bubble.textContent='…';
    bubble.appendChild(status);
    d.appendChild(bubble); $m.appendChild(d); $m.scrollTop=$m.scrollHeight;
    const steps=['Thinking…','Analyzing your question…','Checking fitment…','Exploring best options…','Composing answer…'];
    let i=0; const id=setInterval(()=>{ status.textContent=steps[i++%steps.length]; }, 1200);
    return {node:d, stop:()=>clearInterval(id)};
  }

  add('AI',"• Hi! I’m your AI truck helper.\n• Parts, fitment, or a quick how-to — ask away.");

  $f.addEventListener('submit', async e=>{
    e.preventDefault();
    const text=$q.value.trim(); if(!text) return;
    add('You', text); $q.value='';
    const th=addThinking();

    try{
      const r=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},mode:'cors',credentials:'omit',
        body: JSON.stringify({ message:text, session:SESS })});
      let data; const ct=(r.headers.get('content-type')||'').toLowerCase();
      if(ct.includes('application/json')) data=await r.json();
      else data={ reply:'Server returned a non-JSON response.' };
      th.stop(); th.node.remove();
      add('AI', (data && data.reply) ? data.reply : 'Sorry, I couldn’t get a response.');
    }catch(err){
      th.stop(); th.node.remove();
      add('AI',"Can’t reach the AI right now (network or CORS). Please try again.");
    }
  });
})();
</script>
</html>`);
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running on :${PORT}`));
