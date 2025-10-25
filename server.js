import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import { getBestAffiliateLinks, extractIntent } from "./recommend.js";

/* -----------------------------
   BLOG PRESENTATION HELPERS
--------------------------------*/
function amazonImageFromASIN(asin, marketplace = "US") {
  if (!asin) return null;
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL500_&ID=AsinImage&MarketPlace=${marketplace}&ServiceVersion=20070822`;
}
function normalizePick(it) {
  return {
    title: it?.name || `${it?.brand || ""} ${it?.type || ""}`.trim(),
    brand: it?.brand || "",
    type:  it?.type  || "",
    asin:  it?.asin  || "",
    url:   it?.url   || "#",
    img:   amazonImageFromASIN(it?.asin)
  };
}
function buildModelContext(picks = [], intent = {}) {
  const clean = picks.map(normalizePick);
  return {
    intent: {
      vehicle: intent.vehicle || null,
      type: intent.type || null,
      brand: intent.brand || null
    },
    picks: clean
  };
}
function blogPrompt(ctx) {
  const v = ctx.intent.vehicle ? ctx.intent.vehicle.replace("-", " ").toUpperCase() : "the truck";
  const t = ctx.intent.type || "the upgrade";
  return `
You are a truck accessories expert. Write a concise, helpful, blog-style recommendation with sections below. Keep it factual and readable.

CONTEXT:
- Vehicle: ${v}
- Product type: ${t}
- Items (JSON): ${JSON.stringify(ctx.picks)}

RULES:
- Tone: friendly, knowledgeable, no fluff.
- Keep it compact but useful (≈120–220 words intro + 120–180 words per product).
- Include practical fitment notes when obvious (e.g., bed length, typical compatibility).
- Pros and Cons: EXACTLY 3 bullets each per product.
- After each product’s Pros/Cons, include a CTA line with the affiliate link.
- Include the image thumbnail (<img>) if provided.
- Add a "How They Differ" section (3–5 bullets).
- Add a "Which One Should You Pick?" section with 2–3 buyer profiles.

OUTPUT FORMAT (HTML only, no markdown):
<section>
  <h3>Intro</h3>
  <p>2–4 sentences tailored to the vehicle and type.</p>

  <h3>Top Picks</h3>
  <div class="pick">For each item:
    <h4>#1 Brand – Product Title</h4>
    <img src="IMG_URL" alt="Product Title" width="320" loading="lazy"/>
    <p>Mini review paragraph (what it is, why it’s good, who it fits).</p>
    <ul>
      <li>Pros: …</li><li>Pros: …</li><li>Pros: …</li>
    </ul>
    <ul>
      <li>Cons: …</li><li>Cons: …</li><li>Cons: …</li>
    </ul>
    <p><a href="AFFILIATE_URL" rel="nofollow sponsored noopener" target="_blank">View on Amazon →</a></p>
  </div>

  <h3>How They Differ</h3>
  <ul><li>…</li><li>…</li><li>…</li></ul>

  <h3>Which One Should You Pick?</h3>
  <ul>
    <li>Daily driver / weather protection: …</li>
    <li>Work/towing: …</li>
    <li>Budget-conscious: …</li>
  </ul>

  <p style="font-size:12px;opacity:.75">As an Amazon Associate, we may earn from qualifying purchases.</p>
</section>
`;
}

/* -----------------------------
   APP + CORS + OPENAI
--------------------------------*/
const app = express();
app.use(bodyParser.json());

const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      const ok = !origin || allowed.length === 0 || allowed.includes(origin);
      cb(null, ok);
    },
  })
);

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) console.warn("[warn] OPENAI_API_KEY not set — /chat calls will fail.");

const client = new OpenAI({ apiKey });
const MODEL = process.env.MODEL || "gpt-4o-mini";   // safe default
const PORT  = process.env.PORT  || 3000;

/* -----------------------------
   TOOL DEFINITION
--------------------------------*/
const tools = [
  {
    type: "function",
    function: {
      name: "get_affiliate_links",
      description:
        "Return up to 3 affiliate URLs best-matching the user's intent (vehicle/type/brand/asin). If nothing matches, return an empty list.",
      parameters: {
        type: "object",
        properties: {
          query:   { type: "string", description: "User's raw question or keywords" },
          asin:    { type: "string", nullable: true },
          sku:     { type: "string", nullable: true },
          vehicle: { type: "string", nullable: true },
          type:    { type: "string", nullable: true },
          brand:   { type: "string", nullable: true },
          limit:   { type: "number",  nullable: true, default: 3 }
        },
        required: ["query"]
      }
    }
  }
];

function callAffiliateTool(args) {
  const list = getBestAffiliateLinks(args || {});
  return JSON.stringify({ results: list });
}

/* -----------------------------
   HEALTH + DIAG
--------------------------------*/
app.get("/health", (_req, res) => res.send("ok"));
app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    allowed_origins: allowed,
    has_api_key: !!apiKey
  });
});

/* -----------------------------
   CHAT ENDPOINT
--------------------------------*/
app.post("/chat", async (req, res) => {
  try {
    const { message, session } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });
    }

    const userName = (session || "visitor").toString().slice(0, 12);

    const systemPrompt = `
You are "Trucks Helper", a friendly, expert assistant for pickup trucks (fitment, lift kits, tires, wheels, tonneau covers, towing).
Policy:
- Always call the 'get_affiliate_links' tool FIRST when users ask for product choices or recommendations.
- If the tool returns no results, ask ONE fitment question (year, bed length, trim) and try again.
- Prefer giving up to three picks with brand, type, and a short reason + CTA link.
- Be concise, practical, and safety-forward (no illegal or unsafe advice).
- Show this disclosure once per session: "As an Amazon Associate, we may earn from qualifying purchases."
`;

    const baseMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message, name: userName }
    ];

    // Pass 1: let the model decide to call the tool
    let r = await client.chat.completions.create({
      model: MODEL,
      messages: baseMessages,
      tools,
      tool_choice: "auto",
      temperature: 0.3
    });

    let msg = r?.choices?.[0]?.message;

    // If the model calls the tool, fulfill and then write blog-style content
    if (msg?.tool_calls?.length) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments || "{}");

      // Inferred + explicit intent
      const inferred = extractIntent(args.query || message || "");
      const mergedArgs = { limit: 3, ...inferred, ...args };

      // 1) Call the affiliate selector (tool)
      const raw = callAffiliateTool(mergedArgs);
      const payload = JSON.parse(raw || "{}");
      const picks = payload?.results || [];

      // If no picks, ask for fitment details
      if (!Array.isArray(picks) || picks.length === 0) {
        const ask = `
I couldn’t find an exact match yet. Could you share:
- Model year
- Bed length
- Trim (FX4, Raptor, etc.)
I’ll pull in the best options for your truck.`;
        return res.json({ reply: ask.replace(/\n\n/g, "<br><br>").replace(/\n/g,"<br>") });
      }

      // 2) Build compact context for writing pass
      const ctx = buildModelContext(picks, mergedArgs);

      // 3) Second pass: ask the model to write the blog-style HTML
      try {
        const writing = await client.chat.completions.create({
          model: MODEL,
          temperature: 0.4,
          messages: [
            { role: "system", content: "You write tight, helpful truck-gear mini-reviews. HTML output only." },
            { role: "user", content: blogPrompt(ctx) }
          ]
        });

        const html = writing?.choices?.[0]?.message?.content || "";
        return res.json({ reply: html });
      } catch (e) {
        console.error("[/chat] writing-pass error", e?.response?.data || e?.message || e);
        // Fallback: simple cards with links
        const simple = picks.map((it, i) => {
          const p = normalizePick(it);
          return `
            <div style="border:1px solid #233244;border-radius:12px;padding:12px;margin:8px 0;">
              <div style="font-weight:600">${i+1}. ${p.title}</div>
              ${p.img ? `<img src="${p.img}" alt="${p.title}" width="320" loading="lazy" style="margin:8px 0;border-radius:10px"/>` : ""}
              <p><a href="${p.url}" target="_blank" rel="nofollow sponsored noopener">View on Amazon →</a></p>
            </div>
          `;
        }).join("");
        return res.json({ reply: `<section><h3>Top Picks</h3>${simple}
          <p style="font-size:12px;opacity:.75">As an Amazon Associate, we may earn from qualifying purchases.</p></section>` });
      }
    }

    // If no tool call, just return the model's plain reply
    const reply = (msg?.content || "Sorry, I couldn't generate a response right now.")
      .replace(/\n\n/g, "<br><br>");
    res.json({ reply });

  } catch (e) {
    // Better logging & graceful fallback
    const status = e?.status || e?.response?.status || 500;
    const data = e?.response?.data || e?.error || e?.message || e;
    console.error("[/chat] OpenAI error", { status, data });

    return res.json({
      reply:
        "I’m having trouble reaching the AI right now. Meanwhile, here are a couple of popular picks you can check out:" +
        "<br>• Hard folding tonneau covers (F-150): UnderCover / BAK" +
        "<br>• Retractable covers (Ram 2500): Retrax / GatorTrax" +
        "<br><br>Try again in a moment!"
    });
  }
});

/* -----------------------------
   START SERVER
--------------------------------*/
app.listen(PORT, () => {
  console.log(`Truckbot running on :${PORT}`);
});
