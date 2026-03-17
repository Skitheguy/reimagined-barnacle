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
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const CLIENT_ID       = process.env.CLIENT_ID;
const CHANNEL_ID      = process.env.CHANNEL_ID;
const WEBHOOK_PORT    = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "changeme";
const ACCOUNT_SIZE    = parseFloat(process.env.ACCOUNT_SIZE || "10000");
const RISK_PER_TRADE  = parseFloat(process.env.RISK_PER_TRADE || "1"); // % of account

// ─── Persistent storage (JSON file) ──────────────────────────────────────────
const DB_PATH = "./data.json";
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { watchlist: defaultWatchlist(), trades: [], pnl: [] };
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return { watchlist: defaultWatchlist(), trades: [], pnl: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function defaultWatchlist() {
  return ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","SPY","QQQ","AMD","NFLX","COST","AVGO","ORCL","CRM"];
}

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Slash commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("scan")
    .setDescription("Run a technical scan on the watchlist right now"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show last scan time, open trades, and today's P&L"),

  new SlashCommandBuilder()
    .setName("trade")
    .setDescription("Manually post a trade alert")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker (e.g. AAPL)").setRequired(true))
    .addNumberOption(o => o.setName("entry").setDescription("Entry price").setRequired(true))
    .addNumberOption(o => o.setName("stoploss").setDescription("Stop loss").setRequired(true))
    .addNumberOption(o => o.setName("takeprofit").setDescription("Take profit").setRequired(true))
    .addStringOption(o => o.setName("direction").setDescription("Long or Short").setRequired(true)
      .addChoices({ name: "Long 📈", value: "LONG" }, { name: "Short 📉", value: "SHORT" }))
    .addStringOption(o => o.setName("notes").setDescription("Optional notes")),

  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close an open trade and record P&L")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker of the trade to close").setRequired(true))
    .addNumberOption(o => o.setName("price").setDescription("Price you closed at").setRequired(true))
    .addStringOption(o => o.setName("result").setDescription("Outcome").setRequired(true)
      .addChoices(
        { name: "Hit Take Profit ✅", value: "TP" },
        { name: "Hit Stop Loss ❌",   value: "SL" },
        { name: "Closed Manually",    value: "MANUAL" }
      )),

  new SlashCommandBuilder()
    .setName("watchlist")
    .setDescription("Manage your watchlist")
    .addSubcommand(sub => sub.setName("show").setDescription("Show current watchlist"))
    .addSubcommand(sub => sub.setName("add")
      .setDescription("Add a ticker")
      .addStringOption(o => o.setName("symbol").setDescription("Ticker to add").setRequired(true)))
    .addSubcommand(sub => sub.setName("remove")
      .setDescription("Remove a ticker")
      .addStringOption(o => o.setName("symbol").setDescription("Ticker to remove").setRequired(true)))
    .addSubcommand(sub => sub.setName("reset").setDescription("Reset to default watchlist")),

  new SlashCommandBuilder()
    .setName("pnl")
    .setDescription("Show P&L summary")
    .addStringOption(o => o.setName("period").setDescription("Time period")
      .addChoices(
        { name: "Today",      value: "today" },
        { name: "This Week",  value: "week"  },
        { name: "This Month", value: "month" },
        { name: "All Time",   value: "all"   }
      )),

  new SlashCommandBuilder()
    .setName("size")
    .setDescription("Calculate position size for a trade")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true))
    .addNumberOption(o => o.setName("entry").setDescription("Entry price").setRequired(true))
    .addNumberOption(o => o.setName("stoploss").setDescription("Stop loss price").setRequired(true))
    .addNumberOption(o => o.setName("risk").setDescription("Risk % of account (default from env)")),

].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands registered");
  } catch (err) { console.error("Failed to register commands:", err); }
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d`;
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const result  = data.chart.result[0];
  const q       = result.indicators.quote[0];
  const closes  = q.close.filter(Boolean);
  const highs   = q.high.filter(Boolean);
  const lows    = q.low.filter(Boolean);
  const volumes = q.volume.filter(Boolean);
  const meta    = result.meta;
  const prevClose = meta.previousClose || closes[closes.length - 2];
  return {
    symbol,
    price:     meta.regularMarketPrice,
    prevClose,
    change:    meta.regularMarketPrice - prevClose,
    changePct: ((meta.regularMarketPrice - prevClose) / prevClose) * 100,
    closes, highs, lows, volumes,
  };
}

// ─── Technical indicators ─────────────────────────────────────────────────────
function sma(arr, period) {
  if (arr.length < period) return null;
  const s = arr.slice(-period);
  return s.reduce((a, b) => a + b, 0) / period;
}

function ema(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
  return val;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function macdIndicator(closes) {
  if (closes.length < 35) return null;
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  if (!fast || !slow) return null;
  const macdLine = fast - slow;
  const prevFast = ema(closes.slice(0, -1), 12);
  const prevSlow = ema(closes.slice(0, -1), 26);
  const prevMacd = prevFast && prevSlow ? prevFast - prevSlow : null;
  return { macdLine, prevMacd };
}

function bollingerBands(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}

function atrCalc(closes, highs, lows, period = 14) {
  const len = Math.min(closes.length, highs.length, lows.length);
  if (len < period + 1) {
    const slice = closes.slice(-(period + 1));
    let sum = 0;
    for (let i = 1; i < slice.length; i++) sum += Math.abs(slice[i] - slice[i - 1]);
    return sum / period;
  }
  let sum = 0;
  for (let i = len - period; i < len; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  return sum / period;
}

function vwapCalc(closes, volumes, lookback = 20) {
  const len = Math.min(closes.length, volumes.length, lookback);
  let cumPV = 0, cumV = 0;
  for (let i = closes.length - len; i < closes.length; i++) {
    cumPV += closes[i] * volumes[i];
    cumV  += volumes[i];
  }
  return cumV > 0 ? cumPV / cumV : null;
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function detectSignal(quote) {
  const { closes, highs, lows, volumes, price } = quote;
  const rsiVal   = rsi(closes);
  const ma20     = sma(closes, 20);
  const ma50     = sma(closes, 50);
  const ma200    = sma(closes, 200);
  const bb       = bollingerBands(closes);
  const atrVal   = atrCalc(closes, highs, lows);
  const vwapVal  = vwapCalc(closes, volumes);
  const macdData = macdIndicator(closes);
  const prevMA20 = sma(closes.slice(0, -1), 20);
  const prevMA50 = sma(closes.slice(0, -1), 50);
  const avgVol   = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volSurge = volumes[volumes.length - 1] > avgVol * 1.5;
  const bullTrend = ma200 && price > ma200;
  const bearTrend = ma200 && price < ma200;

  if (!rsiVal || !ma20 || !ma50 || !atrVal) return null;

  const signals = [];

  // RSI oversold
  if (rsiVal < 33)
    signals.push({ type: "RSI Oversold Bounce", direction: "LONG", strength: bullTrend ? "Strong" : "Medium",
      reason: `RSI at ${rsiVal.toFixed(1)} — deeply oversold${bullTrend ? ", long-term uptrend intact" : ""}` });

  // RSI overbought
  if (rsiVal > 72)
    signals.push({ type: "RSI Overbought Fade", direction: "SHORT", strength: bearTrend ? "Strong" : "Medium",
      reason: `RSI at ${rsiVal.toFixed(1)} — overbought${bearTrend ? ", in long-term downtrend" : ""}` });

  // Golden cross
  if (prevMA20 && prevMA50 && prevMA20 < prevMA50 && ma20 > ma50)
    signals.push({ type: "Golden Cross", direction: "LONG", strength: "Strong",
      reason: "MA20 crossed above MA50 — classic bullish momentum shift" });

  // Death cross
  if (prevMA20 && prevMA50 && prevMA20 > prevMA50 && ma20 < ma50)
    signals.push({ type: "Death Cross", direction: "SHORT", strength: "Strong",
      reason: "MA20 crossed below MA50 — bearish trend confirmation" });

  // MACD crossover
  if (macdData?.prevMacd && macdData.macdLine > 0 && macdData.prevMacd < 0)
    signals.push({ type: "MACD Bullish Cross", direction: "LONG", strength: "Medium",
      reason: "MACD crossed above zero — bullish momentum building" });
  if (macdData?.prevMacd && macdData.macdLine < 0 && macdData.prevMacd > 0)
    signals.push({ type: "MACD Bearish Cross", direction: "SHORT", strength: "Medium",
      reason: "MACD crossed below zero — bearish momentum building" });

  // Bollinger bands
  if (bb && price > bb.upper && volSurge && rsiVal > 55)
    signals.push({ type: "BB Breakout", direction: "LONG", strength: "Strong",
      reason: `Price broke above Bollinger upper band ($${bb.upper.toFixed(2)}) with volume surge` });
  if (bb && price < bb.lower && rsiVal < 40 && bullTrend)
    signals.push({ type: "BB Lower Bounce", direction: "LONG", strength: "Medium",
      reason: `Price touched Bollinger lower band ($${bb.lower.toFixed(2)}) in an uptrend — mean reversion` });

  // Volume breakout
  if (volSurge && price > ma20 * 1.01 && rsiVal > 50)
    signals.push({ type: "Volume Breakout", direction: "LONG", strength: "Strong",
      reason: "Volume 50%+ above 10-day average with price clearing MA20" });

  // VWAP reclaim
  if (vwapVal && price > vwapVal * 1.002 && price < vwapVal * 1.01 && rsiVal > 45 && rsiVal < 60)
    signals.push({ type: "VWAP Reclaim", direction: "LONG", strength: "Low",
      reason: `Price reclaiming 20-day VWAP ($${vwapVal.toFixed(2)}) — institutional support zone` });

  if (signals.length === 0) return null;

  const priority = { Strong: 3, Medium: 2, Low: 1 };
  const best = [...signals].sort((a, b) => priority[b.strength] - priority[a.strength])[0];

  const mult      = best.direction === "LONG" ? 1 : -1;
  const entry     = parseFloat(price.toFixed(2));
  const stopLoss  = parseFloat((entry - mult * atrVal * 1.5).toFixed(2));
  const takeProfit = parseFloat((entry + mult * atrVal * 3).toFixed(2));
  const riskReward = (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2);

  // Confidence score
  const base      = { Strong: 40, Medium: 25, Low: 10 }[best.strength];
  const confidence = Math.min(
    base +
    ((best.direction === "LONG" && bullTrend) || (best.direction === "SHORT" && bearTrend) ? 20 : 0) +
    (volSurge ? 15 : 0) +
    ((best.direction === "LONG" && rsiVal < 50) || (best.direction === "SHORT" && rsiVal > 50) ? 15 : 0) +
    Math.min((signals.length - 1) * 10, 20),
    95
  );

  return {
    ...best, entry, stopLoss, takeProfit, riskReward, confidence,
    rsi:        rsiVal.toFixed(1),
    ma20:       ma20.toFixed(2),
    ma50:       ma50.toFixed(2),
    ma200:      ma200 ? ma200.toFixed(2) : "N/A",
    atr:        atrVal.toFixed(2),
    bb:         bb ? { upper: bb.upper.toFixed(2), lower: bb.lower.toFixed(2) } : null,
    vwap:       vwapVal ? vwapVal.toFixed(2) : null,
    macd:       macdData ? macdData.macdLine.toFixed(4) : null,
    allSignals: signals.map(s => s.type),
    trend:      bullTrend ? "Bullish" : bearTrend ? "Bearish" : "Neutral",
  };
}

// ─── Position sizing ──────────────────────────────────────────────────────────
function calcPositionSize(entry, stopLoss, riskPct = RISK_PER_TRADE, accountSize = ACCOUNT_SIZE) {
  const riskAmount   = accountSize * (riskPct / 100);
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare === 0) return { shares: 0, totalCost: 0, maxLoss: 0, riskAmount, riskPct };
  const shares    = Math.floor(riskAmount / riskPerShare);
  const totalCost = shares * entry;
  const maxLoss   = shares * riskPerShare;
  return { shares, totalCost, maxLoss, riskAmount, riskPct };
}

// ─── Embed builders ───────────────────────────────────────────────────────────
function confidenceBar(score) {
  const filled = Math.round(score / 10);
  const color  = score >= 70 ? "🟩" : score >= 45 ? "🟨" : "🟥";
  return color.repeat(filled) + "⬜".repeat(10 - filled) + `  \`${score}%\``;
}

