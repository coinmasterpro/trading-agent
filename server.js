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

// ====== Fetch Bias from /premium_access ======
async function fetchBias() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/premium_access", { agent: httpsAgent });
    const html = await res.text();

    // console.log("🔍 Fetched HTML snippet:", html.slice(0, 400));

    if (html.toLowerCase().includes("current signal: buy")) biasStore.BTC = "bullish";
    else if (html.toLowerCase().includes("current signal: sell")) biasStore.BTC = "bearish";
    else biasStore.BTC = "neutral";

    console.log("✅ Bias updated:", biasStore.BTC);
  } catch (err) {
    console.error("❌ Error fetching bias:", err.message);
    biasStore.BTC = "neutral";
  }
}

setInterval(fetchBias, 60 * 60 * 1000); // refresh hourly
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
    console.error("❌ Error fetching market data:", err.message);
    return { lastSignal: "HOLD", ratio: 0.65, slowMA: 0.67, price: 123000 };
  }
}

// ====== Confidence Score Calculation ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (ratio == null
