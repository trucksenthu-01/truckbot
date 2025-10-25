import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import { getBestAffiliateLinks, extractIntent } from "./recommend.js";

/* -----------------------------------
   Helpers for both chat & blog modes
----------------------------------- */
function amazonImageFromASIN(asin, marketplace = "US") {
  if (!asin) return null;
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL500_&ID=AsinImage&MarketPlace=${marketplace}&ServiceVersion=20070822`;
}
function normalizePick(it) {
  return {
    title: it?.name || `${it?.brand || ""} ${it?.type || ""}`.trim(),
    brand: it?.brand || "",
    type: it?.type || "",
    asin: it?.asin || "",
    url: it?.url || "#",
    img: amazonImageFromASIN(it?.asin),
  };
}
function buildModelContext(picks = [], intent = {}) {
  const clean = picks.map(normalizePick);
  return {
    intent: {
      vehicle: intent.vehicle || null,
      type: intent.type || null,
      brand: intent.brand || null,
    },
    picks: clean,
  };
}

/* ------------------------------
   Blog prompt for long version
------------------------------ */
function blogPrompt(ctx) {
  const v = ctx.intent.vehicle ? ctx.intent.vehicle.replace("-", " ").toUpperCase() : "the truck";
  const t = ctx.intent.type || "the upgrade";
  return `
You are a truck accessories expert. Write a helpful blog-style review.

CONTEXT:
- Vehicle: ${v}
- Product type: ${t}
- Items: ${JSON.stringify(ctx.picks)}

RULES:
- Tone: professional, helpful, and factual.
- Structure: Intro → Top Picks → Pros/Cons (3 each) → How They Differ → Which to Pick → Disclosure.
- Include affiliate links (<a>) and product images (<img>) where given.
- HTML only, no markdown.
`;
}

/* ------------------------------
   Express + OpenAI setup
------------------------------ */
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
const client = new OpenAI({ apiKey });
const MODEL = process.env.MODEL || "gpt-4o-mini";
const PORT = process.env.PORT || 3000;
const STYLE = (process.env.REPLY_STYLE || "chat").toLowerCase();

/* ------------------------------
   Diagnostic endpoints
------------------------------ */
app.get("/health", (_, res) => res.send("ok"));
app.get("/diag", (_, res) =>
  res.json({
    ok: true,
    model: MODEL,
    style: STYLE,
    has_api_key: !!apiKey,
    allowed_origins: allowed,
  })
);

/* ------------------------------
   Chat endpoint
------------------------------ */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ reply: "Missing message" });

    const systemPrompt = `
You are "Trucks Helper", a friendly expert on pickup truck accessories.
Always give accurate, legal, and safe advice.
When asked for products, use 'get_affiliate_links' to fetch items before replying.
`;

    // First pass → tool call
    const r = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_affiliate_links",
            description:
              "Return 1–3 affiliate URLs best matching the query.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
                vehicle: { type: "string" },
                type: { type: "string" },
                brand: { type: "string" },
                limit: { type: "number" },
              },
              required: ["query"],
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0.4,
    });

    const msg = r?.choices?.[0]?.message;
    if (!msg?.tool_calls?.length) {
      return res.json({ reply: msg?.content || "I'm ready for your next question!" });
    }

    // If tool was called
    const call = msg.tool_calls[0];
    const args = JSON.parse(call.function.arguments || "{}");
    const inferred = extractIntent(args.query || message || "");
    const mergedArgs = { limit: 3, ...inferred, ...args };
    const picks = getBestAffiliateLinks(mergedArgs) || [];

    if (picks.length === 0)
      return res.json({
        reply:
          "I couldn’t find an exact match yet. Could you share your truck year, bed length, or trim?",
      });

    const ctx = buildModelContext(picks, mergedArgs);

    /* ------------ STYLE SWITCH ------------ */
    if (STYLE === "blog") {
      // Long, blog-style answer
      const writing = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You write detailed HTML blog reviews for truck gear." },
          { role: "user", content: blogPrompt(ctx) },
        ],
      });
      const html = writing?.choices?.[0]?.message?.content || "";
      return res.json({ reply: html });
    } else {
      // Short, conversational mode
      const writing = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.6,
        messages: [
          {
            role: "system",
            content: `
You are a friendly truck expert chatbot that talks like a human.
Style:
- Short, natural sentences with emojis.
- Mention 2–3 products with quick pros.
- Use "👉" for links, no HTML.
- End with a tip or suggestion.`,
          },
          {
            role: "user",
            content: `User asked: ${message}
Here are product options: ${JSON.stringify(picks, null, 2)}`,
          },
        ],
      });
      const reply = writing?.choices?.[0]?.message?.content || "";
      return res.json({ reply });
    }
  } catch (e) {
    console.error("[/chat] error", e);
    res.json({
      reply:
        "⚠️ I'm having trouble reaching the AI right now. Meanwhile, check: UnderCover / BAK / Retrax on Amazon.",
    });
  }
});

/* ------------------------------
   Start server
------------------------------ */
app.listen(PORT, () => console.log(`Truckbot running on :${PORT}`));
