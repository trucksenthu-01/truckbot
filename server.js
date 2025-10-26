// server.js — Conversational follow-ups + no-nag fitment + guarded links + GEO
// - Natural answers first; smart follow-ups next (like ChatGPT)
// - How-to -> offer parts help; “Yes” -> (collect fitment if needed) -> recommend
// - Session memory: year/make/model/etc.
// - Amazon SEARCH links with affiliate + GEO (.com/.co.uk/.ca)
// - Links only for product-like intent; tiny “You might consider” footer
// - Cooldowns prevent repeat askbacks

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
   In-memory session store
---------------------------------------- */
// session: { history:[], vehicle:{}, _asked_fitment_at, _pending_offer:{type, at}, _awaiting_fitment_for?:string }
const SESSIONS = new Map();
const MAX_TURNS = 16;

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
   Intent helpers
---------------------------------------- */
const HOWTO_KEYWORDS = ["how to","how do i","procedure","steps","install","replace","change","fix","tutorial"];
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
  return missing;
}

const BRAND_WHITELIST = [
  "AMP Research","PowerStep","BAKFlip","UnderCover","TruXedo","Extang","Retrax",
  "Gator","Rough Country","Bilstein","DiabloSport","Hypertech","Motorcraft",
  "Power Stop","WeatherTech","Tyger","Nitto","BFGoodrich","Falken","K&N",
  "Borla","Flowmaster","Gator EFX","ArmorFlex","MX4","Ultra Flex","Lo Pro",
  "Sentry CT","Solid Fold","Husky","FOX","Rancho","Monroe","Moog","ACDelco",
  "Dorman","Bosch","NGK","Mopar","N-Fab","NFab","Westin","Go Rhino","Ionic",
  "Luverne","ARIES","Dee Zee","Tyger Auto"
];

const PRODUCT_TERMS =
  /(tonneau|bed\s*cover|lift\s*kit|level(ing)?\s*kit|tire|wheel|brake|pad|rotor|shock|strut|bumper|nerf\s*bar|nerf\s*bars|running\s*board|running\s*boards|side\s*step|side\s*steps|step\s*bar|step\s*bars|power ?step|tuner|programmer|intake|filter|exhaust|coilover|spring|winch|hitch|battery|floor\s*mat|bed\s*liner|rack|headlight|taillight)/i;

function isProductLike(text = "") {
  if (!text) return false;
  if (PRODUCT_TERMS.test(text)) return true;
  const lower = text.toLowerCase();
  return BRAND_WHITELIST.some(b => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(lower));
}
function isGeneralInfoIntent(s = "") {
  return /(issue|issues|problem|symptom|noise|vibration|cause|risk|signs|maintenance|service|interval|torque|why|what|difference|pros|cons|lifespan|wear|troubleshoot|diagnose|guide|tips)/i.test(s);
}
function isBuyingOrFitmentIntent(s = "") {
  return /(fit|fitment|compatible|which|exact|part|sku|model number|buy|price|link|recommend|best|options|where to buy|get|order)/i.test(s);
}
function isAffirmation(s=""){ return /\b(yes|yeah|yup|sure|ok|okay|please|do it|go ahead|why not)\b/i.test(s); }
function isNegation(s=""){ return /\b(no|nope|not now|later|maybe later|skip|cancel)\b/i.test(s); }

/* ---------------------------------------
   GEO helpers
---------------------------------------- */
const COUNTRY_TO_TLD_LIMITED = { US:"com", GB:"co.uk", UK:"co.uk", CA:"ca" };
function normalizeCountry(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (s.length === 2) return s.toUpperCase();
  const m = s.match(/[-_](\w{2})$/);
  return m ? m[1].toUpperCase() : s.substring(0,2).toUpperCase();
}
function detectCountryLimited(req, explicitCountry) {
  const direct = normalizeCountry(explicitCountry);
  if (direct) return direct;
  const h = req.headers || {};
  return normalizeCountry(h["cf-ipcountry"])
      || normalizeCountry(h["x-vercel-ip-country"])
      || normalizeCountry(h["x-country-code"])
      || (()=>{ const al=h["accept-language"]; if(!al) return null; return normalizeCountry(al.split(",")[0]); })()
      || null;
}
function resolveMarketplace(countryLimited) {
  if (countryLimited && COUNTRY_TO_TLD_LIMITED[countryLimited]) return COUNTRY_TO_TLD_LIMITED[countryLimited];
  return process.env.AMAZON_MARKETPLACE || "com";
}

