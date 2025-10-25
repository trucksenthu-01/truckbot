import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/* -----------------------------
   Load affiliate data
------------------------------ */
let affiliateMap = [];
try {
  const filePath = path.resolve("./data/affiliateMap_enriched.json");
  const data = fs.readFileSync(filePath, "utf8");
  affiliateMap = JSON.parse(data);
  console.log(`[server] ✅ Loaded ${affiliateMap.length} affiliate entries`);
} catch (err) {
  console.warn("[server] ⚠️ Could not load affiliateMap_enriched.json:", err.message);
}

/* -----------------------------
   App + Middleware Setup
------------------------------ */
const app = express();
app.use(bodyParser.json());

const allowed = (process.env.ALLOWED_ORIGINS || "https://trucksenthusiasts.com")
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

/* -----------------------------
   Health Check
------------------------------ */
app.get("/health", (_, res) => res.send("ok"));
app.get("/diag", (_, res) =>
  res.json({
    ok: true,
    model: MODEL,
    affiliate_entries: affiliateMap.length,
    allowed_origins: allowed,
    has_api_key: !!apiKey,
  })
);

/* -----------------------------
   Affiliate Injector
------------------------------ */
function injectAffiliateLinks(replyText = "") {
  if (!replyText || !affiliateMap.length) return replyText;

  let reply = replyText;
  const lower = reply.toLowerCase();
  const found = affiliateMap
    .filter(
      item =>
        lower.includes(item.brand?.toLowerCase() || "") ||
        lower.includes(item.name?.toLowerCase() || "")
    )
    .slice(0, 3);

  if (found.length) {
    const lines = found.map(
      p =>
        `👉 [${p.name || p.brand} – View on Amazon](${p.url})`
    );
    reply +=
      `\n\n💡 You might like these:\n${lines.join("\n")}\n\n_As an Amazon Associate, we may earn from qualifying purchases._`;
  }

  return reply;
}

/* -----------------------------
   Chat Endpoint
------------------------------ */
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ reply: "Please include 'message' in the request body." });

    console.log(`[chat] Message: ${message}`);

    // ChatGPT-style system prompt
    const systemPrompt = `
You are "Trucks Helper" — a friendly, knowledgeable truck expert like ChatGPT.
You can answer any truck-related question (lift kits, tonneau covers, tires, towing, etc.).
Be natural, concise, and friendly.
Whenever you mention a product brand or accessory, the system will add affiliate links automatically.
`;

    // Generate ChatGPT-style answer
    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    let reply = r?.choices?.[0]?.message?.content || "Sorry, I couldn’t come up with an answer right now.";
    reply = injectAffiliateLinks(reply);

    // Respond
    res.json({ reply });
  } catch (err) {
    console.error("[/chat] error", err);
    res.json({
      reply:
        "⚠️ I’m having trouble connecting to the AI right now. Meanwhile, check these trusted brands: UnderCover, BAKFlip, and Retrax.",
    });
  }
});

/* -----------------------------
   Start Server
------------------------------ */
app.listen(PORT, () => console.log(`🚀 Truckbot running like ChatGPT on :${PORT}`));
