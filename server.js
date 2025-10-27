// server.js — Chat + memory + auto-linking (category & product phrases) + small-liner tone
// - Remembers vehicle per session (year/make/model/bed/trim/engine) — no repeat ask when known
// - Answers in short lines, friendly brand voice
// - HOW-TO: steps first; then a gentle "Want parts that fit?" follow-up
// - Auto-hyperlinks ANY detected product/category phrase to Amazon search with your affiliate tag
// - Vehicle-aware search seeds (e.g., "2020 Ford F-150 cold air intake")
// - Robust CORS incl. AMP viewer; /health, /echo, /diag
// - /widget demo with iOS-friendly "Send"
// ENV: OPENAI_API_KEY, MODEL, PORT, ALLOWED_ORIGINS, AFFILIATE_TAG, AMAZON_MARKETPLACE

import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";

// If you have your own extractor, keep it; otherwise it's fine.
let extractIntent = null;
try { ({ extractIntent } = await import("./recommend.js")); } catch { /* optional */ }

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

/* ---------------- CORS (web, Android webviews, AMP) ---------------- */
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
    res.setHeader("Access-Control-Allow-Credentials", "false"); // we pass session in body, not cookies
  }
  // AMP viewer/caches require these headers
  const ampSource = req.query.__amp_source_origin || req.headers["amp-source-origin"];
  if (ampSource) {
    res.setHeader("AMP-Access-Control-Allow-Source-Origin", ampSource);
    res.setHeader("Access-Control-Expose-Headers", "AMP-Access-Control-Allow-Source-Origin");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------- OpenAI ---------------- */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.MODEL || "gpt-4o-mini";
const PORT   = process.env.PORT || 3000;

/* ---------------- Session memory (Map keyed by "session" string) ---------------- */
const SESSIONS = new Map(); // sessionId -> { history, vehicle, flags }
const MAX_TURNS = 18;

function getSession(sessionId) {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, {
      history: [],
      vehicle: { year:null, make:null, model:null, bed:null, trim:null, engine:null },
      flags: { askedFitmentOnce:false, lastFitmentAskAt:0 }
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

/* ---------------- Vehicle extractors (brand-agnostic) ---------------- */
const KNOWN_MAKES = ["Ford","Ram","Dodge","Chevrolet","Chevy","GMC","Toyota","Nissan","Jeep"];
const MODEL_HINTS = ["F-150","F150","F 150","Silverado","Sierra","Tacoma","Tundra","Ranger","Ram 1500","Ram1500","Gladiator","Maverick","Colorado","Frontier"];

function pullYear(text=""){ const m=text.match(/\b(20\d{2}|19\d{2})\b/); if(!m) return null; const y=+m[1]; return (y>=1990&&y<=2030)?String(y):null; }
function pullMake(text=""){ for(const mk of KNOWN_MAKES){ if(new RegExp(`\\b${mk}\\b`,"i").test(text)) return mk==="Chevy"?"Chevrolet":mk; } return null; }
function pullModel(text=""){
  for(const hint of MODEL_HINTS){ if(new RegExp(`\\b${hint}\\b`,"i").test(text)){
    if(/f[\s-–]?150/i.test(hint)) return "F-150";
    if(/ram\s?1500/i.test(hint)) return "Ram 1500";
    return hint.replace(/\s+/g," ");
  }}
  return null;
}
function pullBed(text=""){
  const ft = text.match(/(\d(?:\.\d)?)\s?('?ft|ft|'|feet)/i);
  if (ft) return `${ft[1]} ft`;
  if (/short\s*bed|crew\s*short/i.test(text)) return "5.5 ft";
  if (/standard\s*bed|regular\s*bed|6(?!\.)\s?ft/i.test(text)) return "6.5 ft";
  if (/long\s*bed|8\s?ft/i.test(text)) return "8 ft";
  if (/wheel[-\s]?to[-\s]?wheel/i.test(text)) return "wheel-to-wheel (steps coverage)";
  return null;
}
function pullTrim(text=""){
  const TRIMS = ["XL","XLT","Lariat","King Ranch","Platinum","Limited","TRD","TRD Pro","Sport","STX","Raptor","Big Horn","Lone Star","Rebel","Laramie","Limited Longhorn","Trail Boss","Z71","AT4","Pro-4X","Rubicon","Overland","Sahara"];
  for(const t of TRIMS){ if(new RegExp(`\\b${t}\\b`,"i").test(text)) return t; }
  return null;
}
function mergeVehicleMemory(sess, from={}) {
  const v = sess.vehicle || {};
  const overlay = {
    year:   from.year   ?? pullYear(from.text||""),
    make:   from.make   ?? pullMake(from.text||""),
    model:  from.model  ?? pullModel(from.text||""),
    bed:    from.bed    ?? pullBed(from.text||""),
    trim:   from.trim   ?? pullTrim(from.text||""),
    engine: from.engine ?? null
  };
  const merged = {
    year:   overlay.year   || v.year   || null,
    make:   overlay.make   || v.make   || null,
    model:  overlay.model  || v.model  || null,
    bed:    overlay.bed    || v.bed    || null,
    trim:   overlay.trim   || v.trim   || null,
    engine: overlay.engine || v.engine || null,
  };
  if (merged.model === "F-150" && !merged.make) merged.make = "Ford";
  sess.vehicle = merged; return merged;
}
function fitmentKnown(vehicle){ return !!(vehicle.year && vehicle.make && vehicle.model); }
function missingFitment(vehicle){ const m=[]; if(!vehicle.year)m.push("year"); if(!vehicle.make)m.push("make"); if(!vehicle.model)m.push("model"); return m; }

/* ---------------- Tone / follow-up helpers ---------------- */
function smallify(html=""){
  if (/<a\s/i.test(html)) {
    return html.split(/\n{2,}/).map(chunk=>{
      const lines = chunk.split(/\n/).map(s=>s.trim()).filter(Boolean);
      return lines.map(l=> l.startsWith("•") ? l : `• ${l}`).join("\n");
    }).join("\n\n");
  }
  const parts = html.replace(/\s+/g," ").split(/(?<=[\.!?])\s+(?=[A-Z0-9])/).map(s=>s.trim()).filter(Boolean);
  if (!parts.length) return html;
  return parts.map(l => l.startsWith("•") ? l : `• ${l}`).join("\n");
}
const HOWTO_KEYWORDS = ["how to","how do i","procedure","steps","install","replace","change","fix","tutorial","guide"];
function looksLikeHowTo(s=""){const t=s.toLowerCase();return HOWTO_KEYWORDS.some(k=>t.includes(k));}
function followUp(vehicle, userMsg) {
  if (looksLikeHowTo(userMsg)) {
    if (fitmentKnown(vehicle)) {
      const veh = `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
      return `• Want me to pull **parts that fit your ${veh}** for this job?`;
    }
    return `• Want me to pull **parts that fit your truck** for this job?`;
  }
  return "• Want quick **fitment checks** or **price ranges** for that?";
}

/* ---------------- GEO → Marketplace + Amazon helpers ---------------- */
const COUNTRY_TO_TLD_LIMITED = { US:"com", GB:"co.uk", UK:"co.uk", CA:"ca" };
function normalizeCountry(c){ if(!c) return null; const s=String(c).trim(); if(s.length===2) return s.toUpperCase(); const m=s.match(/[-_](\w{2})$/); return m?m[1].toUpperCase():s.substring(0,2).toUpperCase();}
function detectCountryLimited(req, explicit) {
  const d=normalizeCountry(explicit); if(d) return d;
  const h=req.headers||{};
  return normalizeCountry(h["cf-ipcountry"]) ||
         normalizeCountry(h["x-vercel-ip-country"]) ||
         normalizeCountry(h["x-country-code"]) ||
         normalizeCountry((h["accept-language"]||"").split(",")[0]) || null;
}
function vehicleString(vehicle){ return [vehicle?.year,vehicle?.make,vehicle?.model].filter(Boolean).join(" "); }
function resolveMarketplace(cc){ return (cc && COUNTRY_TO_TLD_LIMITED[cc]) ? COUNTRY_TO_TLD_LIMITED[cc] : (process.env.AMAZON_MARKETPLACE||"com"); }
function amazonDomainFromCC(cc="com"){ return `https://www.amazon.${(cc||"com").toLowerCase()}`; }
function buildAmazonSearchURL(query,{tag,marketplace}={}) {
  const base = amazonDomainFromCC(marketplace || process.env.AMAZON_MARKETPLACE || "com");
  const params = new URLSearchParams(); params.set("k", query);
  const assoc = tag || process.env.AFFILIATE_TAG; if (assoc) params.set("tag", assoc);
  return `${base}/s?${params.toString()}`;
}

/* ---------------- Category detection (no brand whitelist needed) ---------------- */
const CATEGORY_TERMS = [
  // intakes & filters
  "cold air intake","air intake","intake","intake kit","intake filter","air filter",
  // covers
  "tonneau cover","bed cover","retractable tonneau","tri-fold tonneau","hard folding cover","soft roll-up cover",
  // suspension
  "lift kit","leveling kit","shocks","struts","coilovers","springs",
  // brakes
  "brake pads","rotors","brakes",
  // steps
  "running boards","nerf bars","side steps","power steps","rock sliders",
  // misc
  "floor mats","bed liner","rack","exhaust","muffler","cat-back","header",
  // electronics
  "tuner","programmer","scanner",
  // lighting
  "headlights","taillights","light bar","fog lights",
  // wheels/tires
  "wheels","tires","all terrain","mud terrain"
];
const CATEGORY_RE = new RegExp("\\b(" + CATEGORY_TERMS.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|") + ")\\b","gi");

function detectCategories(text=""){
  const set = new Set(); let m;
  while ((m = CATEGORY_RE.exec(text)) !== null) set.add(m[1].toLowerCase());
  return [...set];
}

/* ---------------- Product phrase harvest (brand-agnostic) ---------------- */
// Capture 2–7 token phrases containing caps/numbers/&/dashes typical of product names (e.g., "K&N 63 Series Aircharger")
const PROD_PHRASE_RE = /\b([A-Z][A-Za-z0-9&\-]+(?:\s+[A-Z0-9][A-Za-z0-9&\-]+){1,6})\b/g;
function harvestProductPhrases(text=""){
  if (!text) return [];
  const hits = new Set();
  let m;
  while ((m = PROD_PHRASE_RE.exec(text)) !== null) {
    const phrase = m[1].trim()
      .replace(/\s{2,}/g," ")
      .replace(/[.,;:)\]]+$/,"");
    // Heuristic filters: skip obviously generic starters
    if (/^(Here|These|Those|This|That|Popular|Great|Best|Safety|Next)$/i.test(phrase)) continue;
    // include words that look like producty (Series|Kit|FORCE|Air|Intake|MX4|Ultra|EFX|Gen|Pro etc.)
    if (!/[A-Za-z]/.test(phrase)) continue;
    hits.add(phrase);
  }
  return [...hits];
}

/* ---------------- Link injection (vehicle-aware; no whitelist) ---------------- */
function buildVehicleAwareQuery(vehicle, q){
  const veh = vehicleString(vehicle);
  return [veh, q].filter(Boolean).join(" ").trim();
}
function linkify(replyText, queriesWithUrls, maxLinks=8){
  if(!replyText) return replyText;
  let out = replyText;

  // Avoid replacing inside existing <a> tags
  const alreadyAnchoredChunks = [];
  out = out.replace(/<a\b[^>]*>.*?<\/a>/gi, (m) => {
    alreadyAnchoredChunks.push(m);
    return `__ANCHOR_${alreadyAnchoredChunks.length-1}__`;
  });

  // Sort queries by length desc to prefer longer matches
  const items = [...queriesWithUrls].sort((a,b)=>b.name.length - a.name.length).slice(0, maxLinks);

  for (const {name,url} of items) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const re = new RegExp(`\\b${esc}\\b`, "gi");
    out = out.replace(re, (m)=>`<a href="${url}" target="_blank" rel="nofollow sponsored noopener">${m}</a>`);
  }

  // Restore anchors
  out = out.replace(/__ANCHOR_(\d+)__/g, (_,i)=>alreadyAnchoredChunks[+i]);
  return out;
}

/* ---------------- Build queries from categories + product phrases ---------------- */
function buildSearchQueries({ userMsg, modelReply, vehicle, marketplace, max=6 }) {
  const cats = new Set([
    ...detectCategories(userMsg||""),
    ...detectCategories(modelReply||""),
  ]);

  // Always include the user's exact ask (good fallback)
  const seeds = new Set();
  if ((userMsg||"").trim()) seeds.add((userMsg||"").trim());

  // Product phrases from both user and model reply
  for (const p of harvestProductPhrases(userMsg||"")) seeds.add(p);
  for (const p of harvestProductPhrases(modelReply||"")) seeds.add(p);

  // Also add category seeds (vehicle-aware)
  for (const c of cats) {
    seeds.add(c);
    // If category includes variations (e.g., "cold air intake"), keep as is
  }

  // Deduplicate by lowercase
  const list = [];
  const seen = new Set();
  for (const s of seeds) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(s);
    if (list.length >= 24) break; // generous pool; we'll trim later
  }

  // Convert to vehicle-aware Amazon URLs
  const tag = process.env.AFFILIATE_TAG || "";
  const queries = list.slice(0, 32).map(q => {
    const vehQ = buildVehicleAwareQuery(vehicle, q);
    return { name: q, url: buildAmazonSearchURL(vehQ, { tag, marketplace }) };
  });

  // Prefer category-first + proper names next
  const catSet = new Set(cats);
  const scored = queries.map(q => ({
    ...q,
    score:
      (catSet.has(q.name.toLowerCase()) ? 3 : 0) +
      (/\b(Series|Kit|Intake|Force|Pro|Gen|MX4|Ultra|EFX|Air|Filter|Brake|Rotor|Tonneau|Cover|Shocks|Struts|Lift|Level|Power|Step|Running|Board|Nerf)\b/i.test(q.name) ? 2 : 0) +
      (/[A-Z].*[0-9]|[0-9].*[A-Z]/.test(q.name) ? 1 : 0)
  }));
  scored.sort((a,b)=>b.score - a.score);

  return scored.slice(0, max);
}

function tinySearchLines(queries, marketplace){
  return queries.map(q => {
    const u = q.url;
    const label = q.name;
    return `• ${escapeHtml(label)} 👉 <a href="${u}" target="_blank" rel="nofollow sponsored noopener">View on Amazon</a>`;
  }).join("\n");
}

function escapeHtml(s=""){return s.replace(/[&<>"]/g, m => ({'&':'&','<':'<','>':'>','"':'"'}[m]);}

/* ---------------- Yes/No helper ---------------- */
function saidYes(s=""){ return /\b(yes|yeah|yup|sure|ok|okay|pls|please do|go ahead|why not)\b/i.test(s); }

/* ---------------- Diagnostics ---------------- */
app.get("/health", (_req,res)=>res.send("ok"));
app.post("/echo", (req,res)=>res.json({ ok:true, origin:req.headers.origin||null, ua:req.headers["user-agent"]||null }));
app.get("/diag", (req,res)=>{
  const ua = req.get("user-agent") || "";
  res.json({
    ok:true,
    time:new Date().toISOString(),
    sessionCount: SESSIONS.size,
    client:{
      ua,
      isIOS:/iPad|iPhone|iPod/i.test(ua),
      isMobile:/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua),
    }
  });
});

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

    pushHistory(sess, "user", message);

    // Try custom extractor, then regex overlay
    let parsed = {};
    try { parsed = extractIntent ? (extractIntent(message || "") || {}) : {}; } catch { parsed = {}; }
    parsed.text = message;
    const vehicle = mergeVehicleMemory(sess, parsed);

    // Timed gentle ask if user said yes but we lack core fitment
    if (saidYes(message) && !fitmentKnown(vehicle)) {
      const now=Date.now();
      if (now - (sess.flags.lastFitmentAskAt||0) > 120000) {
        const ask = "• Great — what’s your **year, make, and model**? (e.g., 2020 Ford F-150 5.5 ft bed XLT)";
        sess.flags.lastFitmentAskAt = now;
        pushHistory(sess, "assistant", ask);
        return res.status(200).json({ reply: ask });
      }
    }

    // Only ask for fitment if clearly shopping, 2+ core fields missing, and not nagging
    const miss = missingFitment(vehicle);
    const shopping = /cover|intake|kit|pads|rotor|brake|shocks|struts|tire|wheel|nerf|running|step|winch|tuner|mat|liner|rack|headlight|taillight|exhaust|filter/i.test(message);
    if (shopping && miss.length >= 2 && !sess.flags.askedFitmentOnce) {
      const ask = `• To dial this in, what’s your truck’s **${miss.join(" & ")}**?\n• Example: 2020 Ford F-150 5.5 ft bed XLT`;
      sess.flags.askedFitmentOnce = true;
      sess.flags.lastFitmentAskAt = Date.now();
      pushHistory(sess, "assistant", ask);
      return res.status(200).json({ reply: ask });
    }

    // Brand voice/system prompt
    const systemPrompt = `
You are "Trucks Helper" — a friendly, practical truck expert with a crisp, human tone.
Style:
- Short lines, easy to skim. Prefer bullets. Use emojis sparingly (🚚, 👍, 👇).
- Be specific and confident; avoid generic filler.
- HOW-TO: clear steps + safety notes; then offer parts help.
- Use known vehicle details automatically; DO NOT re-ask for year/make/model if already known.
- If some fitment info is missing, ask ONCE, politely.
- No raw URLs in your text — links are injected later.`;

    const isHowTo = looksLikeHowTo(message);
    const base = [{ role:"system", content:systemPrompt }, ...sess.history];

    let reply = "Here to help. Share what you’re working on and I’ll jump in. 👍";
    if (process.env.OPENAI_API_KEY) {
      const r = await client.chat.completions.create({
        model: MODEL,
        temperature: isHowTo ? 0.35 : 0.55,
        messages: base
      });
      reply = r?.choices?.[0]?.message?.content || reply;
    }

    // Build Amazon search queries from categories & phrases (user + reply)
    const queries = buildSearchQueries({ userMsg: message, modelReply: reply, vehicle, marketplace, max: 6 });

    // Linkify inside the reply (prefer long product phrases & categories)
    let linked = linkify(reply, queries, 6);

    // Add footer "You might consider" with explicit links too
    if (queries.length) {
      linked = `${linked}

You might consider:
${tinySearchLines(queries, marketplace)}
As an Amazon Associate, we may earn from qualifying purchases.`;
    }

    // Small-liner formatting + friendly follow-up
    const [core, ...tail] = linked.split("\n\nYou might consider:");
    let small = smallify(core);
    if (tail.length) small += "\n\nYou might consider:" + tail.join("\n\nYou might consider:");
    small += `\n\n${followUp(vehicle, message)}`;

    pushHistory(sess, "assistant", small);
    // Optional: prevent caches from storing chat
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ reply: small });

  } catch (e) {
    console.error("[/chat] error", e?.response?.data || e.message || e);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      reply: "• I’m having trouble reaching the AI right now.\n• If you share your **year, make, model**, I’ll fetch parts that fit as soon as I’m back. 👍"
    });
  }
});

