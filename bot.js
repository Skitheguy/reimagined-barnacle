require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const axios = require("axios");
const express = require("express");
const cron = require("node-cron");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID; // channel to send trade alerts to
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme";

// Watchlist — edit freely
const WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN",
  "META", "TSLA", "SPY",  "QQQ",  "AMD",
  "NFLX", "COST", "AVGO", "ORCL", "CRM",
];

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Register slash commands ──────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Run a technical scan on the watchlist right now"),
  new SlashCommandBuilder()
    .setName("trade")
    .setDescription("Manually post a trade alert")
    .addStringOption((o) => o.setName("symbol").setDescription("Ticker symbol (e.g. AAPL)").setRequired(true))
    .addNumberOption((o) => o.setName("entry").setDescription("Entry price").setRequired(true))
    .addNumberOption((o) => o.setName("stoploss").setDescription("Stop loss price").setRequired(true))
    .addNumberOption((o) => o.setName("takeprofit").setDescription("Take profit price").setRequired(true))
    .addStringOption((o) =>
      o.setName("direction")
        .setDescription("Long or Short")
        .setRequired(true)
        .addChoices({ name: "Long 📈", value: "LONG" }, { name: "Short 📉", value: "SHORT" })
    )
    .addStringOption((o) => o.setName("notes").setDescription("Optional trade notes")),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ─── Yahoo Finance helpers ────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=60d`;
  const { data } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const result = data.chart.result[0];
  const closes = result.indicators.quote[0].close.filter(Boolean);
  const volumes = result.indicators.quote[0].volume.filter(Boolean);
  const meta = result.meta;
  return {
    symbol,
    price: meta.regularMarketPrice,
    prevClose: meta.previousClose || closes[closes.length - 2],
    closes,
    volumes,
  };
}

// Simple Moving Average
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Relative Strength Index (14-period)
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Average True Range (simplified, 14-period)
function atr(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    sum += Math.abs(slice[i] - slice[i - 1]);
  }
  return sum / period;
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function detectSignal(quote) {
  const { closes, volumes, price } = quote;
  const rsiVal = rsi(closes);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const atrVal = atr(closes);
  const prevMA20 = sma(closes.slice(0, -1), 20);
  const prevMA50 = sma(closes.slice(0, -1), 50);
  const avgVol = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const latestVol = volumes[volumes.length - 1];
  const volSurge = latestVol > avgVol * 1.5;

  if (!rsiVal || !ma20 || !ma50 || !atrVal) return null;

  const signals = [];

  // RSI oversold bounce
  if (rsiVal < 35 && price > ma20) {
    signals.push({ type: "RSI Oversold Bounce", direction: "LONG", strength: "Medium", reason: `RSI at ${rsiVal.toFixed(1)} — oversold territory with price above MA20` });
  }
  // RSI overbought fade
  if (rsiVal > 70 && price < ma20) {
    signals.push({ type: "RSI Overbought Fade", direction: "SHORT", strength: "Medium", reason: `RSI at ${rsiVal.toFixed(1)} — overbought with price below MA20` });
  }
  // Golden cross
  if (prevMA20 && prevMA50 && prevMA20 < prevMA50 && ma20 > ma50) {
    signals.push({ type: "Golden Cross", direction: "LONG", strength: "Strong", reason: `MA20 just crossed above MA50 — bullish momentum shift` });
  }
  // Death cross
  if (prevMA20 && prevMA50 && prevMA20 > prevMA50 && ma20 < ma50) {
    signals.push({ type: "Death Cross", direction: "SHORT", strength: "Strong", reason: `MA20 just crossed below MA50 — bearish momentum shift` });
  }
  // Volume surge breakout above MA20
  if (volSurge && price > ma20 * 1.01 && rsiVal > 50) {
    signals.push({ type: "Volume Breakout", direction: "LONG", strength: "Strong", reason: `Volume 50%+ above average with price breaking above MA20` });
  }
  // MA20 support bounce
  if (price > ma20 * 0.99 && price < ma20 * 1.005 && rsiVal > 40 && rsiVal < 55) {
    signals.push({ type: "MA20 Support Bounce", direction: "LONG", strength: "Low", reason: `Price testing MA20 support zone with neutral RSI` });
  }

  if (signals.length === 0) return null;

  // Pick strongest signal
  const priority = { Strong: 3, Medium: 2, Low: 1 };
  const best = signals.sort((a, b) => priority[b.strength] - priority[a.strength])[0];

  // Calculate levels using ATR
  const multiplier = best.direction === "LONG" ? 1 : -1;
  const entry = price;
  const stopLoss = parseFloat((entry - multiplier * atrVal * 1.5).toFixed(2));
  const takeProfit = parseFloat((entry + multiplier * atrVal * 3).toFixed(2));
  const riskReward = (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2);

  return {
    ...best,
    entry: parseFloat(entry.toFixed(2)),
    stopLoss,
    takeProfit,
    riskReward,
    rsi: rsiVal.toFixed(1),
    ma20: ma20.toFixed(2),
    ma50: ma50.toFixed(2),
    atr: atrVal.toFixed(2),
  };
}

// ─── Embed builders ────────────────────────────────────────────────────────────
function buildSignalEmbed(symbol, signal, source = "Technical Scan") {
  const isLong = signal.direction === "LONG";
  const color = isLong ? 0x00e676 : 0xff1744;
  const arrow = isLong ? "📈" : "📉";
  const strengthEmoji = { Strong: "🔥", Medium: "⚡", Low: "💡" }[signal.strength] || "•";

  const rr = parseFloat(signal.riskReward);
  const rrBar = rr >= 3 ? "🟩🟩🟩🟩🟩" : rr >= 2 ? "🟩🟩🟩🟩⬜" : rr >= 1.5 ? "🟩🟩🟩⬜⬜" : "🟩🟩⬜⬜⬜";

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${symbol}  —  ${signal.type}`)
    .setDescription(`> ${signal.reason}`)
    .addFields(
      { name: "Direction", value: `\`${signal.direction}\``, inline: true },
      { name: "Strength", value: `${strengthEmoji} ${signal.strength}`, inline: true },
      { name: "Source", value: `\`${source}\``, inline: true },
      { name: "─────────────────────", value: "**Trade Levels**" },
      { name: "🎯  Entry", value: `\`$${signal.entry}\``, inline: true },
      { name: "🛑  Stop Loss", value: `\`$${signal.stopLoss}\``, inline: true },
      { name: "💰  Take Profit", value: `\`$${signal.takeProfit}\``, inline: true },
      { name: "⚖️  Risk/Reward", value: `${rrBar}  \`${signal.riskReward}:1\``, inline: false },
      { name: "─────────────────────", value: "**Indicators**" },
      { name: "RSI (14)", value: `\`${signal.rsi}\``, inline: true },
      { name: "MA20", value: `\`$${signal.ma20}\``, inline: true },
      { name: "MA50", value: `\`$${signal.ma50}\``, inline: true }
    )
    .setFooter({ text: `Signal generated • ATR: $${signal.atr}` })
    .setTimestamp();
}

