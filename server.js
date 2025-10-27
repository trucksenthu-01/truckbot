// server.js — Chat + memory + small-liner tone + friendly follow-ups + guarded links + robust CORS
// - Remembers vehicle per session (year/make/model/etc.) — no repeat ask when known
// - Answers in short lines (bulleted), brand-friendly tone
// - HOW-TO: steps first, then a natural "Want parts that fit?" follow-up
// - Shopping: adds Amazon search links (affiliate + GEO marketplace), never overlinks
// - Strong CORS (Android/AMP/webviews), OPTIONS preflight
// - /widget still available if you embed it; /health & /echo for diagnostics

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

// Optional: keep your own intent extractor if present
import { extractIntent } from "./recommend.js";

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

/* ---------------- CORS: robust across Android webviews/AMP ---------------- */
const RAW_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://trucksenthusiasts.com,https://www.trucksenthusiasts.com,https://cdn.ampproject.org,https://*.ampproject.org,https://www.google.com"
).split(",").map(s => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / same-origin
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
const SESSIONS = new Map(); // sessionId -> { history, vehicle, flags }
const MAX_TURNS = 18;

function getSession(sessionId) {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, {
      history: [],
      vehicle: {}, // {year, make, model, bed, trim, engine}
      flags: {
        askedFitmentOnce: false,
        offeredUpsellAfterHowTo: false,
        lastFitmentAskAt: 0
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
function fitmentKnown(vehicle){ return !!(vehicle.year && vehicle.make && vehicle.model); }

function saidYes(s=""){ return /\b(yes|yeah|yup|sure|ok|okay|pls|please do|go ahead|why not)\b/i.test(s); }

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

/* ---------------- Link injection ---------------- */
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

/* ---------------- Product detection + query extraction ---------------- */
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

/* ---------------- Small-liner + tone helpers ---------------- */
function escapeHtml(s=""){return s.replace(/[&<>"]/g, m => ({'&':'&','<':'<','>':'>','"':'"'}[m]));}

// Turn any model text into short, readable lines.
// - Keep existing bullets/headers
// - Don’t break anchor links
// - Add "• " prefix where it reads as a list
function smallify(html=""){
  // If reply already contains anchor tags or explicit bullets, keep structure
  if (/<a\s/i.test(html)) {
    return html.split(/\n{2,}/).map(chunk=>{
      const lines = chunk.split(/\n/).map(s=>s.trim()).filter(Boolean);
      return lines.map(l=> l.startsWith("•") ? l : `• ${l}`).join("\n");
    }).join("\n\n");
  }
  // Otherwise, sentence split → bullets
  const parts = html
    .replace(/\s+/g," ")
    .split(/(?<=[\.!?])\s+(?=[A-Z0-9])/)
    .map(s=>s.trim())
    .filter(Boolean);
  if (!parts.length) return html;
  return parts.map(l => l.startsWith("•") ? l : `• ${l}`).join("\n");
}

// Friendly follow-up to keep engagement (never re-asks fitment if known)
function followUp(vehicle, userMsg, productType) {
  if (looksLikeHowTo(userMsg)) {
    if (fitmentKnown(vehicle)) {
      const veh = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
      return `• Want me to pull **parts that fit your ${veh}** for this job?`;
    }
    return `• Want me to pull **parts that fit your truck** for this job?`;
  }
  if (isProductLike(userMsg)) {
    const bits = [];
    bits.push("• Do you prefer **power-deploying** or **fixed** steps?");
    bits.push("• Any budget range you want me to stay within?");
    if (!fitmentKnown(vehicle)) bits.push("• I can check fitment too — share your year/make/model if you like.");
    return bits.join("\n");
  }
  return "• Want quick **fitment checks** or **price ranges** for that?";
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

    // Update memory from this turn
    pushHistory(sess, "user", message);

    // Parse & merge vehicle profile
    const parsed = extractIntent ? extractIntent(message||"") : {};
    const vehicle = mergeVehicleMemory(sess, parsed);

    // If user said "yes" but fitment incomplete, gently ask (only once every 2 min)
    if (saidYes(message) && !fitmentKnown(vehicle)) {
      const now=Date.now();
      if (now - (sess.flags.lastFitmentAskAt||0) > 120000) {
        const ask = "• Great — what’s your **year, make, and model**? (e.g., 2020 Ford F-150 5.5 ft bed XLT)";
        sess.flags.lastFitmentAskAt = now;
        pushHistory(sess, "assistant", ask);
        return res.status(200).json({ reply: ask });
      }
    }

    // Only ask for fitment IF clearly shopping AND 2+ core fields missing AND we haven't asked recently
    const wantsProducts = isProductLike(message);
    const miss = missingFitment(vehicle);
    if (wantsProducts && miss.length >= 2 && !sess.flags.askedFitmentOnce) {
      const ask = `• To dial this in, what’s your truck’s **${miss.join(" & ")}**?\n• Example: 2020 Ford F-150 5.5 ft bed XLT`;
      sess.flags.askedFitmentOnce = true;
      sess.flags.lastFitmentAskAt = Date.now();
      pushHistory(sess, "assistant", ask);
      return res.status(200).json({ reply: ask });
    }

    // System prompt with friendlier brand voice
    const systemPrompt = `
You are "Trucks Helper" — a friendly, practical truck expert with a crisp, human tone.
Style:
- Short lines, easy to skim. Prefer bullets. Use a few emojis tastefully (e.g., 🚚, 👍, 👇).
- Be specific and confident; avoid generic filler.
- For HOW-TO: give clear, numbered or bulleted steps plus safety notes; then offer parts help.
- Use known vehicle details automatically; DO NOT re-ask for year/make/model if already known.
- If some fitment info is missing, ask ONCE, politely.
- Do not put raw URLs in your text — links are injected later by the server.
- Keep brand voice: helpful, no hard sell; suggest next step to keep the chat flowing.`;

    const isHowTo = looksLikeHowTo(message);
    const base = [{ role:"system", content:systemPrompt }, ...sess.history];

    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: isHowTo ? 0.35 : 0.55,
      messages: base
    });

    let reply = r?.choices?.[0]?.message?.content
      || "Here to help. Share what you’re working on and I’ll jump in. 👍";

    // Product-type routing (for better search seeds)
    let productType = null;
    const m = message.toLowerCase();
    if (isHowTo && /brake|pad|rotor/.test(m)) productType = "brake pads";
    else if (/brake pad|brakes|rotor/.test(m)) productType = "brake pads";
    else if (/tonneau|bed cover/.test(m)) productType = "tonneau cover";
    else if (/lift kit|leveling/.test(m)) productType = "lift kit";
    else if (/tire|all terrain|mud terrain/.test(m)) productType = "tires";
    else if (/tuner|programmer|diablosport|hypertech|hyper tuner/.test(m)) productType = "tuner";
    else if (/(nerf bar|nerf bars|running board|running boards|side step|side steps|step bar|step bars|power ?step|rock slider|rock sliders)/i.test(m)) productType = "running boards";

    // Build product queries
    let queries = extractProductQueries({ userMsg: message, modelReply: reply, vehicle, productType, max: 4 });

    // Fallback seed if clearly shopping
    if (!queries.length && (isProductLike(message) || isProductLike(reply))) {
      const veh = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ");
      const seedType = productType || "truck accessories";
      queries = [veh ? `${veh} ${seedType}` : seedType];
    }

    // Inject links if any queries
    let withLinks = reply;
    if (queries.length) {
      withLinks = injectAffiliateLinks(
        reply,
        queries.map(q => ({ name:q, url: buildAmazonSearchURL(q, { marketplace }) }))
      );
      const lines = queries.map(q => tinySearchLine(q, marketplace));
      withLinks = `${withLinks}

You might consider:
${lines.join("\n")}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    // Add a friendly follow-up (never refit ask if we already know)
    const follow = followUp(vehicle, message, productType);

    // Convert to small lines (bullets) while preserving links/footer
    const [core, ...tail] = withLinks.split("\n\nYou might consider:");
    let small = smallify(core);
    if (tail.length) {
      small += "\n\nYou might consider:" + tail.join("\n\nYou might consider:");
    }
    small += `\n\n${follow}`;

    pushHistory(sess, "assistant", small);
    return res.status(200).json({ reply: small });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    return res.status(200).json({
      reply: "• I’m having trouble reaching the AI right now.\n• If you share your **year, make, model**, I’ll fetch parts that fit as soon as I’m back. 👍"
    });
  }
});

/* ---------------- Optional: lightweight embeddable widget page ----------------
   Keep this if you’re using /widget in an <iframe> or AMP <amp-iframe>.
-------------------------------------------------------------------------------*/
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

  add('AI',"• Hi! I'm your AI truck helper.\n• Ask me anything — parts, fitment, or step-by-step how-to. 👍");

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
      else data={ reply:'• Server returned a non-JSON response.' };
      th.stop(); th.node.remove();
      add('AI', (data && data.reply) ? data.reply : '• Sorry — no response right now.');
    }catch(err){
      th.stop(); th.node.remove();
      add('AI',"• Can’t reach the AI (network/CORS).\n• Please try again in a moment.");
    }
  });
})();
</script>
</html>`);
});

/* ---------------- Start server ---------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running on :${PORT}`));
