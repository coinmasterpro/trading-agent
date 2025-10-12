import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import https from "https";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();
const app = express();
app.use(express.json());

// ====== Ignore SSL (for scraping) ======
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ====== Bias Store ======
let biasStore = { BTC: "neutral" };

// ====== Fetch Bias from JSON site ======
async function fetchBias() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/data", { agent: httpsAgent });
    const data = await res.json();

    const signal = (data?.Last_signal || "").toUpperCase();
    if (signal === "BUY") biasStore.BTC = "bullish";
    else if (signal === "SELL") biasStore.BTC = "bearish";
    else biasStore.BTC = "neutral";

    console.log("✅ Bias updated:", biasStore);
  } catch (err) {
    console.error("Error fetching bias:", err);
    biasStore.BTC = "neutral";
  }
}

setInterval(fetchBias, 60 * 60 * 1000);
fetchBias();

// ====== Fetch Market Data ======
async function fetchMarketData() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/data", { agent: httpsAgent });
    const data = await res.json();

    const lastSignal = data.Last_signal || "HOLD";
    const ratio = parseFloat(data.Ratio);
    const slowMA = parseFloat(data.Slow_MA);
    const price = parseFloat(data.Close);

    console.log("Market Data:", { lastSignal, ratio, slowMA, price });
    return { lastSignal, ratio, slowMA, price };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: 0.65, slowMA: 0.67, price: 123000 };
  }
}

// ====== Confidence Score Calculation ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (ratio == null || slowMA == null) return 40;

  const distance = Math.abs(ratio - slowMA);
  let normalized = Math.min((distance / (0.1 * slowMA)) * 100, 100);
  let score = 40 + normalized * 0.6; // Scale 40–100%

  if ((lastSignal === "BUY" && ratio < slowMA) || (lastSignal === "SELL" && ratio > slowMA)) {
    score = score; // good alignment
  } else {
    score = 40; // weak alignment
  }

  return Math.round(score);
}

// ====== Top Probability Calculation ======
function calculateTopProbability(price, shortTermRealizedPrice = 76000) {
  if (!price || !shortTermRealizedPrice) return 0;
  const ratio = price / shortTermRealizedPrice;

  if (ratio < 1) return 0;
  if (ratio >= 1.36) return 90;
  if (ratio >= 1.18) return Math.round(60 + ((ratio - 1.18) / (1.36 - 1.18)) * (90 - 60));
  return Math.round(10 + ((ratio - 1) / (1.18 - 1)) * 50);
}

// ====== Handle Strategy Logic ======
async function handleBitcoinStrategy() {
  const { lastSignal, ratio, slowMA, price } = await fetchMarketData();
  const confidenceScore = calculateConfidenceScore(lastSignal, ratio, slowMA);

  // Using price / 76000 (approx) to simulate top probability
  const topProbability = calculateTopProbability(price, 76000);

  const bias = biasStore.BTC;

  let advice = "";
  let risk = "";

  if (bias === "bullish") {
    advice = `🟢 *Bias:* Bullish\n💡 *Strategy:* Buy Spot and enter Long position if confidence score > 40%.`;

    if (confidenceScore > 40) {
      advice += `\n\n📈 *Entry Strategy:* Enter long at current price (${price}).\nKeep Stop Loss at -10% of current price.\nUse maximum leverage of 2x.\nYou can adjust leverage and SL per your risk appetite, but it's advisable to stick to these levels.`;
    }

    if (topProbability > 50) {
      risk += `⚠️ *Be cautious as a market top could be approaching.*`;
    }
  } else if (bias === "bearish") {
    advice = `🔴 *Bias:* Bearish\n💡 *Strategy:* Close all Long Positions. Do *not* Short or Sell Spot BTC.`;

    if (topProbability > 50) {
      risk += `⚠️ *Be cautious as a market top could be approaching.*`;
    }
  } else {
    advice = `⚪ *Bias:* Neutral\n💡 *Strategy:* Wait for clearer confirmation before entering any trade.`;
  }

  const disclaimer =
    "_This advice is for educational purposes only. Trading involves risk. Do your own research before taking any positions._";

  return {
    asset: "BTC",
    bias,
    lastSignal,
    confidenceScore: `${confidenceScore}%`,
    topProbability: `${topProbability}%`,
    price,
    advice,
    risk,
    disclaimer
  };
}

// ====== Express Endpoints ======
app.get("/bias", (req, res) => res.json(biasStore));

app.get("/bitcoin-strategy", async (req, res) => {
  const result = await handleBitcoinStrategy();
  res.json(result);
});

// ====== Telegram Bot ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Welcome to *Bitcoin Strategy Bot*!\n\nClick below to get your latest strategy:\n👉 Type "Bitcoin Strategy"`,
    { parse_mode: "Markdown" }
  );
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim().toLowerCase();
  if (!text || text.startsWith("/start")) return;

  if (text.includes("bitcoin strategy")) {
    const result = await handleBitcoinStrategy();

    bot.sendMessage(
      chatId,
      `📊 *Bitcoin Strategy*\n\n${result.advice}\n\n🔥 *Confidence Score:* ${result.confidenceScore}\n📈 *Top Probability:* ${result.topProbability}\n\n${result.risk}\n\n${result.disclaimer}`,
      { parse_mode: "Markdown" }
    );
  } else {
    bot.sendMessage(chatId, "❌ Please type *Bitcoin Strategy* to get the latest update.", {
      parse_mode: "Markdown"
    });
  }
});

// ====== Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bitcoin Strategy Agent running on port ${PORT}`));
