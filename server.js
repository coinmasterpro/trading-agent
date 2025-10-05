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
      "Cookie": process.env.BMP_COOKIE, // set in .env
      "X-CSRFToken": process.env.BMP_CSRF // set in .env
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
    return 123000; // fallback price
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
      // fallback parsing if JSON fails
      const html = await res.text();
      data = {
        Last_signal: html.match(/Current Signal:\s*(BUY|SELL|HOLD)/)?.[1] || "HOLD",
        Ratio: html.match(/Ratio:\s*([\d.]+)/)?.[1] || "0.65",
        Slow_MA: html.match(/Slow_MA:\s*([\d.]+)/)?.[1] || "0.67",
        Close: html.match(/Price:\s*([\d.]+)/)?.[1] || "123000"
      };
    }

    const lastSignal = data.Last_signal || "HOLD";
    const ratio = parseFloat(data.Ratio) || 0.65;
    const slowMA = parseFloat(data.Slow_MA) || 0.67;
    const price = parseFloat(data.Close) || 123000;

    const shortTermRealizedPrice = await fetchShortTermRealizedPrice();

    console.log("Market Data:", { lastSignal, ratio, slowMA, price, shortTermRealizedPrice });

    return { lastSignal, ratio, slowMA, price, shortTermRealizedPrice };
  } catch (err) {
    console.error("Error fetching market data:", err);
    return { lastSignal: "HOLD", ratio: 0.65, slowMA: 0.67, price: 123000, shortTermRealizedPrice: 123000 };
  }
}

// ====== Confidence Score ======
function calculateConfidenceScore(lastSignal, ratio, slowMA) {
  if (ratio == null || slowMA == null) return 0;

  let score = 10;
  if (lastSignal === "BUY") {
    if (ratio > slowMA) score = 10;
    else {
      const distance = Math.abs(slowMA - ratio);
      score = Math.max(Math.min((distance / (0.5 * slowMA)) * 100, 100), 10);
    }
  } else if (lastSignal === "SELL") {
    if (ratio < slowMA) score = 10;
    else {
      const distance = Math.abs(ratio - slowMA);
      score = Math.max(Math.min((distance / (0.5 * slowMA)) * 100, 100), 10);
    }
  }
  return Math.round(score);
}

// ====== Top Probability ======
function calculateTopProbability(price, shortTermRealizedPrice) {
  if (!price || !shortTermRealizedPrice) return 0;

  const ratio = price / shortTermRealizedPrice;
  if (ratio < 1) return 0;
  if (ratio >= 1.36) retur
