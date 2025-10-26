// server.js — Chat + memory + guarded links + fallback + GEO (US/UK/CA)
// - Remembers conversation per session (year/make/model, etc.)
// - Answers general questions WITHOUT demanding fitment
// - Asks for fitment only for clear buying/fitment intent (cooldowned)
// - Builds Amazon SEARCH links with your affiliate tag
// - Injects clickable links ONLY for product-like queries
// - Fallback search when needed
// - GEO: US/UK/CA -> .com / .co.uk / .ca (others use AMAZON_MARKETPLACE or .com)

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
const SESSIONS = new Map(); // sessionId -> { history: Message[], vehicle: {...}, _asked_fitment_at?: ts }
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
   Utilities: intent, vehicle memory
---------------------------------------- */
const HOWTO_KEYWORDS = [
  "how to","how do i","procedure","steps","install","replace","change","fix","tutorial"
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
const COUNTRY_TO_TLD_LIMITED = { US:"com", GB:"co.uk", UK:"co.uk", CA:"ca" };

function normalizeCountry(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (s.length === 2) return s.toUpperCase();
  const m = s.match(/[-_](\w{2})$/); // e.g., en-US
  return m ? m[1].toUpperCase() : s.substring(0,2).toUpperCase();
}
function detectCountryLimited(req, explicitCountry) {
  const direct = normalizeCountry(explicitCountry);
  if (direct) return direct;
  const h = req.headers || {};
  const cf  = normalizeCountry(h["cf-ipcountry"]);
  if (cf) return cf;
  const ver = normalizeCountry(h["x-vercel-ip-country"]);
  if (ver) return ver;
  const gen = normalizeCountry(h["x-country-code"]);
  if (gen) return gen;
  const al = h["accept-language"];
  if (al) {
    const first = al.split(",")[0].trim(); // en-US
    const cc = normalizeCountry(first);
    if (cc) return cc;
  }
  return null;
}
function resolveMarketplace(countryLimited) {
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
function stripMarkdownBasic(s = "") {
  return s
    .replace(/(\*{1,3})([^*]+)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*(.+)$/gm, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$&");
}
const _STOP = new Set(["the","a","an","for","to","of","on","with","and","or","cover","covers","tonneau","truck","bed","ford","ram","chevy","gmc","toyota","best","good","great","kit","pads","brakes"]);
const _norm = s => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
const _toks = s => _norm(s).split(" ").filter(t => t && !_STOP.has(t));
function buildOrderedTokenRegex(name) {
  const ts = _toks(name);
  if (!ts.length) return null;
  const chosen = ts.slice(0, Math.min(3, ts.length));
  const pattern = chosen.map(t => `(${t})`).join(`\\s+`);
  return new RegExp(`\\b${pattern}\\b`, "gi");
}
function injectAffiliateLinks(replyText = "", products = []) {
  if (!replyText || !Array.isArray(products) || !products.length) return replyText;
  let out = stripMarkdownBasic(replyText);
  for (const p of products) {
    const url = p?.url;
    const full = p?.name;
    if (!url || !full) continue;
    const tokenRe = buildOrderedTokenRegex(full);
    if (tokenRe && tokenRe.test(out)) {
      out = out.replace(tokenRe, (m) =>
        `<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`
      );
      continue;
    }
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
   Product detection + query extraction
---------------------------------------- */
const BRAND_WHITELIST = [
  // tonneau / general
  "AMP Research","PowerStep","BAKFlip","UnderCover","TruXedo","Extang","Retrax",
  "Gator","Rough Country","Bilstein","DiabloSport","Hypertech","Motorcraft",
  "Power Stop","WeatherTech","Tyger","Nitto","BFGoodrich","Falken","K&N",
  "Borla","Flowmaster","Gator EFX","ArmorFlex","MX4","Ultra Flex","Lo Pro",
  "Sentry CT","Solid Fold","Husky","FOX","Rancho","Monroe","Moog","ACDelco",
  "Dorman","Bosch","NGK","Mopar",
  // steps / nerf bars / running boards
  "N-Fab","NFab","Westin","Go Rhino","Ionic","Luverne","ARIES","Dee Zee","Tyger Auto"
];

const PRODUCT_TERMS =
  /(tonneau|bed\s*cover|lift\s*kit|level(ing)?\s*kit|tire|wheel|brake|pad|rotor|shock|strut|bumper|nerf\s*bar|nerf\s*bars|running\s*board|running\s*boards|side\s*step|side\s*steps|step\s*bar|step\s*bars|power ?step|tuner|programmer|intake|filter|exhaust|coilover|spring|winch|hitch|battery|floor\s*mat|bed\s*liner|rack|headlight|taillight)/i;

function isProductLike(text = "") {
  if (!text) return false;
  if (PRODUCT_TERMS.test(text)) return true;
  const lower = text.toLowerCase();
  return BRAND_WHITELIST.some(b => {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(lower);
  });
}

/* ---------- New: intent gates for fitment ask ---------- */
function isGeneralInfoIntent(s = "") {
  return /(issue|issues|problem|symptom|noise|vibration|cause|risk|signs|maintenance|service|interval|torque|how to|steps|procedure|install|remove|replace|why|what|explain|guide|tips|troubleshoot|diagnose|difference|pros|cons|lifespan|wear)/i.test(s);
}
function isBuyingOrFitmentIntent(s = "") {
  return /(fit|fitment|compatible|which|exact|part|sku|model number|buy|price|link|recommend|best|options|where to buy)/i.test(s);
}

// Extract queries from reply + user + vehicle + productType
function extractProductQueries({ userMsg, modelReply, vehicle, productType, max = 4 }) {
  const out = [];

  // vehicle-scoped seed if we know type
  if (productType) {
    const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
    if (veh) out.push(`${veh} ${productType}`);
  }

  // brand phrases in the model reply
  const candidatesReply = (modelReply || "").match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z0-9][a-zA-Z0-9\.\-]+){0,3})\b/g) || [];
  for (const c of candidatesReply) {
    if (BRAND_WHITELIST.some(b => c.toLowerCase().includes(b.toLowerCase()))) out.push(c);
  }

  // also scan user message for brands
  const candidatesUser = (userMsg || "").match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z0-9][a-zA-Z0-9\.\-]+){0,3})\b/g) || [];
  for (const c of candidatesUser) {
    if (BRAND_WHITELIST.some(b => c.toLowerCase().includes(b.toLowerCase()))) out.push(c);
  }

  // last resort: if it clearly looks producty, include the raw user message
  if (!out.length && isProductLike(userMsg || "")) out.push(userMsg.trim());

  // de-dupe + cap
  const seen = new Set(); const deduped = [];
  for (const s of out) {
    const k = s.toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); deduped.push(s.trim());
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

    // GEO resolve
    const country = normalizeCountry(bodyCountry) || detectCountryLimited(req);
    const marketplace = (bodyMarket || resolveMarketplace(country));

    const sessionId = (session || "visitor").toString().slice(0, 60);
    const sess = getSession(sessionId);

    // 1) Update memory with the user's message
    pushHistory(sess, "user", message);

    // 2) Extract/update vehicle profile
    const parsed = extractIntent(message || "");
    const vehicle = mergeVehicleMemory(sess, parsed);

    // 3) Fitment askback ONLY for clear buying/fitment intent + producty message
    const msg = (message || "").toLowerCase();
    const miss = missingFitment(vehicle);
    const needFitment = isBuyingOrFitmentIntent(msg) && isProductLike(msg) && miss.length >= 2;
    const nowTs = Date.now();
    const askedRecently = sess._asked_fitment_at && (nowTs - sess._asked_fitment_at < 3 * 60 * 1000); // 3 min cooldown

    if (needFitment && !askedRecently) {
      const ask = `To recommend exact parts, what is your truck's ${miss.join(" & ")}? (Example: 2019 Ford F-150 5.5 ft bed XLT)`;
      sess._asked_fitment_at = nowTs;
      pushHistory(sess, "assistant", ask);
      return res.json({ reply: ask });
    }

    // 4) Prompt + history (encourage answering general info without fitment)
    const systemPrompt = `
You are "Trucks Helper" — a precise, friendly truck expert.

Core behavior:
- If the user asks for general information (symptoms, causes, differences, maintenance, how-to steps, torque ranges, etc.), ANSWER DIRECTLY even if vehicle details are unknown. Provide applicable ranges and note variations by year/trim if relevant.
- Use the stored vehicle profile when giving fitment or buying recommendations.
- Only ask for missing vehicle details when the user clearly wants exact parts, fitment, or buying guidance. Ask at most once per thread; don't repeat unless the user shows buying intent again.

How-to:
- For "how to" requests, give clear, safety-first steps. If appropriate, suggest categories of parts and note which vehicle details affect selection.

Links:
- Do not paste URLs; the server injects shopping links afterward.
`;
    const base = [{ role: "system", content: systemPrompt }, ...sess.history];

    // 5) Model call
    const isHowTo = looksLikeHowTo(message);
    const temperature = isHowTo ? 0.4 : 0.5;
    const r = await client.chat.completions.create({
      model: MODEL,
      temperature,
      messages: base
    });
    let reply = r?.choices?.[0]?.message?.content
      || "I couldn't find a clear answer. Tell me your truck year, make and model.";

    // 6) Product-type routing (only when user shows buying/fitment intent)
    let productType = null;
    if (isBuyingOrFitmentIntent(msg)) {
      if (/brake pad|brakes|rotor/.test(msg))                      productType = "brake pads";
      else if (/tonneau|bed cover/.test(msg))                      productType = "tonneau cover";
      else if (/lift kit|leveling/.test(msg))                       productType = "lift kit";
      else if (/(tire|all terrain|mud terrain)/.test(msg))         productType = "tires";
      else if (/tuner|programmer|diablosport|hypertech/.test(msg)) productType = "tuner";
      else if (/(nerf bar|running board|side step|step bar|power ?step|rock slider)/i.test(msg))
        productType = "running boards";
    }

    // 7) Build queries
    let queries = extractProductQueries({
      userMsg: message,
      modelReply: reply,
      vehicle,
      productType,
      max: 4
    });

    // Strong fallback if clearly shopping but nothing extracted
    if (!queries.length && (isProductLike(message) || isProductLike(reply))) {
      const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
      const seedType = productType || "truck accessories";
      queries = [veh ? `${veh} ${seedType}` : seedType];
    }

    // 8) Link only for product-like intent
    if (queries.length) {
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

    // 9) Save + return
    pushHistory(sess, "assistant", reply);
    return res.json({ reply });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.json({
      reply: "I’m having trouble reaching the AI right now. Meanwhile, if you share your truck year, make, and model, I’ll fetch exact parts that fit."
    });
  }
});

/* ---- Lightweight embeddable chat widget (served by Render) ---- */
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
    const links = d.querySelectorAll('a[href]'); links.forEach(a=>{a.target='_blank'; a.rel='nofollow sponsored noopener';});
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
    }catch(err){
      $m.lastChild.remove(); add('AI','Server unavailable. Please try again.');
    }
  });
})();
</script>
</html>`);
});

/* --------------------------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running (no-nag fitment + guarded links + GEO US/UK/CA) on :${PORT}`));
