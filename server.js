import express from "express";
import fetch from "node-fetch";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import https from "https";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();
const app = express();
app.use(express.json());

// ====== Groq Client ======
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ====== Bias Store ======
let biasStore = { BTC: "neutral", SPX: "neutral", XAU: "neutral", XAG: "neutral" };

// Allowed question types
const allowedQuestions = [
  "market trend",
  "entry strategy",
  "exit strategy",
  "risk management"
];

// ====== Ignore SSL (for scraping) ======
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ====== Fetch BTC/SPX bias from external site ======
async function fetchBias(retries = 3) {
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

    biasStore.SPX = biasStore.BTC; // Mirror BTC for now
    console.log("Bias updated:", biasStore);
  } catch (err) {
    console.error("Error fetching bias:", err);
    if (retries > 0) {
      console.log("Retrying fetchBias...");
      setTimeout(() => fetchBias(retries - 1), 5000);
    }
  }
}

// Run fetch every 5 minutes
setInterval(fetchBias, 5 * 60 * 1000);
fetchBias();

// ====== ADMIN ENDPOINT ======
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

// ====== BIAS ENDPOINT ======
app.get("/bias", (req, res) => {
  res.json(biasStore);
});

// ====== CHAT ENDPOINT ======
app.post("/chat", async (req, res) => {
  const { asset, question } = req.body;

  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  if (!allowedAssets.includes(asset)) {
    return res.json({
      error: "I can't assist with that asset—this system only covers BTC, SPX, XAU, and XAG."
    });
  }

  if (!allowedQuestions.some(q => question.toLowerCase().includes(q))) {
    return res.json({
      error: `I can only answer questions about: ${allowedQuestions.join(", ")}`
    });
  }

  const bias = biasStore[asset] || "neutral";

  const systemPrompt = `
You are TradeGuide, a trading assistant.
- Assets: BTC, SPX, XAU, XAG only.
- Use current bias for BTC/SPX from Bias Store.
- Use admin-set bias for XAU/XAG.
- Do not form your own bias.
- Answer in JSON format: { "advice": "...", "risk": "...", "disclaimer": "This is educational only — not financial advice." }
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
    res.json({ asset, bias, reply: JSON.parse(reply) });
  } catch (err) {
    console.error("Groq LLM error:", err);
    res.status(500).json({ error: "LLM error" });
  }
});

// ====== TELEGRAM BOT ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome to *TradeGuide Bot*!\n\n` +
      `I can help you with trading insights for:\n` +
      `- BTC\n- SPX\n- XAU (Gold)\n- XAG (Silver)\n\n` +
      `You can ask about:\n` +
      `- Market trend\n- Entry strategy\n- Exit strategy\n- Risk management\n\n` +
      `Example: *BTC market trend*`,
    { parse_mode: "Markdown" }
  );
});

// Catch-all for trading questions
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Skip /start (already handled)
  if (!text || text.startsWith("/start")) return;

  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  const asset = allowedAssets.find((a) => text.toUpperCase().includes(a));
  if (!asset) {
    return bot.sendMessage(chatId, "❌ I can only help with BTC, SPX, XAU, or XAG.");
  }

  const question = allowedQuestions.find((q) => text.toLowerCase().includes(q));
  if (!question) {
    return bot.sendMessage(
      chatId,
      `❌ I can only answer questions about:\n${allowedQuestions.join(", ")}`
    );
  }

  try {
    const response = await fetch(`${process.env.SERVER_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asset, question })
    });

    const data = await response.json();
    if (data.error) {
      return bot.sendMessage(chatId, `⚠️ Error: ${data.error}`);
    }

    const advice = data.reply.advice || "No advice generated.";
    const risk = data.reply.risk || "No risk notes.";
    const disclaimer = data.reply.disclaimer || "";

    bot.sendMessage(
      chatId,
      `📊 *${asset} — ${question}*\n\n` +
        `💡 Advice: ${advice}\n\n` +
        `⚠️ Risk: ${risk}\n\n` +
        `_${disclaimer}_`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Bot error:", err);
    bot.sendMessage(chatId, "❌ Sorry, something went wrong while fetching advice.");
  }
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Agent + Bot running on port ${PORT}`));