function buildSignalEmbed(symbol, signal, source = "Technical Scan") {
  const isLong        = signal.direction === "LONG";
  const color         = isLong ? 0x00e676 : 0xff1744;
  const arrow         = isLong ? "📈" : "📉";
  const strengthEmoji = { Strong: "🔥", Medium: "⚡", Low: "💡" }[signal.strength] || "•";
  const trendEmoji    = signal.trend === "Bullish" ? "🐂" : signal.trend === "Bearish" ? "🐻" : "➖";
  const sz            = calcPositionSize(signal.entry, signal.stopLoss);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${symbol}  —  ${signal.type}`)
    .setDescription(`> ${signal.reason}`)
    .addFields(
      { name: "Direction",  value: `\`${signal.direction}\``,   inline: true },
      { name: "Strength",   value: `${strengthEmoji} ${signal.strength}`, inline: true },
      { name: "Trend",      value: `${trendEmoji} ${signal.trend}`, inline: true },
      { name: "Confidence", value: confidenceBar(signal.confidence), inline: false },
      { name: "─────────────────────", value: "**📐 Trade Levels**" },
      { name: "🎯  Entry",        value: `\`$${signal.entry}\``,      inline: true },
      { name: "🛑  Stop Loss",    value: `\`$${signal.stopLoss}\``,   inline: true },
      { name: "💰  Take Profit",  value: `\`$${signal.takeProfit}\``, inline: true },
      { name: "⚖️  Risk/Reward",  value: `\`${signal.riskReward}:1\``, inline: true },
      { name: "📦  Suggested Size", value: `\`${sz.shares} shares\` (~$${sz.totalCost.toLocaleString()})`, inline: true },
      { name: "💸  Max Risk",     value: `\`$${sz.maxLoss.toFixed(2)}\` (${sz.riskPct}%)`, inline: true },
      { name: "─────────────────────", value: "**📊 Indicators**" },
      { name: "RSI (14)", value: `\`${signal.rsi}\``,   inline: true },
      { name: "MA20",     value: `\`$${signal.ma20}\``, inline: true },
      { name: "MA50",     value: `\`$${signal.ma50}\``, inline: true },
      { name: "MA200",    value: `\`$${signal.ma200}\``, inline: true },
      { name: "VWAP",     value: signal.vwap ? `\`$${signal.vwap}\`` : "`N/A`", inline: true },
      { name: "MACD",     value: signal.macd ? `\`${signal.macd}\`` : "`N/A`", inline: true },
      ...(signal.bb ? [
        { name: "BB Upper", value: `\`$${signal.bb.upper}\``, inline: true },
        { name: "BB Lower", value: `\`$${signal.bb.lower}\``, inline: true },
      ] : []),
      ...(signal.allSignals.length > 1 ? [
        { name: "📋  All Signals", value: signal.allSignals.map(s => `\`${s}\``).join("  "), inline: false }
      ] : [])
    )
    .setFooter({ text: `Source: ${source} • ATR: $${signal.atr}` })
    .setTimestamp();
}