function buildManualEmbed(symbol, direction, entry, stopLoss, takeProfit, notes) {
  const isLong = direction === "LONG";
  const color = isLong ? 0x00e676 : 0xff1744;
  const arrow = isLong ? "📈" : "📉";
  const risk = Math.abs(entry - stopLoss).toFixed(2);
  const reward = Math.abs(takeProfit - entry).toFixed(2);
  const rr = (reward / risk).toFixed(2);
  const riskPct = ((Math.abs(entry - stopLoss) / entry) * 100).toFixed(2);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${symbol.toUpperCase()}  —  Manual Trade Alert`)
    .addFields(
      { name: "Direction", value: `\`${direction}\``, inline: true },
      { name: "Risk %", value: `\`${riskPct}%\``, inline: true },
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "─────────────────────", value: "**Trade Levels**" },
      { name: "🎯  Entry", value: `\`$${entry}\``, inline: true },
      { name: "🛑  Stop Loss", value: `\`$${stopLoss}\``, inline: true },
      { name: "💰  Take Profit", value: `\`$${takeProfit}\``, inline: true },
      { name: "⚖️  Risk/Reward", value: `\`${rr}:1\`  ($${risk} risk → $${reward} reward)`, inline: false },
      ...(notes ? [{ name: "📝  Notes", value: notes }] : [])
    )
    .setFooter({ text: "Manual alert" })
    .setTimestamp();
}

