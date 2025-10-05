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
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", { agent: httpsAgent });
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

// ====== Fetch latest ShortTermRealizedPrice from BitcoinMagazinePro ======
async function fetchShortTermRealizedPrice() {
  try {
    const URL = "https://www.bitcoinmagazinepro.com/django_plotly_dash/app/realized_price_sth/_dash-update-component";

    const HEADERS = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Origin": "https://www.bitcoinmagazinepro.com",
      "Referer": "https://www.bitcoinmagazinepro.com/charts/short-term-holder-realized-price/",
      "Cookie": "csrftoken=8j7eEiCGCpQEqni7VKLj1AEgAEv05CV3; sessionid=9xib6d7ix1fwtm7pa2i3qwbg5vm2q2p8",
      "X-CSRFToken": "8j7eEiCGCpQEqni7VKLj1AEgAEv05CV3"
    };

    const PAYLOAD = {
      output: "chart.figure",
      outputs: { id: "chart", property: "figure" },
      inputs: [
        { id: "url", property: "pathname", value: "/charts/short-term-holder-realized-price/" },
        { id: "display", property: "children", value: "xs 533px" }
      ],
      changedPropIds: ["url.pathname","display.children"]
    };

    const res = await fetch(URL, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(PAYLOAD)
    });

    const data = await res.json();
    const sth_realized = data.response.chart.figure.data[1].y;
    const lastValue = sth_realized[sth_realized.length - 1];

    return parseFloat(lastValue);
  } catch (err) {
    console.error("Error fetching ShortTermRealizedPrice:", err);
    return null;
  }
}

// ====== Fetch Market Data ======
async function fetchMarketData() {
  try {
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", { agent: httpsAgent });
    const data = await res.json(); // <-- parse as JSON

    const lastSignal = data.Last_signal || "HOLD";
    const ratio = parseFloat(data.Ratio);
    const slowMA = parseFloat(data.Slow_MA);
    const price = parseFloat(data.Close);

    // ✅ Fetch ShortTermRealizedPrice from BitcoinMagazinePro
    const shortTermRealizedPrice = await fetchShortTermRealizedPrice();

    return { lastSignal, ratio, slowMA, price, shortTermRealizedPrice };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: null, slowMA: null, price: null, shortTermRealizedPrice: null };
  }
}

// ====== Confidence Score Calculation ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (ratio == null || slowMA == null) return 0;

  let score = 10;

  if (lastSignal === "BUY") {
    if (ratio > slowMA) {
      score = 10;
    } else {
      const distance = Math.abs(slowMA - ratio);
      const normalized = Math.min((distance / (0.5 * slowMA)) * 100, 100);
      score = Math.max(normalized, 10);
    }
  } else if (lastSignal === "SELL") {
    if (ratio < slowMA) {
      score = 10;
    } else {
      const distance = Math.abs(ratio - slowMA);
      const normalized = Math.min((distance / (0.5 * slowMA)) * 100, 100);
      score = Math.max(normalized, 10);
    }
  }

  return Math.round(score);
}

// ====== Top Probability Calculation ======
function calculateTopProbability(price, shortTermRealizedPrice) {
  if (!price || !shortTermRealizedPrice) return 0;

  const ratio = price / shortTermRealizedPrice;

  if (ratio < 1) return 0;
  if (ratio >= 1.36) return 90;
  if (ratio >= 1.18 && ratio < 1.36) {
    const slope = (90 - 60) / (1.36 - 1.18);
    return Math.round(60 + slope * (ratio - 1.18));
  }

  return Math.round(10 + ((ratio - 1) / (1.18 - 1)) * 50);
}

// ====== Core Chat Logic ======
async function handleChat(asset, question) {
  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  if (!allowedAssets.includes(asset)) {
    return { error: "I can't assist with that asset—this system only covers BTC, SPX, XAU, and XAG." };
  }

  if (!allowedQuestions.some(q => question.toLowerCase().includes(q))) {
    return { error: `I can only answer questions about: ${allowedQuestions.join(", ")}` };
  }

  const bias = biasStore[asset] || "neutral";

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

// ====== Express Endpoints ======
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

// ====== Telegram Bot ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome to *TradeGuide Bot*!\n\n` +
      `I provide trading insights for:\n` +
      `- BTC\n- SPX\n- XAU (Gold)\n- XAG (Silver)\n\n` +
      `Ask about:\n` +
      `- Market trend\n- Entry strategy\n- Exit strategy\n- Risk management\n\n` +
      `Example: *BTC market trend*`,
    { parse_mode: "Markdown" }
  );
});

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
      `💡 *Advice:* ${advice}\n\n` +
      `🔥 *Confidence Score:* ${result.confidenceScore}\n` +
      `📈 *Top Probability:* ${result.topProbability}\n\n` +
      `⚠️ *Risk Notes:* ${risk}\n\n` +
      `_${disclaimer}_`,
    { parse_mode: "Markdown" }
  );
});

// ====== Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Agent + Bot running on port ${PORT}`));
