import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/* -----------------------------
   Load Affiliate Data
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
   Helper: Build image link from ASIN
------------------------------ */
function amazonImageFromASIN(asin, marketplace = "US") {
  if (!asin) return null;
  return `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL400_&ID=AsinImage&MarketPlace=${marketplace}&ServiceVersion=20070822`;
}

/* -----------------------------
   Affiliate Injector with Images
------------------------------ */
function injectAffiliateContent(replyText = "") {
  if (!replyText || !affiliateMap.length) return replyText;

  let reply = replyText;
  const lower = reply.toLowerCase();

  // Find matching products
  const found = affiliateMap
    .filter(
      item =>
        lower.includes(item.brand?.toLowerCase() || "") ||
        lower.includes(item.name?.toLowerCase() || "")
    )
    .slice(0, 3);

  if (found.length) {
    const cards = found.map(p => {
      const img = p.asin ? amazonImageFromASIN(p.asin) : null;
      const safeName = p.name || p.brand;
      const safeLink = p.url;

      return `
        <div style="border:1px solid #233244;border-radius:12px;padding:12px;margin:8px 0;
                    background:#0f1620;color:#fff;max-width:480px;">
          <div style="font-weight:600;margin-bottom:6px;">${safeName}</div>
          ${img ? `<img src="${img}" alt="${safeName}" width="320" loading="lazy"
                     style="border-radius:10px;margin-bottom:8px;display:block;">` : ""}
          <a href="${safeLink}" target="_blank" rel="nofollow sponsored noopener"
             style="display:inline-block;padding:8px 12px;border-radius:10px;
                    background:#1f6feb;color:#fff;text-decoration:none;">
            👉 View on Amazon
          </a>
        </div>
      `;
    });

    reply += `
      <br><br>
      <div style="font-weight:600;margin-top:12px;">💡 You might like these:</div>
      ${cards.join("")}
      <p style="font-size:12px;opacity:.75;margin-top:8px;">
        As an Amazon Associate, we may earn from qualifying purchases.
      </p>
    `;
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

    const systemPrompt = `
You are "Trucks Helper" — a friendly, knowledgeable truck expert chatbot like ChatGPT.
You can answer any truck-related question: lift kits, tonneau covers, tires, towing, etc.
Be natural, conversational, and concise — sound human.
Write in Markdown style for bold text and line breaks.
Avoid giving Amazon links yourself — they’ll be added automatically.
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

    // Inject affiliate links + images
    reply = injectAffiliateContent(reply);

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
app.listen(PORT, () => console.log(`🚀 Truckbot running with images on :${PORT}`));