/* ---------------------------------------
   Amazon link builders
---------------------------------------- */
function amazonDomainFromCC(cc="com") { return `https://www.amazon.${(cc||"com").toLowerCase()}`; }
function buildAmazonSearchURL(query, { tag, marketplace } = {}) {
  const base = amazonDomainFromCC(marketplace || process.env.AMAZON_MARKETPLACE || "com");
  const params = new URLSearchParams();
  params.set("k", query);
  const assoc = tag || process.env.AFFILIATE_TAG;
  if (assoc) params.set("tag", assoc);
  return `${base}/s?${params.toString()}`;
}
function tinySearchLine(q, market) {
  const url = buildAmazonSearchURL(q, { marketplace: market });
  return `• ${q} 👉 <a href="${url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* -------- inline link injection (fuzzy) -------- */
function stripMarkdownBasic(s=""){
  return s.replace(/(\*{1,3})([^*]+)\1/g,"$2").replace(/`([^`]+)`/g,"$1").replace(/^#+\s*(.+)$/gm,"$1")
          .replace(/!\[[^\]]*\]\([^)]+\)/g,"").replace(/\[[^\]]+\]\([^)]+\)/g,"$&");
}
const _STOP = new Set(["the","a","an","for","to","of","on","with","and","or","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great","kit","pads","brakes"]);
const _norm = s => (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
const _toks = s => _norm(s).split(" ").filter(t => t && !_STOP.has(t));
function buildOrderedTokenRegex(name){
  const ts = _toks(name); if(!ts.length) return null;
  const chosen = ts.slice(0, Math.min(3, ts.length));
  return new RegExp(`\\b${chosen.map(t=>`(${t})`).join(`\\s+`)}\\b`,"gi");
}
function injectAffiliateLinks(replyText="", products=[]){
  if (!replyText || !Array.isArray(products) || !products.length) return replyText;
  let out = stripMarkdownBasic(replyText);
  for (const p of products) {
    const url = p?.url, full = p?.name; if(!url || !full) continue;
    const tokenRe = buildOrderedTokenRegex(full);
    if (tokenRe && tokenRe.test(out)) {
      out = out.replace(tokenRe, m => `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`);
      continue;
    }
    const esc = full.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const exact = new RegExp(`\\b(${esc})\\b`,"gi");
    if (exact.test(out)) out = out.replace(exact, `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">$1</a>`);
  }
  return out;
}

/* ---------------------------------------
   Build product queries
---------------------------------------- */
function extractProductQueries({ userMsg, modelReply, vehicle, productType, max = 4 }) {
  const out = [];
  if (productType) {
    const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
    if (veh) out.push(`${veh} ${productType}`);
  }
  const cap = /\b([A-Z][a-zA-Z]+(?:\s[A-Z0-9][a-zA-Z0-9\.\-]+){0,3})\b/g;
  for (const s of (modelReply || "").match(cap) || []) if (BRAND_WHITELIST.some(b => s.toLowerCase().includes(b.toLowerCase()))) out.push(s);
  for (const s of (userMsg   || "").match(cap) || []) if (BRAND_WHITELIST.some(b => s.toLowerCase().includes(b.toLowerCase()))) out.push(s);
  if (!out.length && isProductLike(userMsg || "")) out.push(userMsg.trim());
  const seen=new Set(), ded=[];
  for (const s of out){ const k=s.toLowerCase().trim(); if(!k||seen.has(k)) continue; seen.add(k); ded.push(s.trim()); if(ded.length>=max) break; }
  return ded;
}

/* ---------------------------------------
   Diagnostics
---------------------------------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.get("/diag", (req,res)=> {
  const country = detectCountryLimited(req);
  const marketplace = resolveMarketplace(country);
  res.json({
    ok:true, model: MODEL, has_api_key: !!process.env.OPENAI_API_KEY,
    allowed_origins: allowed, sessions: SESSIONS.size,
    affiliate_tag: process.env.AFFILIATE_TAG || null,
    default_marketplace: process.env.AMAZON_MARKETPLACE || "com",
    detected_country: country, resolved_marketplace: marketplace
  });
});
app.get("/debug/anchor", (_req,res) => res.send('Test anchor → <a href="https://amazon.com" target="_blank" rel="nofollow">Amazon</a>'));

/* ---------------------------------------
   Chat endpoint
---------------------------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message, session, country: bodyCountry, market: bodyMarket } = req.body || {};
    if (!message || typeof message !== "string") return res.status(400).json({ reply: "Missing 'message' (string) in body." });

    const country = normalizeCountry(bodyCountry) || detectCountryLimited(req);
    const marketplace = (bodyMarket || resolveMarketplace(country));
    const sessionId = (session || "visitor").toString().slice(0, 60);
    const sess = getSession(sessionId);

    // Track history + vehicle
    pushHistory(sess, "user", message);
    const parsed = extractIntent(message || "");
    const vehicle = mergeVehicleMemory(sess, parsed);
    const miss = missingFitment(vehicle);
    const msg = (message || "").toLowerCase();

    /* ---------- Follow-up flow handling ---------- */

    // If user is replying to our pending offer:
    if (sess._pending_offer) {
      const pType = sess._pending_offer.type;
      if (isNegation(msg)) {
        sess._pending_offer = null;
        pushHistory(sess, "assistant", "No problem. If you change your mind, just say “recommend pads” and I’ll fetch options.");
        return res.json({ reply: "No problem. If you change your mind, just say “recommend pads” and I’ll fetch options." });
      }
      if (isAffirmation(msg)) {
        // If we need fitment, ask once and set awaiting state
        if (miss.length >= 2) {
          const ask = `Great — I’ll pull ${pType} that fit perfectly. What is your truck's ${miss.join(" & ")}? (Example: 2019 Ford F-150 5.5 ft bed XLT)`;
          sess._awaiting_fitment_for = pType;
          sess._pending_offer = null;
          sess._asked_fitment_at = Date.now();
          pushHistory(sess, "assistant", ask);
          return res.json({ reply: ask });
        }
        // If fitment is known, jump straight to recommendations
        // (fall through to recommendation flow below)
      }
      // Otherwise, continue to normal handling.
      sess._pending_offer = null;
    }

    // If we’re awaiting fitment for a specific type and the user supplied details this turn,
    // re-merge vehicle (already done) and proceed to recommendations when enough is known.
    let forceRecommendType = null;
    if (sess._awaiting_fitment_for) {
      if (miss.length >= 2) {
        // Still missing; gently re-ask only if not just asked < 3 min
        const askedRecently = sess._asked_fitment_at && (Date.now() - sess._asked_fitment_at < 3*60*1000);
        if (!askedRecently) {
          const ask = `To recommend exact parts, I still need your truck's ${miss.join(" & ")}. (Example: 2019 Ford F-150 5.5 ft bed XLT)`;
          sess._asked_fitment_at = Date.now();
          pushHistory(sess, "assistant", ask);
          return res.json({ reply: ask });
        }
      } else {
        forceRecommendType = sess._awaiting_fitment_for;
        sess._awaiting_fitment_for = null;
      }
    }

    /* ---------- Compose model prompt ---------- */

    const systemPrompt = `
You are "Trucks Helper" — precise, friendly, and proactive.

Rules:
- For general info (symptoms, causes, differences, maintenance, torque, etc.), answer directly even if vehicle details are unknown. If specs vary by year/trim, note the variation succinctly.
- For how-to, give clear safety-first steps, typical tools, and pro tips.
- For buying/fitment intent, use stored vehicle details if present. If critical details are missing, ask a single concise follow-up.
- Keep responses compact and useful (no long generic lists).
- Don’t paste URLs; the server will add shopping links if needed.
- When you finish a how-to or a product-ish answer, include a short, natural follow-up suggestion in one friendly sentence (we may ask it as a separate bubble).
`;

    const base = [{ role: "system", content: systemPrompt }, ...sess.history];

    const isHowTo = looksLikeHowTo(message);
    const temperature = isHowTo ? 0.4 : 0.6;

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature,
      messages: base
    });
    let reply = r?.choices?.[0]?.message?.content
      || "I couldn't find a clear answer. Tell me your truck year, make and model.";

    /* ---------- Decide product type ---------- */
    let productType = forceRecommendType || null;
    if (!productType && (isBuyingOrFitmentIntent(msg) || isHowTo || isProductLike(msg))) {
      if (/brake pad|brakes|rotor/.test(msg))                      productType = "brake pads";
      else if (/tonneau|bed cover/.test(msg))                      productType = "tonneau cover";
      else if (/lift kit|leveling/.test(msg))                       productType = "lift kit";
      else if (/(tire|all terrain|mud terrain)/.test(msg))         productType = "tires";
      else if (/tuner|programmer|diablosport|hypertech/.test(msg)) productType = "tuner";
      else if (/(nerf bar|running board|side step|step bar|power ?step|rock slider)/i.test(msg))
        productType = "running boards";
    }

    /* ---------- Build queries + links only if product-like ---------- */
    let queries = [];
    if (productType && (isProductLike(message) || isBuyingOrFitmentIntent(msg) || forceRecommendType)) {
      queries = extractProductQueries({ userMsg: message, modelReply: reply, vehicle, productType, max: 4 });
      if (!queries.length) {
        const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
        const seed = veh ? `${veh} ${productType}` : productType;
        queries = [seed];
      }
      // GEO aware link injection
      const country = detectCountryLimited(req);
      const marketplace = resolveMarketplace(country);
      reply = injectAffiliateLinks(
        reply,
        queries.map(q => ({ name: q, url: buildAmazonSearchURL(q, { marketplace }) }))
      );
      const lines = queries.map(q => tinySearchLine(q, marketplace));
      reply = `${reply}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    /* ---------- Generate proactive follow-up (as separate bubble) ---------- */
    let followup = null;
    const now = Date.now();
    const askCooldownOk = !sess._pending_offer || (now - (sess._pending_offer?.at||0) > 3*60*1000);

    if (!forceRecommendType && askCooldownOk) {
      // Offer only when we just did a how-to or the user looked producty
      if (isHowTo && productType) {
        followup = `Want me to pull ${productType} that fit your vehicle (with quick pros/cons)?`;
        sess._pending_offer = { type: productType, at: now };
      } else if (isProductLike(message) && productType && isGeneralInfoIntent(message) === false) {
        followup = `Do you want recommendations for ${productType} that fit your truck?`;
        sess._pending_offer = { type: productType, at: now };
      }
    }

    /* ---------- Save/return ---------- */
    pushHistory(sess, "assistant", reply);
    if (followup) pushHistory(sess, "assistant", followup); // so the model sees it next turn
    return res.json(followup ? { reply, followup } : { reply });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.json({
      reply: "I’m having trouble reaching the AI right now. Meanwhile, if you share your truck year, make, and model, I’ll fetch exact parts that fit."
    });
  }
});

/* ---- Test widget (optional) ----
   NOTE: This widget understands the new { followup } field and will
   render the follow-up as a second assistant bubble automatically.
*/
app.get("/widget", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Truck Assistant</title>
<style>
  :root{--bg:#0b0f14;--panel:#111923;--border:#213040;--accent:#1f6feb;--text:#e6edf3;--muted:#9bbcff}
  html,body{margin:0;height:100%} body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,Roboto;display:flex;flex-direction:column}
  header{display:flex;gap:10px;align-items:center;padding:12px;background:var(--panel);border-bottom:1px solid var(--border)}
  header .logo{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--accent);font-size:16px}
  #msgs{flex:1;overflow:auto;padding:12px}
  .msg{margin:8px 0} .who{font-size:11px;opacity:.7;margin-bottom:4px}
  .bubble{background:#141a22;border:1px solid var(--border);border-radius:12px;padding:10px 12px}
  .me .bubble{background:rgba(31,111,235,.1);border-color:#2a3b52}
  form{display:flex;gap:8px;padding:10px;background:var(--panel);border-top:1px solid var(--border)}
  input{flex:1;border:1px solid #2a3b52;border-radius:10px;background:var(--bg);color:var(--text);padding:10px}
  button{border:0;border-radius:10px;background:var(--accent);color:#fff;padding:10px 14px;font-weight:700;cursor:pointer}
  footer{font-size:11px;text-align:center;opacity:.7;padding:6px 10px}
  a{color:var(--muted);text-decoration:underline}
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
    const d = document.createElement('div'); d.className = 'msg ' + (role==='You'?'me':'ai');
    d.innerHTML = '<div class="who">'+role+'</div><div class="bubble">'+html+'</div>';
    $m.appendChild(d); $m.scrollTop = $m.scrollHeight;
    try{ parent.postMessage({type:'embed-size',height:document.body.scrollHeight}, '*'); }catch(e){}
    d.querySelectorAll('a[href]').forEach(a=>{a.target='_blank'; a.rel='nofollow sponsored noopener';});
  }

  add('AI', 'Hi! I\\'m your AI truck helper. Ask me anything — parts, fitment, or step-by-step how-to.');

  $f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $q.value.trim(); if(!text) return;
    add('You', text); $q.value=''; add('AI', '…typing');
    try{
      const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: text, session: SESS }) });
      const data = await r.json();
      $m.lastChild.remove();
      add('AI', data && data.reply ? data.reply : 'Sorry, I couldn\\'t get a response.');
      if (data && data.followup) add('AI', data.followup);
    }catch(err){
      $m.lastChild.remove(); add('AI','Server unavailable. Please try again.');
    }
  });
})();
</script>
</html>`);
});

/* --------------------------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running (proactive follow-ups + no-nag fitment + GEO) on :${PORT}`));