function buildManualEmbed(symbol, direction, entry, stopLoss, takeProfit, notes) {
  const isLong  = direction === "LONG";
  const color   = isLong ? 0x00e676 : 0xff1744;
  const arrow   = isLong ? "📈" : "📉";
  const risk    = Math.abs(entry - stopLoss).toFixed(2);
  const reward  = Math.abs(takeProfit - entry).toFixed(2);
  const rr      = (reward / risk).toFixed(2);
  const riskPct = ((Math.abs(entry - stopLoss) / entry) * 100).toFixed(2);
  const sz      = calcPositionSize(entry, stopLoss);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${symbol.toUpperCase()}  —  Manual Trade Alert`)
    .addFields(
      { name: "Direction", value: `\`${direction}\``, inline: true },
      { name: "Risk %",    value: `\`${riskPct}%\``,  inline: true },
      { name: "\u200B",    value: "\u200B",            inline: true },
      { name: "─────────────────────", value: "**📐 Trade Levels**" },
      { name: "🎯  Entry",        value: `\`$${entry}\``,      inline: true },
      { name: "🛑  Stop Loss",    value: `\`$${stopLoss}\``,   inline: true },
      { name: "💰  Take Profit",  value: `\`$${takeProfit}\``, inline: true },
      { name: "⚖️  Risk/Reward",  value: `\`${rr}:1\`  ($${risk} risk → $${reward} reward)`, inline: false },
      { name: "📦  Suggested Size", value: `\`${sz.shares} shares\` (~$${sz.totalCost.toLocaleString()})`, inline: false },
      ...(notes ? [{ name: "📝  Notes", value: notes }] : [])
    )
    .setFooter({ text: "Manual alert" })
    .setTimestamp();
}

