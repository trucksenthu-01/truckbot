import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import { getBestAffiliateLinks, extractIntent } from "./recommend.js";

/* ---------------------- HELPERS ---------------------- */
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
function blogPrompt(ctx) {
  const v = ctx.intent.vehicle ? ctx.intent.vehicle.replace("-", " ").toUpperCase() : "the truck";
  const t = ctx.intent.type || "the upgrade";
  return `
You are a professional truck accessories reviewer. Write an informative blog post comparing top products.

CONTEXT:
- Vehicle: ${v}
- Product type: ${t}
- Items: ${JSON.stringify(ctx.picks)}

RULES:
- Use HTML only (no markdown).
- Include: Intro → Top Picks (each with image, mini-review, pros/cons, and affiliate link) → How They Differ → Which One Should You Pick → Disclosure.
- Keep factual, trustworthy, easy to scan.
- Avoid repetition or overlong sentences.
`;
}

/* ---------------------- APP SETUP ---------------------- */
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

/* ---------------------- ENDPOINTS ---------------------- */
app.get("/health", (_, res) => res.send("ok"));
app.get("/diag", (_, res) =>
  res.json({
    ok: true,
    model: MODEL,
    has_api_key: !!apiKey,
    allowed_origins: allowed,
  })
);

/* ---------------------- CHAT ---------------------- */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Missing 'message' (string) in body." });
    }

    const systemPrompt = `
You are "Trucks Helper" — a smart, friendly AI that helps truck owners pick the right accessories.
- Use 'get_affiliate_links' when users ask about products or recommendations.
- Always be safe, clear, and friendly.
`;

    // --- Pass 1: figure out intent + products ---
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
            description: "Return 1–3 affiliate URLs best matching the query.",
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

    // --- Extract affiliate picks ---
    const call = msg.tool_calls[0];
    const args = JSON.parse(call.function.arguments || "{}");
    const inferred = extractIntent(args.query || message || "");
    const mergedArgs = { limit: 3, ...inferred, ...args };
    const picks = getBestAffiliateLinks(mergedArgs) || [];

    if (!picks.length) {
      return res.json({
        reply: "Hmm, I couldn't find a perfect match yet. Can you tell me your truck’s year or bed length?",
      });
    }

    const ctx = buildModelContext(picks, mergedArgs);

    // --- AUTO-DETECT MODE ---
    const lowerMsg = message.toLowerCase();
    const wantsBlog =
      lowerMsg.includes("detailed") ||
      lowerMsg.includes("review") ||
      lowerMsg.includes("compare") ||
      lowerMsg.includes("pros") ||
      lowerMsg.includes("cons") ||
      lowerMsg.includes("in-depth") ||
      lowerMsg.includes("write article") ||
      lowerMsg.includes("long") ||
      lowerMsg.includes("full guide");

    // --- BLOG MODE ---
    if (wantsBlog) {
      const writing = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You write detailed HTML blog reviews for truck accessories." },
          { role: "user", content: blogPrompt(ctx) },
        ],
      });
      const html = writing?.choices?.[0]?.message?.content || "";
      return res.json({ reply: html });
    }

    // --- CHAT MODE ---
    const writing = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: `
You are a friendly truck expert chatbot that replies like a human.
Style:
- Use short, natural sentences with emojis.
- Give 2–3 top recommendations with quick pros.
- Include affiliate links with "👉".
- No HTML, no headings.
- End with a quick friendly tip.`,
        },
        {
          role: "user",
          content: `User asked: ${message}
Here are matching products: ${JSON.stringify(picks, null, 2)}`,
        },
      ],
    });
    const reply = writing?.choices?.[0]?.message?.content || "";
    return res.json({ reply });
  } catch (e) {
    console.error("[/chat] error", e);
    res.json({
      reply:
        "⚠️ I'm having trouble reaching the AI right now. Meanwhile, check: UnderCover / BAK / Retrax on Amazon.",
    });
  }
});

/* ---------------------- START SERVER ---------------------- */
app.listen(PORT, () => console.log(`🚀 Truckbot running on :${PORT}`));
