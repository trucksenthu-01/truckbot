import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import OpenAI from 'openai';
import fs from 'fs';

const app = express();
app.use(bodyParser.json());
app.use(cors({ origin: ['https://trucksenthusiasts.com'] })); // lock to your domain
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const affiliateMap = JSON.parse(fs.readFileSync('./affiliateMap.json','utf8'));

function findAffiliate({ query, asin, sku }) {
  const q = (query||'').toLowerCase();
  let row = affiliateMap.find(r => (asin && r.asin===asin) || (sku && r.sku===sku));
  if (!row) row = affiliateMap.find(r =>
    r.asin===asin || r.sku===sku || r.name.toLowerCase().includes(q) || (r.tags||[]).some(t=>q.includes(t))
  );
  return row ? { url: row.url, asin: row.asin, name: row.name } : { url: null };
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_affiliate_link",
      description: "Return an affiliate URL for a product by name/asin/sku. If not found, return null.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          asin: { type: "string", nullable: true },
          sku: { type: "string", nullable: true }
        },
        required: ["query"]
      }
    }
  }
];

app.post('/chat', async (req, res) => {
  const { message, session } = req.body;

  const system = `
You are "Trucks Helper", an expert on pickup trucks, lift kits, tires, wheels, tonneau covers, towing, fitment.
- When you recommend a specific product, try the get_affiliate_link tool first.
- If a link exists, include a short CTA and the link.
- Include this once per session at the end if not already shown: "As an Amazon Associate, we may earn from qualifying purchases."
- Ask for fitment essentials when needed (year, bed length, trim).
- Be safety-focused; refuse illegal/unsafe advice and suggest safer alternatives.
`;

  let msgs = [
    { role: "system", content: system },
    { role: "user", content: message, name: session?.slice(0,12) || "visitor" }
  ];

  // 1st pass (tool auto)
  let r = await openai.chat.completions.create({
    model: "gpt-5",
    messages: msgs,
    tools,
    tool_choice: "auto",
    temperature: 0.3
  });

  const ch = r.choices[0].message;
  if (ch.tool_calls?.length) {
    const call = ch.tool_calls[0];
    const args = JSON.parse(call.function.arguments || "{}");
    const result = findAffiliate(args);

    msgs.push(ch);
    msgs.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });

    r = await openai.chat.completions.create({ model: "gpt-5", messages: msgs, temperature: 0.3 });
  }

  res.json({ reply: r.choices[0].message.content });
});

app.get('/health', (_req,res)=>res.send('ok'));
app.listen(3000, ()=>console.log('Truckbot on :3000'));
// See chat for full version