function buildWebhookEmbed(data) {
  const { symbol, direction = "LONG", entry, stop_loss, take_profit, signal_type = "Webhook Signal", notes } = data;
  const isLong = direction.toUpperCase() !== "SHORT";
  const color  = isLong ? 0x00e676 : 0xff1744;
  const arrow  = isLong ? "📈" : "📉";
  const risk   = Math.abs(entry - stop_loss).toFixed(2);
  const reward = Math.abs(take_profit - entry).toFixed(2);
  const rr     = (reward / risk).toFixed(2);
  const sz     = calcPositionSize(entry, stop_loss);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${arrow}  ${String(symbol).toUpperCase()}  —  ${signal_type}`)
    .addFields(
      { name: "Direction",  value: `\`${direction.toUpperCase()}\``, inline: true },
      { name: "Source",     value: "`Webhook`", inline: true },
      { name: "─────────────────────", value: "**📐 Trade Levels**" },
      { name: "🎯  Entry",        value: `\`$${entry}\``,       inline: true },
      { name: "🛑  Stop Loss",    value: `\`$${stop_loss}\``,   inline: true },
      { name: "💰  Take Profit",  value: `\`$${take_profit}\``, inline: true },
      { name: "⚖️  Risk/Reward",  value: `\`${rr}:1\``,         inline: true },
      { name: "📦  Suggested Size", value: `\`${sz.shares} shares\` (~$${sz.totalCost.toLocaleString()})`, inline: true },
      ...(notes ? [{ name: "📝  Notes", value: notes }] : [])
    )
    .setFooter({ text: "Via webhook" })
    .setTimestamp();
}

