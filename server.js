// server.js — Chat + memory + realistic follow-ups + guarded links + GEO (US/UK/CA)
// - Strong CORS (Android/AMP-safe), OPTIONS preflight
// - Remembers vehicle per session (year/make/model/etc.)
// - HOW-TO answers first, then a natural follow-up offer
// - If user says "yes", asks for vehicle details (if missing) and then links
// - Amazon search links (affiliate tag + GEO marketplace)
// - Fallback product search if intent is shopping-like
// - /widget endpoint (for normal + AMP <amp-iframe>)

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

// Optional: your own tiny intent extractor (or keep your existing one)
import { extractIntent } from "./recommend.js"; // keep if you already have it

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
function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, (ch) => {
    const map = { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" };
    return map[ch] || ch;
  });
}
function tinySearchLine(q, market){
  const url = buildAmazonSearchURL(q,{marketplace:market});
  return `• ${escapeHtml(q)} 👉 <a href="${url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
}

/* ---------------- Brand-agnostic product/category detection ---------------- */
// 1) Broad category vocabulary (no brand restriction)
const CATEGORY_TERMS = [
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

// 2) Brand-agnostic product phrases (match ANY brand/product text like “K&N 63 Series Aircharger” or “aFe Magnum FORCE”)
const PROD_PHRASE_RE = /\b([A-Z][A-Za-z0-9&\-]+(?:\s+[A-Z0-9][A-Za-z0-9&\-]+){1,6})\b/g;
function harvestProductPhrases(text=""){
  if (!text) return [];
  const hits = new Set(); let m;
  while ((m = PROD_PHRASE_RE.exec(text)) !== null) {
    const phrase = m[1].trim().replace(/\s{2,}/g," ").replace(/[.,;:)\]]+$/,"");
    // skip obvious non-products
    if (/^(Here|These|Those|This|That|Popular|Great|Best|Safety|Next)$/i.test(phrase)) continue;
    if (!/[A-Za-z]/.test(phrase)) continue;
    hits.add(phrase);
  }
  return [...hits];
}

/* ---------------- Link injection (use ANY product/category) ---------------- */
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
  // do NOT restrict by brand; link every product/category phrase
  let out = stripMarkdownBasic(replyText);

  // Keep existing anchors intact
  const anchors = [];
  out = out.replace(/<a\b[^>]*>.*?<\/a>/gi, (m) => { anchors.push(m); return `__A${anchors.length-1}__`; });

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

  // Restore anchors
  out = out.replace(/__A(\d+)__/g, (_,i)=>anchors[+i]);
  return out;
}

/* ---------------- Product detection + query extraction (brand-agnostic) ---------------- */
function vehicleString(v){ return [v?.year,v?.make,v?.model].filter(Boolean).join(" "); }
function buildVehicleAwareQuery(vehicle, q) {
  const veh = vehicleString(vehicle);
  return [veh, q].filter(Boolean).join(" ").trim();
}

function extractProductQueries({ userMsg, modelReply, vehicle, productType, max=6 }){
  const seeds = new Set();

  // categories from both sides
  detectCategories(userMsg||"").forEach(c=>seeds.add(c));
  detectCategories(modelReply||"").forEach(c=>seeds.add(c));

  // product phrases from both sides
  harvestProductPhrases(userMsg||"").forEach(p=>seeds.add(p));
  harvestProductPhrases(modelReply||"").forEach(p=>seeds.add(p));

  // optional productType hint
  if (productType) seeds.add(productType);

  // always include the user's ask as a fallback query
  if ((userMsg||"").trim()) seeds.add((userMsg||"").trim());

  const out = [];
  for (const s of seeds) {
    const q = buildVehicleAwareQuery(vehicle, s);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- Diagnostics ---------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.post("/echo", (req,res)=>res.json({ ok:true, origin:req.headers.origin||null, ua:req.headers["user-agent"]||null }));

/* ---------------- Small, skimmable lines + open-ended follow-up ---------------- */
function toBullets(text=""){
  // turn sentences into bullets; keep anchors and line breaks where present
  const parts = text.replace(/\s+/g," ").split(/(?<=[\.!?])\s+(?=[A-Z0-9])/).map(s=>s.trim()).filter(Boolean);
  if (!parts.length) return text;
  return parts.map(l => l.startsWith("•") ? l : `• ${l}`).join("\n");
}
function followUpLine(message, vehicle){
  const isHowTo = looksLikeHowTo(message);
  if (isHowTo) {
    const v = vehicleString(vehicle);
    return v ? "• Want me to pull parts that fit your setup?" : "• Want me to pull parts that fit your truck?";
  }
  return "• Want budget, brand picks, or install tips?";
}

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

    // Parse + merge vehicle (keep your extractor; we only store once)
    const parsed = extractIntent ? (extractIntent(message||"") || {}) : {};
    const vehicle = mergeVehicleMemory(sess, parsed);

    // -------------- Change #2: ask fitment ONLY ONCE --------------
    const miss = missingFitment(vehicle);
    const wantsProducts = /cover|intake|kit|pads|rotor|brake|shocks|struts|tire|wheel|nerf|running|step|winch|tuner|mat|liner|rack|headlight|taillight|exhaust|filter/i.test(message);

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
    // after this point we never ask again this session

    // Compose system prompt + history (Change #3: shorter lines)
    const systemPrompt = `
You are "Trucks Helper" — precise, friendly, human.
Write short lines. Prefer bullets. Avoid long paragraphs.
For HOW-TO: steps first, safety notes next.
Use known vehicle details automatically. Do not re-ask fitment more than once.
No raw URLs; links are injected later.`;

    const isHowTo = looksLikeHowTo(message);
    const base = [{ role:"system", content:systemPrompt }, ...sess.history];

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: isHowTo ? 0.35 : 0.5,
      messages: base
    });

    let reply = r?.choices?.[0]?.message?.content
      || "• Tell me what you’re working on and I’ll jump in.";

    // -------------- Change #1: link ANY brand/product/category --------------
    const productType = null; // we don’t restrict by curated types anymore
    let queries = extractProductQueries({ userMsg: message, modelReply: reply, vehicle, productType, max: 6 });

    // Fallback if nothing detected but it looks like shopping
    if (!queries.length && wantsProducts) {
      const veh = vehicleString(vehicle);
      const seed = veh ? `${veh} truck accessories` : "truck accessories";
      queries = [seed];
    }

    if (queries.length) {
      // Build URL map and link inside body
      const tagged = queries.map(q => ({ name:q, url: buildAmazonSearchURL(q, { marketplace }) }));
      reply = injectAffiliateLinks(reply, tagged);

      // Add footer with explicit links
      const lines = queries.map(q => tinySearchLine(q, marketplace));
      reply = `${reply}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    // -------------- Change #3: enforce small, skimmable bullets --------------
    const [core, ...tail] = reply.split("\n\nYou might consider:");
    let small = toBullets(core);
    if (tail.length) small += "\n\nYou might consider:" + tail.join("\n\nYou might consider:");

    // -------------- Change #4: open-ended follow-up --------------
    small += `\n\n${followUpLine(message, vehicle)}`;

    // Keep your “upsell after HOW-TO” flag behavior (still once)
    if (isHowTo && !sess.flags.offeredUpsellAfterHowTo) {
      small += `\n• Want me to fetch parts lists or torque specs?`;
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
.bubble{background:#141a22;border:1px solid var(--border);border-radius:12px;padding:10px 12px}
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

  add('AI',"• Hi! I’m your AI truck helper.\\n• Ask me anything — parts, fitment, or step-by-step how-to.");

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
