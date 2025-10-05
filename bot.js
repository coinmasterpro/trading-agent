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

// Run fetch every 60 minutes
setInterval(fetchBias, 60 * 60 * 1000);
fetchBias();

// ====== NEW: Fetch Ratio, Slow_MA, ShortTermRealizedPrice ======
async function fetchMarketData() {
  try {
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", {
      agent: httpsAgent
    });
    const html = await res.text();

    // Parse last_signal
    const lastSignalMatch = html.match(/Current Signal:\s*(BUY|SELL|HOLD)/);
    const lastSignal = lastSignalMatch ? lastSignalMatch[1] : "HOLD";

    // Parse Ratio and Slow_MA (these should be exposed in the page, adjust regex as needed)
    const ratioMatch = html.match(/Ratio:\s*([\d.]+)/);
    const slowMAMatch = html.match(/Slow_MA:\s*([\d.]+)/);
    const priceMatch = html.match(/Price:\s*([\d.]+)/);
    const strpMatch = html.match(/ShortTermRealizedPrice:\s*([\d.]+)/);

    const ratio = ratioMatch ? parseFloat(ratioMatch[1]) : null;
    const slowMA = slowMAMatch ? parseFloat(slowMAMatch[1]) : null;
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;
    const shortTermRealizedPrice = strpMatch ? parseFloat(strpMatch[1]) : null;

    return { lastSignal, ratio, slowMA, price, shortTermRealizedPrice };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: null, slowMA: null, price: null, shortTermRealizedPrice: null };
  }
}

// ====== NEW: Confidence Score Calculation ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (!ratio || !slowMA) return 0;

  let score = 10; // Default low confidence

  if (lastSignal === "BUY") {
    if (ratio > slowMA) {
      // weak alignment
      score = 10;
    } else {
      const distance = Math.abs(slowMA - ratio);
      // normalize distance (assuming 0–(0.5*slowMA) maps to 10–100)
      const normalized = Math.min((distance / (0.5 * slowMA)) * 100, 100);
      score = Math.max(normalized, 10);
    }
  } else if (lastSignal === "SELL") {
    if (ratio < slowMA) {
      // weak alignment
      score = 10;
    } else {
      const distance = Math.abs(ratio - slowMA);
      const normalized = Math.min((distance / (0.5 * slowMA)) * 100, 100);
      score = Math.max(normalized, 10);
    }
  } else {
    score = 10;
  }

  return Math.round(score);
}

// ====== NEW: Top Probability Calculation ======
function calculateTopProbability(price, shortTermRealizedPrice) {
  if (!price || !shortTermRealizedPrice) return 0;

  const ratio = price / shortTermRealizedPrice;

  if (ratio < 1) {
    return 0; // Top already in
  }
  if (ratio >= 1.36) {
    return 90;
  }
  if (ratio >= 1.18 && ratio < 1.36) {
    // Linear interpolation between 60% and 90%
    const slope = (90 - 60) / (1.36 - 1.18);
    return Math.round(60 + slope * (ratio - 1.18));
  }

  // ratio >1 but <1.18 → top yet to come, below 60%
  return Math.round(10 + ((ratio - 1) / (1.18 - 1)) * 50); // 10–60%
}

// ====== CORE CHAT LOGIC ======
async function handleChat(asset, question) {
  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  if (!allowedAssets.includes(asset)) {
    return { error: "I can't assist with that asset—this system only covers BTC, SPX, XAU, and XAG." };
  }

  if (!allowedQuestions.some(q => question.toLowerCase().includes(q))) {
    return { error: `I can only answer questions about: ${allowedQuestions.join(", ")}` };
  }

  const bias = biasStore[asset] || "neutral";

  // ===== Fetch Market Data & Compute Scores =====
  const { lastSignal, ratio, slowMA, price, shortTermRealizedPrice } = await fetchMarketData();
  const confidenceScore = calculateConfidenceScore(lastSignal, ratio, slowMA);
  const topProbability = calculateTopProbability(price, shortTermRealizedPrice);

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
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Question: ${question}\nAsset: ${asset}\nBias: ${bias}` }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    const reply = completion.choices[0].message.content;
    return {
      asset,
      bias,
      lastSignal,
      ratio,
      slowMA,
      price,
      shortTermRealizedPrice,
      confidenceScore: `${confidenceScore}%`,
      topProbability: `${topProbability}%`,
      reply: JSON.parse(reply)
    };
  } catch (err) {
    console.error("Groq LLM error:", err);
    return { error: "LLM error" };
  }
}

// ====== EXPRESS ENDPOINTS ======
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

app.get("/bias", (req, res) => {
  res.json(biasStore);
});

app.post("/chat", async (req, res) => {
  const { asset, question } = req.body;
  const result = await handleChat(asset, question);
  res.json(result);
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

  const result = await handleChat(asset, question);

  if (result.error) {
    return bot.sendMessage(chatId, `⚠️ Error: ${result.error}`);
  }

  const advice = result.reply.advice || "No advice generated.";
  const risk = result.reply.risk || "No risk notes.";
  const disclaimer = result.reply.disclaimer || "";

  bot.sendMessage(
    chatId,
    `📊 *${asset} — ${question}*\n\n` +
      `💡 Advice: ${advice}\n\n` +
      `🔥 Confidence: ${result.confidenceScore}\n` +
      `📈 Top Probability: ${result.topProbability}\n\n` +
      `⚠️ Risk: ${risk}\n\n` +
      `_${disclaimer}_`,
    { parse_mode: "Markdown" }
  );
});

// ====== START SERVER ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Agent + Bot running on port ${PORT}`));