// ─── Scanner ──────────────────────────────────────────────────────────────────
let lastScanTime = null;

async function runScan(channel) {
  const db = loadDB();
  const statusMsg = await channel.send({ embeds: [
    new EmbedBuilder().setColor(0x2b2d31)
      .setTitle("🔍  Market Scan Running...")
      .setDescription(`Scanning **${db.watchlist.length}** symbols...`)
      .setTimestamp()
  ]});

  const found = [];
  for (const symbol of db.watchlist) {
    try {
      const quote  = await fetchQuote(symbol);
      const signal = detectSignal(quote);
      if (signal) found.push({ symbol, signal });
      await sleep(400);
    } catch (e) { console.error(`Error scanning ${symbol}:`, e.message); }
  }
  lastScanTime = new Date();

  if (found.length === 0) {
    return statusMsg.edit({ embeds: [
      new EmbedBuilder().setColor(0x607d8b)
        .setTitle("🔍  Scan Complete — No Signals")
        .setDescription("No high-confidence setups found right now.")
        .setTimestamp()
    ]});
  }

  found.sort((a, b) => b.signal.confidence - a.signal.confidence);

  await statusMsg.edit({ embeds: [
    new EmbedBuilder().setColor(0x00e676)
      .setTitle(`✅  Scan Complete — ${found.length} Signal${found.length > 1 ? "s" : ""} Found`)
      .setDescription(found.map(f => `**${f.symbol}** — ${f.signal.type} (${f.signal.confidence}% confidence)`).join("\n"))
      .setTimestamp()
  ]});

  for (const { symbol, signal } of found) {
    if (!db.trades.find(t => t.symbol === symbol && t.status === "open")) {
      db.trades.push({
        id: Date.now(), symbol, direction: signal.direction,
        entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
        riskReward: signal.riskReward, confidence: signal.confidence,
        openedAt: new Date().toISOString(), status: "open", source: "scan",
      });
    }
    await channel.send({ embeds: [buildSignalEmbed(symbol, signal, "Technical Scan")] });
    await sleep(300);
  }
  saveDB(db);
}

// ─── Pre-market summary ────────────────────────────────────────────────────────
async function sendPremarketSummary(channel) {
  try {
    const db = loadDB();
    const [spyQ, qqqQ] = await Promise.all([fetchQuote("SPY"), fetchQuote("QQQ")]);

    // Top movers
    const quotes  = [];
    for (const sym of db.watchlist.slice(0, 10)) {
      try { quotes.push(await fetchQuote(sym)); await sleep(400); } catch {}
    }
    const movers = [...quotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);

    const avgChange  = (spyQ.changePct + qqqQ.changePct) / 2;
    const marketMood = avgChange > 0.5 ? "🟢 Bullish Open" : avgChange < -0.5 ? "🔴 Bearish Open" : "🟡 Neutral Open";
    const openTrades = db.trades.filter(t => t.status === "open");

    await channel.send({ embeds: [
      new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("🌅  Pre-Market Summary")
        .setDescription(`**Market Mood:** ${marketMood}\n*${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}*`)
        .addFields(
          { name: "─────────────────────", value: "**📊 Indexes**" },
          { name: `${spyQ.changePct >= 0 ? "📈" : "📉"} SPY`, value: `\`$${spyQ.price.toFixed(2)}\`  ${spyQ.changePct >= 0 ? "+" : ""}${spyQ.changePct.toFixed(2)}%`, inline: true },
          { name: `${qqqQ.changePct >= 0 ? "📈" : "📉"} QQQ`, value: `\`$${qqqQ.price.toFixed(2)}\`  ${qqqQ.changePct >= 0 ? "+" : ""}${qqqQ.changePct.toFixed(2)}%`, inline: true },
          { name: "─────────────────────", value: "**🚀 Top Movers (Watchlist)**" },
          ...movers.map(q => ({
            name: q.symbol,
            value: `\`$${q.price.toFixed(2)}\`  ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%  ${q.changePct >= 0 ? "📈" : "📉"}`,
            inline: true,
          })),
          { name: "─────────────────────", value: "**📋 Open Trades**" },
          {
            name: openTrades.length > 0 ? `${openTrades.length} Open` : "None",
            value: openTrades.length > 0
              ? openTrades.map(t => `\`${t.symbol}\` ${t.direction} @ $${t.entry}  SL $${t.stopLoss}  TP $${t.takeProfit}`).join("\n")
              : "No open trades. Scan fires at 9:35 AM ET.",
          }
        )
        .setFooter({ text: "Scan fires at 9:35 AM ET • Close summary at 4:05 PM ET" })
        .setTimestamp()
    ]});
  } catch (err) { console.error("Pre-market summary error:", err.message); }
}