function buildWebhookEmbed(data) {
  const { symbol, direction = "LONG", entry, stop_loss, take_profit, signal_type = "Webhook Signal", notes } = data;
  const isLong = direction.toUpperCase() !== "SHORT";
  const color = isLong ? 0x00e676 : 0xff1744;
  const arrow = isLong ? "📈" : "📉";
  const risk = Math.abs(entry - stop_loss).toFixed(2);
  const reward = Math.abs(take_profit - entry).toFixed(2);
  const rr = (reward / risk).toFixed(2);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${String(symbol).toUpperCase()}  —  ${signal_type}`)
    .addFields(
      { name: "Direction", value: `\`${direction.toUpperCase()}\``, inline: true },
      { name: "Source", value: "`Webhook`", inline: true },
      { name: "─────────────────────", value: "**Trade Levels**" },
      { name: "🎯  Entry", value: `\`$${entry}\``, inline: true },
      { name: "🛑  Stop Loss", value: `\`$${stop_loss}\``, inline: true },
      { name: "💰  Take Profit", value: `\`$${take_profit}\``, inline: true },
      { name: "⚖️  Risk/Reward", value: `\`${rr}:1\``, inline: false },
      ...(notes ? [{ name: "📝  Notes", value: notes }] : [])
    )
    .setFooter({ text: "Via webhook" })
    .setTimestamp();
}

// ─── Scanner ──────────────────────────────────────────────────────────────────
async function runScan(channel) {
  const header = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("🔍  Market Scan Running...")
    .setDescription(`Scanning **${WATCHLIST.length}** symbols for technical setups...`)
    .setTimestamp();

  const statusMsg = await channel.send({ embeds: [header] });
  const found = [];

  for (const symbol of WATCHLIST) {
    try {
      const quote = await fetchQuote(symbol);
      const signal = detectSignal(quote);
      if (signal) found.push({ symbol, signal });
      await new Promise((r) => setTimeout(r, 400)); // rate limit buffer
    } catch (e) {
      console.error(`Error scanning ${symbol}:`, e.message);
    }
  }

  if (found.length === 0) {
    await statusMsg.edit({
      embeds: [
        new EmbedBuilder()
          .setColor(0x607d8b)
          .setTitle("🔍  Scan Complete — No Signals")
          .setDescription("No high-confidence setups found right now. Market conditions may be neutral.")
          .setTimestamp(),
      ],
    });
    return;
  }

  await statusMsg.edit({
    embeds: [
      new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle(`✅  Scan Complete — ${found.length} Signal${found.length > 1 ? "s" : ""} Found`)
        .setTimestamp(),
    ],
  });

  for (const { symbol, signal } of found) {
    const embed = buildSignalEmbed(symbol, signal, "Technical Scan");
    await channel.send({ embeds: [embed] });
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ─── Slash command handler ────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channel = interaction.channel;

  if (interaction.commandName === "scan") {
    await interaction.reply({ content: "🔍 Starting scan...", ephemeral: true });
    await runScan(channel);
  }

  if (interaction.commandName === "trade") {
    const symbol = interaction.options.getString("symbol");
    const entry = interaction.options.getNumber("entry");
    const stopLoss = interaction.options.getNumber("stoploss");
    const takeProfit = interaction.options.getNumber("takeprofit");
    const direction = interaction.options.getString("direction");
    const notes = interaction.options.getString("notes");

    const embed = buildManualEmbed(symbol, direction, entry, stopLoss, takeProfit, notes);
    await interaction.reply({ embeds: [embed] });
  }
});

// ─── Webhook server ───────────────────────────────────────────────────────────
function startWebhookServer() {
  const app = express();
  app.use(express.json());

  app.post("/trade", async (req, res) => {
    const secret = req.headers["x-webhook-secret"];
    if (secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized — wrong secret" });
    }

    const { symbol, entry, stop_loss, take_profit } = req.body;
    if (!symbol || !entry || !stop_loss || !take_profit) {
      return res.status(400).json({ error: "Missing required fields: symbol, entry, stop_loss, take_profit" });
    }

    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      const embed = buildWebhookEmbed(req.body);
      await channel.send({ embeds: [embed] });
      res.json({ success: true, message: `Trade alert for ${symbol} posted` });
    } catch (err) {
      console.error("Webhook error:", err);
      res.status(500).json({ error: "Failed to post alert" });
    }
  });

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook server running on port ${WEBHOOK_PORT}`);
  });
}

// ─── Scheduled scan (weekdays at 9:35 AM ET) ──────────────────────────────────
function scheduleDailyScan() {
  // 9:35 AM Eastern = 14:35 UTC (EST) / 13:35 UTC (EDT)
  cron.schedule("35 14 * * 1-5", async () => {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      await runScan(channel);
    } catch (err) {
      console.error("Scheduled scan error:", err);
    }
  }, { timezone: "America/New_York" });

  console.log("📅 Daily scan scheduled for 9:35 AM ET (weekdays)");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  startWebhookServer();
  scheduleDailyScan();
});

registerCommands();
client.login(DISCORD_TOKEN);
