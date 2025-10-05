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

    if (html.includes("Current Signal: BUY")) biasStore.BTC = "bullish";
    else if (html.includes("Current Signal: SELL")) biasStore.BTC = "bearish";
    else biasStore.BTC = "neutral";

    biasStore.SPX = biasStore.BTC; // Mirror BTC
    console.log("Bias updated:", biasStore);
  } catch (err) {
    console.error("Error fetching bias:", err);
    if (retries > 0) setTimeout(() => fetchBias(retries - 1), 5000);
  }
}

setInterval(fetchBias, 60 * 60 * 1000);
fetchBias();

// ====== Fetch ShortTermRealizedPrice from BitcoinMagazinePro ======
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
      changedPropIds: ["url.pathname","display.children"]
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

// ====== Fetch Market Data ======
async function fetchMarketData() {
  try {
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", { agent: httpsAgent });
    let data;
    try {
      data = await res.json();
    } catch {
      const html = await res.text();
      data = {
        Last_signal: html.match(/Current Signal:\s*(BUY|SELL|HOLD)/)?.[1] || "HOLD",
        Ratio: html.match(/Ratio:\s*([\d.]+)/)?.[1] || "0.65",
        Slow_MA: html.match(/Slow_MA:\s*([\d.]+)/)?.[1] || "0.67",
        Close: html.match(/Price:\s*([\d.]+)/)?.[1] || "123000"
      };
    }

    const lastSignal = data.Last_signal || "HOLD";
    const ratio = parseFloat(data.Ratio);
    const slowMA = parseFloat(data.Slow_MA);
    const price = parseFloat(data.Close);
    const shortTermRealizedPrice = await fetchShortTermRealizedPrice();

    console.log("Market Data:", { lastSignal, ratio, slowMA, price, shortTermRealizedPrice });
    return { lastSignal, ratio, slowMA, price, shortTermRealizedPrice };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: 0.65, slowMA: 0.67, price: 123000, shortTermRealizedPrice: 123000 };
  }
}

// ====== Confidence Score 40–100% ======
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
function calculateTopProbability(price, shortTermRealizedPrice) {
  if (!price || !shortTermRealizedPrice) return 0;
  const ratio = price / shortTermRealizedPrice;

  if (ratio < 1) return 0;
  if (ratio >= 1.36) return 90;
  if (ratio >= 1.18) return Math.round(60 + ((ratio - 1.18)/(1.36 - 1.18))*(90-60));
  return Math.round(10 + ((ratio - 1) / (1.18 - 1)) * 50);
}

// ====== Core Chat Logic ======
async function handleChat(asset, question) {
  if (!["BTC","SPX","XAU","XAG"].includes(asset)) return { error: "Only BTC, SPX, XAU, XAG allowed." };
  if (!allowedQuestions.some(q => question.toLowerCase().includes(q))) return { error: `Only answerable questions: ${allowedQuestions.join(", ")}`; };

  const bias = biasStore[asset] || "neutral";
  const { lastSignal, ratio, slowMA, price, shortTermRealizedPrice } = await fetchMarketData();
  const confidenceScore = calculateConfidenceScore(lastSignal, ratio, slowMA);
  const topProbability = calculateTopProbability(price, shortTermRealizedPrice);

  const systemPrompt = `
  You are TradeGuide, a trading assistant.
  - Assets: BTC, SPX, XAU, XAG only.
  - Use current bias for BTC/SPX from Bias Store.
  - Use admin-set bias for XAU/XAG.
  - Answer in JSON format: { "advice": "...", "risk": "...", "disclaimer": "..." }
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
    console.error("LLM error:", err);
    return { error: "LLM error" };
  }
}

// ====== Express Endpoints ======
app.post("/admin/set-bias", (req, res) => {
  const { password, asset, bias } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(403).json({ error: "Unauthorized" });
  if (!["XAU","XAG"].includes(asset)) return res.status(400).json({ error: "Only XAU/XAG" });
  if (!["bullish","bearish","neutral"].includes(bias)) return res.status(400).json({ error: "Invalid bias" });
  biasStore[asset] = bias;
  res.json({ success: true, asset, bias });
});

app.get("/bias", (req, res) => res.json(biasStore));
app.post("/chat", async (req, res) => res.json(await handleChat(req.body.asset, req.body.question)));

// ====== Telegram Bot ======
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `👋 Welcome to *TradeGuide Bot*!\nAsk about BTC, SPX, XAU, XAG for:\n- Market trend\n- Entry strategy\n- Exit strategy\n- Risk management`,
    { parse_mode: "Markdown" }
  );
});

bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text || text.startsWith("/start")) return;

  const asset = ["BTC","SPX","XAU","XAG"].find(a => text.toUpperCase().includes(a));
  if (!asset) return bot.sendMessage(chatId, "❌ Only BTC, SPX, XAU, XAG supported.");
  const question = allowedQuestions.find(q => text.toLowerCase().includes(q));
  if (!question) return bot.sendMessage(chatId, `❌ Allowed questions: ${allowedQuestions.join(", ")}`);

  const result = await handleChat(asset, question);
  if (result.error) return bot.sendMessage(chatId, `⚠️ Error: ${result.error}`);

  bot.sendMessage(chatId,
    `📊 *${asset} — ${question}*\n\n` +
    `💡 *Advice:* ${result.reply.advice || "No advice"}\n` +
    `🔥 *Confidence Score:* ${result.confidenceScore}\n` +
    `📈 *Top Probability:* ${result.topProbability}\n` +
    `⚠️ *Risk Notes:* ${result.reply.risk || "No risk notes"}\n\n` +
    `_${result.reply.disclaimer || ""}_`,
    { parse_mode: "Markdown" }
  );
});

// ====== Start Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Agent + Bot running on port ${PORT}`));