// ─── Market close summary ──────────────────────────────────────────────────────
async function sendCloseSummary(channel) {
  const db      = loadDB();
  const today   = new Date().toDateString();
  const todayPnl = db.pnl.filter(p => new Date(p.closedAt).toDateString() === today);

  if (todayPnl.length === 0) {
    return channel.send({ embeds: [
      new EmbedBuilder().setColor(0x607d8b)
        .setTitle("📊  Market Close")
        .setDescription("No trades were closed today. Use `/close` to log results.")
        .setTimestamp()
    ]});
  }

  const total   = todayPnl.reduce((a, b) => a + b.pnl, 0);
  const wins    = todayPnl.filter(p => p.pnl > 0).length;
  const losses  = todayPnl.filter(p => p.pnl <= 0).length;
  const winRate = ((wins / todayPnl.length) * 100).toFixed(0);

  await channel.send({ embeds: [
    new EmbedBuilder()
      .setColor(total >= 0 ? 0x00e676 : 0xff1744)
      .setTitle(`📊  Market Close Summary  ${total >= 0 ? "🟢" : "🔴"}`)
      .addFields(
        { name: "Total P&L",  value: `\`${total >= 0 ? "+" : ""}$${total.toFixed(2)}\``, inline: true },
        { name: "Win Rate",   value: `\`${winRate}%\` (${wins}W / ${losses}L)`, inline: true },
        { name: "# Trades",   value: `\`${todayPnl.length}\``, inline: true },
        { name: "─────────────────────", value: "**Trade Results**" },
        ...todayPnl.map(p => ({
          name:  `${p.pnl >= 0 ? "✅" : "❌"} ${p.symbol}`,
          value: `${p.direction} • ${p.result} • \`${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}\``,
          inline: true,
        }))
      )
      .setTimestamp()
  ]});
}

