import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import https from "https";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();
const app = express();
app.use(express.json());

// ====== HTTPS Agent (ignore SSL errors if needed) ======
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ====== Fetch Bias from Swing-Trade-Crypto ======
async function fetchBias() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/premium_access", { agent: httpsAgent });
    const html = await res.text();

    if (html.includes("Current Signal: BUY")) return "bullish";
    if (html.includes("Current Signal: SELL")) return "bearish";
    return "neutral";
  } catch (err) {
    console.error("Error fetching bias:", err);
    return "neutral";
  }
}

// ====== Fetch Market Data (for confidence calculation) ======
async function fetchMarketData() {
  try {
    const res = await fetch("http://www.swing-trade-crypto.site/data", { agent: httpsAgent });
    const data = await res.json();

    const lastSignal = data.Last_signal || "HOLD";
    const ratio = parseFloat(data.Ratio);
    const slowMA = parseFloat(data.Slow_MA);
    const price = parseFloat(data.Close);

    console.log("Fetched Market Data:", { lastSignal, ratio, slowMA, price });
    return { lastSignal, ratio, slowMA, price };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: 0.65, slowMA: 0.67, price: 123000 };
  }
}

// ====== Fetch Short-Term Realized Price (for Top Probability) ======
async function fetchShortTermRealizedPrice() {
  try {
    const URL = "https://www.bitcoinmagazinepro.com/django_plotly_dash/app/realized_price_sth/_dash-update-component";
    const HEADERS = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Origin": "https://www.bitcoinmagazinepro.com",
      "Referer": "https://www.bitcoinmagazinepro.com/charts/short-term-holder-realized-price/",
      "Cookie": process.env.BMP_COOKIE,
      "X-CSRFToken": process.env.BMP_CSRF
    };
    const PAYLOAD = {
      output: "chart.figure",
      outputs: { id: "chart", property: "figure" },
      inputs: [
        { id: "url", property: "pathname", value: "/charts/short-term-holder-realized-price/" },
        { id: "display", property: "children", value: "xs 533px" }
      ],
      changedPropIds: ["url.pathname", "display.children"]
    };

    const res = await fetch(URL, { method: "POST", headers: HEADERS, body: JSON.stringify(PAYLOAD) });
    const data = await res.json();
    const sth_realized = data.response.chart.figure.data[1].y;
    return parseFloat(sth_realized[sth_realized.length - 1]);
  } catch (err) {
    console.error("Error fetching ShortTermRealizedPrice:", err);
    return 123000; // fallback
  }
}

// ====== Confidence Score (Corrected Logic) ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (!ratio || !slowMA) return 40;

  const distance = Math.abs(ratio - slowMA);
  const normalized = Math.min((distance / (0.1 * slowMA)) * 100, 100);
  let score = 40 + normalized * 0.6; // base scale 40–100%

  // ✅ Correct trend alignment
  if ((lastSignal === "BUY" && ratio > slowMA) || (lastSignal === "SELL" && ratio < slowMA)) {
    return Math.round(score); // aligned
  } else {
    return 40; // misaligned
  }
}

// ====== Top Probability ======
function calculateTopProbability(price, shortTermRealizedPrice) {
  if (!price || !shortTermRealizedPrice) return 0;
  const ratio = price / shortTermRealizedPrice;

  if (ratio < 1) return 0;
  if (ratio >= 1.5) return 95;
  if (ratio >= 1.36) return 85;
  if (ratio >= 1.18) return Math.round(60 + ((ratio - 1.18) / (1.36 - 1.18)) * (85 - 60));
  return Math.round(10 + ((ratio - 1) / (1.18 - 1)) * 50);
}

// ====== Bitcoin Strategy Core ======
async function handleBitcoinStrategy() {
  const bias = await fetchBias();
  const { lastSignal, ratio, slowMA, price } = await fetchMarketData();
  const shortTermRealizedPrice = await fetchShortTermRealizedPrice();

  const confidenceScore = calculateConfidenceScore(lastSignal, ratio, slowMA);
  const topProbability = calculateTopProbability(price, shortTermRealizedPrice);

  let message = `💎 *Bitcoin Strategy*\n\n`;

  if (bias === "bullish") {
    message += `📈 *Bias:* Bullish\n💰 *Advice:* Buy Spot and enter Long position if confidence score > 40%\n`;
    if (confidenceScore > 40) {
      message += `🧭 *Entry Strategy:* Enter long at current price.\nSet Stop Loss at *-10%* of current price and keep leverage max *2x*.\nYou may adjust based on your risk appetite.\n`;
    }
  } else if (bias === "bearish") {
    message += `📉 *Bias:* Bearish\n🚫 *Advice:* Close all Long Positions. Don’t Short or Sell Spot BTC.\n`;
  } else {
    message += `⚖️ *Bias:* Neutral\n🤔 Market indecisive — wait for a clearer trend before entering.\n`;
  }

  message += `\n🔥 *Confidence Score:* ${confidenceScore}%\n📊 *Top Probability:* ${topProbability}%\n`;

  if (topProbability > 50) {
    message += `⚠️ Be cautious — market top could be approaching.\n`;
  }

  message += `\n_Disclaimer: This is not financial advice. Trade responsibly._`;

  return message;
}

// ====== Telegram Bot Setup ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, msg => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome to *TradeGuide Bot*\n\nClick below to get your current Bitcoin strategy.`,
    {
      reply_markup: {
        keyboard: [[{ text: "🪙 Bitcoin Strategy" }]],
        resize_keyboard: true
      },
      parse_mode: "Markdown"
    }
  );
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (text === "🪙 Bitcoin Strategy") {
    bot.sendMessage(chatId, "⏳ Fetching latest Bitcoin data...", { parse_mode: "Markdown" });
    const message = await handleBitcoinStrategy();
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }
});

// ====== Express Endpoint (optional external API access) ======
app.get("/bitcoin-strategy", async (req, res) => {
  const message = await handleBitcoinStrategy();
  res.json({ message });
});

// ====== Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bitcoin Strategy Bot running on port ${PORT}`));