/* ---------------- Widget demo (iOS-safe "Send") ---------------- */
app.get("/widget", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
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
.chat-footer{position:sticky;bottom:0;padding:8px calc(8px + env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));background:#111923}
.app{min-height:100dvh;display:flex;flex-direction:column}
</style>
<header><div class="logo">🚚</div><div><strong>AI Truck Assistant</strong></div></header>
<main id="msgs"></main>
<footer>As an Amazon Associate, we may earn from qualifying purchases.</footer>
<form id="f" autocomplete="off" class="chat-footer">
  <input id="q" placeholder="Ask about F-150 lifts, tires, covers…" inputmode="text" autocomplete="off">
  <button id="sendBtn" type="submit" aria-label="Send">Send</button>
</form>
<script>
(() => {
  const API = "/chat";
  const $m = document.getElementById('msgs');
  const $f = document.getElementById('f');
  const $q = document.getElementById('q');
  const $btn = document.getElementById('sendBtn');
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

  // iOS tap reliability
  $btn.addEventListener('touchstart', () => {}, { passive:true });

  $f.addEventListener('submit', async e=>{
    e.preventDefault();
    const text=$q.value.trim(); if(!text) return;
    add('You', text); $q.value=''; $btn.disabled=true;
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
    } finally {
      $btn.disabled=false; $q.focus();
    }
  });

  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $f.requestSubmit(); }
  });

  $q.addEventListener('input', () => {
    $btn.disabled = $q.value.trim().length === 0;
  });
})();
</script>
</html>`);
});

/* ---------------- Start ---------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running on :${PORT}`));