// ─── Slash command handler ────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channel = interaction.channel;
  const db      = loadDB();

  if (interaction.commandName === "scan") {
    await interaction.reply({ content: "🔍 Starting scan...", ephemeral: true });
    await runScan(channel);
  }

  else if (interaction.commandName === "status") {
    const openTrades = db.trades.filter(t => t.status === "open");
    const today      = new Date().toDateString();
    const todayTotal = db.pnl.filter(p => new Date(p.closedAt).toDateString() === today).reduce((a, b) => a + b.pnl, 0);

    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle("📡  Bot Status")
        .addFields(
          { name: "Last Scan",    value: lastScanTime ? `<t:${Math.floor(lastScanTime / 1000)}:R>` : "`Never`", inline: true },
          { name: "Watchlist",    value: `\`${db.watchlist.length} symbols\``, inline: true },
          { name: "Today's P&L", value: `\`${todayTotal >= 0 ? "+" : ""}$${todayTotal.toFixed(2)}\``, inline: true },
          {
            name:  `Open Trades (${openTrades.length})`,
            value: openTrades.length > 0
              ? openTrades.map(t => `\`${t.symbol}\` ${t.direction} @ $${t.entry}  →  SL $${t.stopLoss} / TP $${t.takeProfit}`).join("\n")
              : "None",
          }
        ).setTimestamp()
    ]});
  }

  else if (interaction.commandName === "trade") {
    const symbol     = interaction.options.getString("symbol").toUpperCase();
    const entry      = interaction.options.getNumber("entry");
    const stopLoss   = interaction.options.getNumber("stoploss");
    const takeProfit = interaction.options.getNumber("takeprofit");
    const direction  = interaction.options.getString("direction");
    const notes      = interaction.options.getString("notes");

    db.trades.push({ id: Date.now(), symbol, direction, entry, stopLoss, takeProfit,
      openedAt: new Date().toISOString(), status: "open", source: "manual" });
    saveDB(db);
    await interaction.reply({ embeds: [buildManualEmbed(symbol, direction, entry, stopLoss, takeProfit, notes)] });
  }

  else if (interaction.commandName === "close") {
    const symbol     = interaction.options.getString("symbol").toUpperCase();
    const closePrice = interaction.options.getNumber("price");
    const result     = interaction.options.getString("result");
    const trade      = db.trades.find(t => t.symbol === symbol && t.status === "open");

    if (!trade) return interaction.reply({ content: `❌ No open trade for \`${symbol}\`. Check \`/status\`.`, ephemeral: true });

    const sz   = calcPositionSize(trade.entry, trade.stopLoss);
    const mult = trade.direction === "LONG" ? 1 : -1;
    const pnl  = mult * (closePrice - trade.entry) * sz.shares;
    const pnlPct = (mult * (closePrice - trade.entry) / trade.entry * 100).toFixed(2);

    Object.assign(trade, { status: "closed", closePrice, closedAt: new Date().toISOString(), result, pnl });
    db.pnl.push({ symbol, direction: trade.direction, entry: trade.entry, closePrice, result, pnl, pnlPct, shares: sz.shares, closedAt: trade.closedAt });
    saveDB(db);

    const label = result === "TP" ? "Take Profit Hit" : result === "SL" ? "Stop Loss Hit" : "Manually Closed";
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(pnl >= 0 ? 0x00e676 : 0xff1744)
        .setTitle(`${result === "TP" ? "✅" : result === "SL" ? "❌" : "🔒"}  ${symbol}  —  Trade Closed`)
        .addFields(
          { name: "Result",    value: label,                  inline: true },
          { name: "Direction", value: `\`${trade.direction}\``, inline: true },
          { name: "Shares",    value: `\`${sz.shares}\``,       inline: true },
          { name: "Entry",     value: `\`$${trade.entry}\``,    inline: true },
          { name: "Exit",      value: `\`$${closePrice}\``,     inline: true },
          { name: "P&L",       value: `\`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\` (${pnlPct}%)`, inline: true },
        ).setTimestamp()
    ]});
  }

  else if (interaction.commandName === "watchlist") {
    const sub = interaction.options.getSubcommand();
    if (sub === "show") {
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x5865f2).setTitle("📋  Watchlist")
          .setDescription(db.watchlist.map(s => `\`${s}\``).join("  "))
          .setFooter({ text: `${db.watchlist.length} symbols  •  /watchlist add or remove to edit` })
          .setTimestamp()
      ]});
    }
    if (sub === "add") {
      const sym = interaction.options.getString("symbol").toUpperCase();
      if (db.watchlist.includes(sym)) return interaction.reply({ content: `\`${sym}\` is already on the watchlist.`, ephemeral: true });
      db.watchlist.push(sym); saveDB(db);
      return interaction.reply({ content: `✅  \`${sym}\` added. Watchlist now has **${db.watchlist.length}** symbols.` });
    }
    if (sub === "remove") {
      const sym = interaction.options.getString("symbol").toUpperCase();
      if (!db.watchlist.includes(sym)) return interaction.reply({ content: `\`${sym}\` is not on the watchlist.`, ephemeral: true });
      db.watchlist = db.watchlist.filter(s => s !== sym); saveDB(db);
      return interaction.reply({ content: `✅  \`${sym}\` removed. Watchlist now has **${db.watchlist.length}** symbols.` });
    }
    if (sub === "reset") {
      db.watchlist = defaultWatchlist(); saveDB(db);
      return interaction.reply({ content: `✅  Watchlist reset to default (${db.watchlist.length} symbols).` });
    }
  }

  else if (interaction.commandName === "pnl") {
    const period  = interaction.options.getString("period") || "all";
    const labels  = { today: "Today", week: "This Week", month: "This Month", all: "All Time" };
    const now     = new Date();
    const records = db.pnl.filter(p => {
      const d = new Date(p.closedAt);
      if (period === "today") return d.toDateString() === now.toDateString();
      if (period === "week")  return d >= new Date(now - 7 * 86400000);
      if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      return true;
    });

    if (records.length === 0) return interaction.reply({ content: `No closed trades for **${labels[period]}**.`, ephemeral: true });

    const total    = records.reduce((a, b) => a + b.pnl, 0);
    const wins     = records.filter(r => r.pnl > 0);
    const losses   = records.filter(r => r.pnl <= 0);
    const winRate  = ((wins.length / records.length) * 100).toFixed(0);
    const avgWin   = wins.length > 0 ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
    const avgLoss  = losses.length > 0 ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0;
    const expectancy = ((avgWin * wins.length + avgLoss * losses.length) / records.length).toFixed(2);
    const best     = [...records].sort((a, b) => b.pnl - a.pnl)[0];
    const worst    = [...records].sort((a, b) => a.pnl - b.pnl)[0];

    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(total >= 0 ? 0x00e676 : 0xff1744).setTitle(`📊  P&L — ${labels[period]}`)
        .addFields(
          { name: "Total P&L",   value: `\`${total >= 0 ? "+" : ""}$${total.toFixed(2)}\``,    inline: true },
          { name: "Win Rate",    value: `\`${winRate}%\` (${wins.length}W / ${losses.length}L)`, inline: true },
          { name: "# Trades",   value: `\`${records.length}\``,                                 inline: true },
          { name: "Avg Win",    value: `\`+$${avgWin.toFixed(2)}\``,                            inline: true },
          { name: "Avg Loss",   value: `\`-$${Math.abs(avgLoss).toFixed(2)}\``,                  inline: true },
          { name: "Expectancy", value: `\`$${expectancy}\` per trade`,                          inline: true },
          { name: "Best Trade",  value: best  ? `\`${best.symbol}\` +$${best.pnl.toFixed(2)}`   : "N/A", inline: true },
          { name: "Worst Trade", value: worst ? `\`${worst.symbol}\` $${worst.pnl.toFixed(2)}`  : "N/A", inline: true },
        ).setTimestamp()
    ]});
  }

  else if (interaction.commandName === "size") {
    const symbol   = interaction.options.getString("symbol").toUpperCase();
    const entry    = interaction.options.getNumber("entry");
    const stopLoss = interaction.options.getNumber("stoploss");
    const riskPct  = interaction.options.getNumber("risk") || RISK_PER_TRADE;
    const sz       = calcPositionSize(entry, stopLoss, riskPct);

    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle(`📦  Position Size — ${symbol}`)
        .addFields(
          { name: "Account Size",  value: `\`$${ACCOUNT_SIZE.toLocaleString()}\``, inline: true },
          { name: "Risk %",        value: `\`${riskPct}%\``,                       inline: true },
          { name: "Risk Amount",   value: `\`$${sz.riskAmount.toFixed(2)}\``,      inline: true },
          { name: "Entry",         value: `\`$${entry}\``,                         inline: true },
          { name: "Stop Loss",     value: `\`$${stopLoss}\``,                      inline: true },
          { name: "Risk/Share",    value: `\`$${Math.abs(entry - stopLoss).toFixed(2)}\``, inline: true },
          { name: "✅  Shares",    value: `\`${sz.shares}\``,                      inline: true },
          { name: "💵  Total Cost", value: `\`$${sz.totalCost.toLocaleString()}\``, inline: true },
          { name: "💸  Max Loss",  value: `\`$${sz.maxLoss.toFixed(2)}\``,         inline: true },
        ).setTimestamp()
    ]});
  }
});

