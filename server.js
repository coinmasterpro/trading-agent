import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import https from "https";

dotenv.config();
const app = express();
app.use(express.json());

// ====== HTTPS agent to ignore SSL issues ======
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ====== Telegram Bot Init ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ====== Bias Store ======
let biasStore = { BTC: "neutral" };

// ====== Fetch Bias and Confidence Data ======
async function fetchBias() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/data", { agent: httpsAgent });
    const text = await res.text();

    console.log("🔍 Raw /data response:", text.slice(0, 200));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error("⚠️ Response not valid JSON — maybe HTML or error page");
      biasStore.BTC = "neutral";
      return { confidence: 0, topProbability: 0 };
    }

    // Extract and normalize signal
    const rawSignal =
      data.Last_signal || data.last_signal || data["Last Signal"] || data["signal"] || "";
    const signal = rawSignal.toString().toUpperCase().trim();

    if (signal === "BUY") biasStore.BTC = "bullish";
    else if (signal === "SELL") biasStore.BTC = "bearish";
    else biasStore.BTC = "neutral";

    console.log("✅ Bias updated:", biasStore.BTC, "| Raw Signal:", signal);

    // Extract confidence & top probability if available
    const confidence = Number(data.Confidence || data.confidence || 0) || 40;
    const topProbability = Number(data.Top_Probability || data.topProbability || data.top_prob || 0) || 32;

    return { confidence, topProbability };
  } catch (err) {
    console.error("❌ Error fetching data:", err.message);
    biasStore.BTC = "neutral";
    return { confidence: 0, topProbability: 0 };
  }
}

// ====== Generate Strategy Message ======
function generateMessage(bias, confidence, topProbability) {
  let emoji = "⚖️";
  let strategy = "Market indecisive — wait for a clearer trend before entering.";

  if (bias === "bullish") {
    emoji = "🟢";
    strategy = "Buy Spot and enter Long position if confidence > 40%.";
  } else if (bias === "bearish") {
    emoji = "🔴";
    strategy = "Sell Spot / enter Short if confidence > 40%.";
  }

  return `
💎 Bitcoin Strategy

${emoji} Bias: ${bias.charAt(0).toUpperCase() + bias.slice(1)}
💡 Strategy: ${strategy}

🔥 Confidence Score: ${confidence}%
📊 Top Probability: ${topProbability}%

Disclaimer: This is not financial advice. Trade responsibly.
`;
}

// ====== Telegram Command ======
bot.onText(/\/btc|\/start|\/signal/i, async (msg) => {
  const chatId = msg.chat.id;

  await bot.sendMessage(chatId, "⏳ Fetching latest Bitcoin data...");

  const { confidence, topProbability } = await fetchBias();
  const bias = biasStore.BTC;

  const message = generateMessage(bias, confidence, topProbability);
  await bot.sendMessage(chatId, message);
});

// ====== Express Test Endpoint ======
app.get("/", (req, res) => res.send("✅ Crypto Bias Bot Running"));
app.get("/bias", (req, res) => res.json(biasStore));

// ====== Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
