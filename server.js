import express from "express";
import fetch from "node-fetch";
import Groq from "groq-sdk";
import dotenv from "dotenv";
import https from "https";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();
const app = express();
app.use(express.json());

// ===== GROQ CLIENT =====
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ===== BIAS STORE =====
let biasStore = { BTC: "neutral", SPX: "neutral", XAU: "neutral", XAG: "neutral" };

// Allowed question types
const allowedQuestions = [
  "market trend",
  "entry strategy",
  "exit strategy",
  "risk management"
];

// ignores SSL verification
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ===== FETCH BIAS FROM WEBSITE =====
async function fetchBias(retries = 3) {
  try {
    const res = await fetch("https://www.swing-trade-crypto.site/premium_access", {
      agent: httpsAgent,
    });
    const html = await res.text();

    if (html.includes("Current Signal: BUY")) {
      biasStore.BTC = "bullish";
    } else if (html.includes("Current Signal: SELL")) {
      biasStore.BTC = "bearish";
    } else {
      biasStore.BTC = "neutral";
    }

    biasStore.SPX = biasStore.BTC; // Mirror for now
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

// ===== BIAS ENDPOINT =====
app.get("/bias", (req, res) => {
  res.json(biasStore);
});

// ===== CHAT ENDPOINT =====
app.post("/chat", async (req, res) => {
  const { asset, question } = req.body;

  const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
  if (!allowedAssets.includes(asset)) {
    return res.json({
      error:
        "I can't assist with that asset—this system only covers BTC, SPX, XAU, and XAG.",
    });
  }

  if (!allowedQuestions.some((q) => question.toLowerCase().includes(q))) {
    return res.json({
      error: `I can only answer questions about: ${allowedQuestions.join(", ")}`,
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
      model: "llama3-70b-8192",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Question: ${question}\nAsset: ${asset}\nBias: ${bias}` },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const rawReply = completion.choices[0].message.content;

    let parsedReply;
    try {
      parsedReply = JSON.parse(rawReply);
    } catch (e) {
      console.error("⚠️ JSON parse failed, returning raw:", rawReply);
      parsedReply = { raw: rawReply };
    }

    res.json({ asset, bias, reply: parsedReply });
  } catch (err) {
    console.error("❌ LLM error details:", err.response?.data || err.message || err);
    res.status(500).json({
      error: "LLM error",
      details: err.response?.data || err.message,
    });
  }
});

// ===== TELEGRAM BOT (WEBHOOK MODE) =====
if (process.env.TELEGRAM_BOT_TOKEN) {
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

  // Set webhook to Render external URL
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  bot.setWebHook(webhookUrl);

  // Endpoint for Telegram to send updates
  app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || "";

    const [assetInput, ...questionParts] = text.split(" ");
    const asset = assetInput?.toUpperCase();
    const question = questionParts.join(" ");

    const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];
    if (!allowedAssets.includes(asset)) {
      return bot.sendMessage(
        chatId,
        "❌ I can only help with BTC, SPX, XAU, or XAG."
      );
    }

    try {
      const resApi = await fetch(`${process.env.RENDER_INTERNAL_URL || "http://localhost:" + PORT}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset, question }),
      });
      const data = await resApi.json();

      if (data.error) {
        return bot.sendMessage(chatId, `⚠️ ${data.error}`);
      }

      const reply =
        data.reply.advice ||
        data.reply.raw ||
        JSON.stringify(data.reply, null, 2);

      bot.sendMessage(
        chatId,
        `📊 *${asset}* (Bias: ${data.bias})\n\n${reply}`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("Telegram bot error:", e);
      bot.sendMessage(chatId, "❌ Error fetching advice.");
    }
  });

  console.log("✅ Telegram bot running in webhook mode");
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Agent running on port ${PORT}`));