// ─── Webhook server ───────────────────────────────────────────────────────────
function startWebhookServer() {
  const app = express();
  app.use(express.json());

  app.post("/trade", async (req, res) => {
    if (req.headers["x-webhook-secret"] !== WEBHOOK_SECRET)
      return res.status(401).json({ error: "Unauthorized" });
    const { symbol, entry, stop_loss, take_profit } = req.body;
    if (!symbol || !entry || !stop_loss || !take_profit)
      return res.status(400).json({ error: "Missing: symbol, entry, stop_loss, take_profit" });
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      await channel.send({ embeds: [buildWebhookEmbed(req.body)] });
      const db = loadDB();
      db.trades.push({ id: Date.now(), symbol: symbol.toUpperCase(),
        direction: (req.body.direction || "LONG").toUpperCase(),
        entry, stopLoss: stop_loss, takeProfit: take_profit,
        openedAt: new Date().toISOString(), status: "open", source: "webhook" });
      saveDB(db);
      res.json({ success: true });
    } catch (err) { console.error("Webhook error:", err); res.status(500).json({ error: "Failed" }); }
  });

  app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
  app.listen(WEBHOOK_PORT, () => console.log(`🌐 Webhook server on port ${WEBHOOK_PORT}`));
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────────
function scheduleJobs() {
  cron.schedule("0 9 * * 1-5",  async () => { try { await sendPremarketSummary(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  cron.schedule("35 9 * * 1-5", async () => { try { await runScan(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  cron.schedule("5 16 * * 1-5", async () => { try { await sendCloseSummary(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  console.log("📅 Scheduled: pre-market 9:00 AM, scan 9:35 AM, close summary 4:05 PM (ET)");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Boot ─────────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  startWebhookServer();
  scheduleJobs();
});

registerCommands();
client.login(DISCORD_TOKEN);
