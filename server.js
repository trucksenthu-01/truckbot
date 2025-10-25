import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import { getBestAffiliateLinks, extractIntent } from "./recommend.js";

// -------------------------
// App + CORS
// -------------------------
const app = express();
app.use(bodyParser.json());

// Allow only your site (or multiple, comma-separated)
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

// -------------------------
// OpenAI client
// -------------------------
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.warn("[warn] OPENAI_API_KEY not set — /chat calls will fail.");
}
const client = new OpenAI({ apiKey });

// Use a safe default if your account doesn't have gpt-5 access
const MODEL = process.env.MODEL || "gpt-4o-mini";
const PORT = process.env.PORT || 3000;

// -------------------------
// Tool definition
// -------------------------
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

// -------------------------
// Health + diagnostics
// -------------------------
app.get("/health", (_req, res) => res.send("ok"));

app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    allowed_origins: allowed,
    has_api_key: !!apiKey
  });
});

// -------------------------
// Chat endpoint
// -------------------------
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
- When recommending any specific product, CALL the 'get_affiliate_links' tool with the user's full question (and any inferred vehicle/type/brand).
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

    // If the model calls the tool, fulfill and do a second pass
    if (msg?.tool_calls?.length) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments || "{}");

      // Merge inferred intent (vehicle/type/brand) with model-provided args
      const inferred = extractIntent(args.query || message || "");
      const mergedArgs = { limit: 3, ...inferred, ...args };

      const toolContent = callAffiliateTool(mergedArgs);

      const followup = [
        ...baseMessages,
        msg,
        {
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: toolContent
        }
      ];

      r = await client.chat.completions.create({
        model: MODEL,
        messages: followup,
        temperature: 0.3
      });

      msg = r?.choices?.[0]?.message;
    }

    const reply = (msg?.content || "Sorry, I couldn't generate a response right now.")
      .replace(/\n\n/g, "<br><br>");

    res.json({ reply });
  } catch (e) {
    // -------- Improved error handling & logging --------
    const status = e?.status || e?.response?.status || 500;
    const data =
      e?.response?.data ||
      e?.error ||
      e?.message ||
      e;

    console.error("[/chat] OpenAI error", { status, data });

    // Graceful fallback so the widget never shows a hard error
    return res.json({
      reply:
        "I’m having trouble reaching the AI right now. Meanwhile, here are a couple of popular picks you can check out:" +
        "<br>• Hard folding tonneau covers (F-150): UnderCover / BAK" +
        "<br>• Retractable covers (Ram 2500): Retrax / GatorTrax" +
        "<br><br>Try again in a moment!"
    });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Truckbot running on :${PORT}`);
});
