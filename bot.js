import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Allowed assets
const allowedAssets = ["BTC", "SPX", "XAU", "XAG"];

// Store temporary state for each user
const userState = {}; // { chatId: { stage: "waitingAsset"|"waitingQuestion", asset: "" } }

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { stage: "waitingAsset", asset: "" };
  bot.sendMessage(chatId, `Welcome to TradeGuide! Please choose an asset: ${allowedAssets.join(", ")}`);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Ignore /start command
  if (text.startsWith("/start")) return;

  // Initialize user state if not exists
  if (!userState[chatId]) {
    userState[chatId] = { stage: "waitingAsset", asset: "" };
    bot.sendMessage(chatId, `Please choose an asset: ${allowedAssets.join(", ")}`);
    return;
  }

  const state = userState[chatId];

  // Stage 1: Ask for asset
  if (state.stage === "waitingAsset") {
    if (!allowedAssets.includes(text.toUpperCase())) {
      bot.sendMessage(chatId, `Invalid asset. Please choose: ${allowedAssets.join(", ")}`);
      return;
    }
    state.asset = text.toUpperCase();
    state.stage = "waitingQuestion";
    bot.sendMessage(chatId, `Got it! Now type your question about ${state.asset}.`);
    return;
  }

  // Stage 2: Ask for question
  if (state.stage === "waitingQuestion") {
    const question = text;

    // Call your Render backend
    try {
      const res = await fetch(`${process.env.BACKEND_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset: state.asset, question })
      });

      const data = await res.json();

      if (data.error) {
        bot.sendMessage(chatId, `Error: ${data.error}`);
      } else {
        const reply = data.reply;
        bot.sendMessage(chatId, `Asset: ${data.asset}\nBias: ${data.bias}\nAdvice: ${reply.advice}\nRisk: ${reply.risk}\nDisclaimer: ${reply.disclaimer}`);
      }
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, "Error contacting the server. Please try again later.");
    }

    // Reset state
    state.stage = "waitingAsset";
    state.asset = "";
    bot.sendMessage(chatId, `Ask about another asset: ${allowedAssets.join(", ")}`);
  }
});
