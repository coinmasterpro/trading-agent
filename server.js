import express from "express";
import fetch from "node-fetch";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import https from "https";

dotenv.config();
const app = express();
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Bias store
let biasStore = { BTC: "neutral", SPX: "neutral", XAU: "neutral", XAG: "neutral" };

// ignores SSL verification
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // ⚠️ disables SSL verification
});

// Fetch BTC/SPX bias from website
async function fetchBias() {
  try {
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", {
      agent: httpsAgent
    });
    const html = await res.text();

    if (html.includes("Current Signal: BUY")) {
      biasStore.BTC = "bullish";
    } else if (html.includes("Current Signal: SELL")) {
      biasStore.BTC = "bearish";
    } else {
      biasStore.BTC = "neutral";
    }

    // Mirror for SPX for now (or change logic later)
    biasStore.SPX = biasStore.BTC;

    console.log("Bias updated:", biasStore);
  } catch (err) {
    console.error("Error fetching bias:", err);
  }
}

// run fetch every 5 minutes
setInterval(fetchBias, 5 * 60 * 1000);
fetchBias();

// ===== ADMIN ENDPOINT =====
app.post("/admin/set-bias", (req, res) => {
  const { password, asset, bias } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  const allowed = ["XAU", "XAG"];
  if (!allowed.includes(asset)) {
    return res.status(400).json({ error: "Only XAU and XAG can be set manually" });
  }

  if (!["bullish", "bearish", "neutral"].includes(bias)) {
    return res.status(400).json({ error: "Bias must be bullish, bearish, or neutral" });
  }

  biasStore[asset] = bias;
  console.log(`Admin override: ${asset} set to ${bias}`);
  res.json({ success: true, asset, bias });
});

// ===== CHAT ENDPOINT =====
app.post("/chat", async (req, res) => {
  const { asset, question } = req.body;

  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  if (!allowedAssets.includes(asset)) {
    return res.json({
      error: "I can't assist with that asset—this system only covers BTC, SPX, XAU, and XAG."
    });
  }

  const bias = biasStore[asset] || "neutral";

  const systemPrompt = `
You are TradeGuide, a trading assistant. You may only discuss BTC, SPX, XAU, and XAG.
For BTC and SPX, you must use the current bias from the Bias Store: "${bias}".
For XAU and XAG, use the admin-set bias.
Never form your own bias.
Always include the disclaimer: "This is educational only — not financial advice."
Answer concisely.
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Question: ${question}\nAsset: ${asset}\nBias: ${bias}` }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    const reply = completion.choices[0].message.content;
    res.json({ asset, bias, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "LLM error" });
  }
});

app.listen(3000, () => console.log("Agent running on http://localhost:3000"));

