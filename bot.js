require("dotenv").config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  REST, Routes, SlashCommandBuilder,
} = require("discord.js");
const axios  = require("axios");
const express = require("express");
const cron   = require("node-cron");
const fs     = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN  = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const CHANNEL_ID     = process.env.CHANNEL_ID;
const WEBHOOK_PORT   = process.env.WEBHOOK_PORT  || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme";
const ACCOUNT_SIZE   = parseFloat(process.env.ACCOUNT_SIZE  || "10000");
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE || "1");
const ALPACA_KEY     = process.env.ALPACA_API_KEY;
const ALPACA_SECRET  = process.env.ALPACA_SECRET_KEY;
const PAPER_TRADING  = process.env.PAPER_TRADING !== "false";
const ALPACA_BASE    = PAPER_TRADING ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";

// ─── Persistent storage ───────────────────────────────────────────────────────
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Alpaca ───────────────────────────────────────────────────────────────────
const alpacaHeaders = () => ({
  "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET, "Content-Type": "application/json",
});
async function alpacaGet(path)       { const { data } = await axios.get(`${ALPACA_BASE}${path}`, { headers: alpacaHeaders() }); return data; }
async function alpacaPost(path, body){ const { data } = await axios.post(`${ALPACA_BASE}${path}`, body, { headers: alpacaHeaders() }); return data; }
async function alpacaDelete(path)    { const { data } = await axios.delete(`${ALPACA_BASE}${path}`, { headers: alpacaHeaders() }); return data; }
async function getAccount()          { return alpacaGet("/v2/account"); }
async function getPositions()        { return alpacaGet("/v2/positions"); }
async function getOrders(s="open")   { return alpacaGet(`/v2/orders?status=${s}&limit=20`); }
async function closePosition(symbol) { return alpacaDelete(`/v2/positions/${symbol.toUpperCase()}`); }
async function cancelOrder(id)       { return alpacaDelete(`/v2/orders/${id}`); }
async function placeOrder({ symbol, qty, side, stopLoss, takeProfit }) {
  return alpacaPost("/v2/orders", {
    symbol: symbol.toUpperCase(), qty: String(qty), side,
    type: "market", time_in_force: "day", order_class: "bracket",
    stop_loss:   { stop_price:  String(stopLoss.toFixed(2))   },
    take_profit: { limit_price: String(takeProfit.toFixed(2)) },
  });
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=200d`;
  const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const result = data.chart.result[0];
  const q = result.indicators.quote[0];
  const closes  = q.close.filter(Boolean);
  const highs   = q.high.filter(Boolean);
  const lows    = q.low.filter(Boolean);
  const volumes = q.volume.filter(Boolean);
  const meta    = result.meta;
  const prevClose = meta.previousClose || closes[closes.length - 2];
  return {
    symbol, price: meta.regularMarketPrice, prevClose,
    change: meta.regularMarketPrice - prevClose,
    changePct: ((meta.regularMarketPrice - prevClose) / prevClose) * 100,
    closes, highs, lows, volumes,
  };
}

// ─── News & Sentiment ─────────────────────────────────────────────────────────

// Fetch recent news headlines for a stock via Yahoo Finance RSS
async function fetchStockNews(symbol, maxItems = 4) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${symbol}&region=US&lang=en-US`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
    const items = [];
    const regex = /<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/g;
    let match;
    while ((match = regex.exec(data)) !== null && items.length < maxItems) {
      items.push({ title: match[1].trim(), link: match[2].trim(), date: new Date(match[3]).toLocaleDateString() });
    }
    return items;
  } catch { return []; }
}

// Fetch Fear & Greed Index from CNN (via alternative.me crypto API as proxy, then CNN)
async function fetchFearAndGreed() {
  try {
    // Try alternative.me (crypto F&G, decent proxy for market sentiment)
    const { data } = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 5000 });
    const val   = parseInt(data.data[0].value);
    const label = data.data[0].value_classification;
    const emoji = val <= 25 ? "😱" : val <= 45 ? "😟" : val <= 55 ? "😐" : val <= 75 ? "😊" : "🤑";
    const color = val <= 25 ? "Extreme Fear" : val <= 45 ? "Fear" : val <= 55 ? "Neutral" : val <= 75 ? "Greed" : "Extreme Greed";
    return { value: val, label: color, emoji };
  } catch { return null; }
}

// Fetch upcoming earnings for a symbol from Yahoo Finance summary
async function fetchEarningsDate(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents`;
    const { data } = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
    const events = data.quoteSummary?.result?.[0]?.calendarEvents;
    if (!events?.earnings?.earningsDate?.length) return null;
    const nextEarnings = new Date(events.earnings.earningsDate[0].raw * 1000);
    const daysUntil    = Math.ceil((nextEarnings - new Date()) / (1000 * 60 * 60 * 24));
    return { date: nextEarnings.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), daysUntil };
  } catch { return null; }
}

// Check if earnings within N days — used as trade filter
async function isEarningsRisk(symbol, withinDays = 5) {
  const earnings = await fetchEarningsDate(symbol);
  if (!earnings) return { risky: false, earnings: null };
  return { risky: earnings.daysUntil <= withinDays && earnings.daysUntil >= 0, earnings };
}

// Fetch economic calendar events for the week (using a free public API)
async function fetchEconomicCalendar() {
  try {
    // Use tradingeconomics calendar via a known public endpoint
    const now   = new Date();
    const start = now.toISOString().split("T")[0];
    const end   = new Date(now.getTime() + 7 * 86400000).toISOString().split("T")[0];
    // Fallback: hardcode well-known recurring events as a static weekly guide
    // since most economic calendar APIs require keys
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const events = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      const day = d.getDay();
      const dateStr = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      // Fed typically meets 8x/year — flag Tuesdays/Wednesdays in meeting weeks
      if (day === 3) events.push({ date: dateStr, event: "Watch for Fed speakers / Mid-week vol", impact: "Medium" });
      if (day === 5) events.push({ date: dateStr, event: "Weekly options expiry (OpEx)", impact: "Medium" });
    }
    return events;
  } catch { return []; }
}

// Fetch actual upcoming economic events from a public RSS/JSON source
async function fetchRealEconomicEvents() {
  try {
    const { data } = await axios.get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { timeout: 5000 });
    const highImpact = data
      .filter(e => e.impact === "High" && e.country === "USD")
      .slice(0, 6)
      .map(e => ({
        date: e.date,
        event: e.title,
        forecast: e.forecast || "—",
        previous: e.previous || "—",
        impact: "🔴 High",
      }));
    return highImpact;
  } catch {
    return [];
  }
}

// ─── Technical indicators ─────────────────────────────────────────────────────
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
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
  for (let i = closes.length - len; i < closes.length; i++) { cumPV += closes[i] * volumes[i]; cumV += volumes[i]; }
  return cumV > 0 ? cumPV / cumV : null;
}
function macdIndicator(closes) {
  if (closes.length < 35) return null;
  const fast = ema(closes, 12), slow = ema(closes, 26);
  if (!fast || !slow) return null;
  const prevFast = ema(closes.slice(0, -1), 12), prevSlow = ema(closes.slice(0, -1), 26);
  return { macdLine: fast - slow, prevMacd: prevFast && prevSlow ? prevFast - prevSlow : null };
}

// ─── Signal detection ─────────────────────────────────────────────────────────
function detectSignal(quote) {
  const { closes, highs, lows, volumes, price } = quote;
  const rsiVal    = rsi(closes);
  const ma20      = sma(closes, 20);
  const ma50      = sma(closes, 50);
  const ma200     = sma(closes, 200);
  const bb        = bollingerBands(closes);
  const atrVal    = atrCalc(closes, highs, lows);
  const vwapVal   = vwapCalc(closes, volumes);
  const macdData  = macdIndicator(closes);
  const prevMA20  = sma(closes.slice(0, -1), 20);
  const prevMA50  = sma(closes.slice(0, -1), 50);
  const avgVol    = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volSurge  = volumes[volumes.length - 1] > avgVol * 1.5;
  const bullTrend = ma200 && price > ma200;
  const bearTrend = ma200 && price < ma200;

  if (!rsiVal || !ma20 || !ma50 || !atrVal) return null;
  const signals = [];

  if (rsiVal < 33) signals.push({ type: "RSI Oversold Bounce", direction: "LONG",  strength: bullTrend ? "Strong" : "Medium", reason: `RSI at ${rsiVal.toFixed(1)} — deeply oversold${bullTrend ? ", uptrend intact" : ""}` });
  if (rsiVal > 72) signals.push({ type: "RSI Overbought Fade", direction: "SHORT", strength: bearTrend ? "Strong" : "Medium", reason: `RSI at ${rsiVal.toFixed(1)} — overbought${bearTrend ? ", in downtrend" : ""}` });
  if (prevMA20 && prevMA50 && prevMA20 < prevMA50 && ma20 > ma50) signals.push({ type: "Golden Cross",     direction: "LONG",  strength: "Strong", reason: "MA20 crossed above MA50" });
  if (prevMA20 && prevMA50 && prevMA20 > prevMA50 && ma20 < ma50) signals.push({ type: "Death Cross",      direction: "SHORT", strength: "Strong", reason: "MA20 crossed below MA50" });
  if (macdData?.prevMacd && macdData.macdLine > 0 && macdData.prevMacd < 0) signals.push({ type: "MACD Bullish Cross", direction: "LONG",  strength: "Medium", reason: "MACD crossed above zero" });
  if (macdData?.prevMacd && macdData.macdLine < 0 && macdData.prevMacd > 0) signals.push({ type: "MACD Bearish Cross", direction: "SHORT", strength: "Medium", reason: "MACD crossed below zero" });
  if (bb && price > bb.upper && volSurge && rsiVal > 55) signals.push({ type: "BB Breakout",    direction: "LONG",  strength: "Strong", reason: `Price broke above BB upper ($${bb.upper.toFixed(2)}) with volume` });
  if (bb && price < bb.lower && rsiVal < 40 && bullTrend) signals.push({ type: "BB Lower Bounce", direction: "LONG", strength: "Medium", reason: `Price touched BB lower ($${bb.lower.toFixed(2)}) in uptrend` });
  if (volSurge && price > ma20 * 1.01 && rsiVal > 50) signals.push({ type: "Volume Breakout", direction: "LONG", strength: "Strong", reason: "Volume 50%+ above avg with price clearing MA20" });
  if (vwapVal && price > vwapVal * 1.002 && price < vwapVal * 1.01 && rsiVal > 45 && rsiVal < 60) signals.push({ type: "VWAP Reclaim", direction: "LONG", strength: "Low", reason: `Reclaiming VWAP ($${vwapVal.toFixed(2)})` });

  if (signals.length === 0) return null;
  const priority = { Strong: 3, Medium: 2, Low: 1 };
  const best = [...signals].sort((a, b) => priority[b.strength] - priority[a.strength])[0];
  const mult = best.direction === "LONG" ? 1 : -1;
  const entry      = parseFloat(price.toFixed(2));
  const stopLoss   = parseFloat((entry - mult * atrVal * 1.5).toFixed(2));
  const takeProfit = parseFloat((entry + mult * atrVal * 3).toFixed(2));
  const riskReward = (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2);
  const confidence = Math.min(
    { Strong: 40, Medium: 25, Low: 10 }[best.strength] +
    ((best.direction === "LONG" && bullTrend) || (best.direction === "SHORT" && bearTrend) ? 20 : 0) +
    (volSurge ? 15 : 0) +
    ((best.direction === "LONG" && rsiVal < 50) || (best.direction === "SHORT" && rsiVal > 50) ? 15 : 0) +
    Math.min((signals.length - 1) * 10, 20), 95
  );
  return {
    ...best, entry, stopLoss, takeProfit, riskReward, confidence,
    rsi: rsiVal.toFixed(1), ma20: ma20.toFixed(2), ma50: ma50.toFixed(2),
    ma200: ma200 ? ma200.toFixed(2) : "N/A", atr: atrVal.toFixed(2),
    bb: bb ? { upper: bb.upper.toFixed(2), lower: bb.lower.toFixed(2) } : null,
    vwap: vwapVal ? vwapVal.toFixed(2) : null,
    macd: macdData ? macdData.macdLine.toFixed(4) : null,
    allSignals: signals.map(s => s.type),
    trend: bullTrend ? "Bullish" : bearTrend ? "Bearish" : "Neutral",
  };
}

// ─── Position sizing ──────────────────────────────────────────────────────────
function calcPositionSize(entry, stopLoss, riskPct = RISK_PER_TRADE, accountSize = ACCOUNT_SIZE) {
  const riskAmount   = accountSize * (riskPct / 100);
  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare === 0) return { shares: 0, totalCost: 0, maxLoss: 0, riskAmount, riskPct };
  const shares = Math.floor(riskAmount / riskPerShare);
  return { shares, totalCost: shares * entry, maxLoss: shares * riskPerShare, riskAmount, riskPct };
}

// ─── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── Slash commands ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("scan").setDescription("Run a technical scan on the watchlist"),
  new SlashCommandBuilder().setName("status").setDescription("Show open trades and today's P&L"),
  new SlashCommandBuilder().setName("news").setDescription("Get latest news for a stock")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true)),
  new SlashCommandBuilder().setName("earnings").setDescription("Check upcoming earnings for a stock")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true)),
  new SlashCommandBuilder().setName("calendar").setDescription("Show this week's economic events"),
  new SlashCommandBuilder().setName("sentiment").setDescription("Show Fear & Greed index and market sentiment"),
  new SlashCommandBuilder()
    .setName("trade").setDescription("Manually post a trade alert")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true))
    .addNumberOption(o => o.setName("entry").setDescription("Entry price").setRequired(true))
    .addNumberOption(o => o.setName("stoploss").setDescription("Stop loss").setRequired(true))
    .addNumberOption(o => o.setName("takeprofit").setDescription("Take profit").setRequired(true))
    .addStringOption(o => o.setName("direction").setDescription("Long or Short").setRequired(true)
      .addChoices({ name: "Long 📈", value: "LONG" }, { name: "Short 📉", value: "SHORT" }))
    .addBooleanOption(o => o.setName("autoplace").setDescription("Auto-place on Alpaca?"))
    .addStringOption(o => o.setName("notes").setDescription("Optional notes")),
  new SlashCommandBuilder()
    .setName("close").setDescription("Close an open Alpaca position")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker to close").setRequired(true)),
  new SlashCommandBuilder().setName("orders").setDescription("Show open Alpaca orders and positions"),
  new SlashCommandBuilder()
    .setName("cancelorder").setDescription("Cancel an open Alpaca order")
    .addStringOption(o => o.setName("orderid").setDescription("Order ID").setRequired(true)),
  new SlashCommandBuilder().setName("account").setDescription("Show Alpaca account balance"),
  new SlashCommandBuilder()
    .setName("watchlist").setDescription("Manage your watchlist")
    .addSubcommand(s => s.setName("show").setDescription("Show watchlist"))
    .addSubcommand(s => s.setName("add").setDescription("Add a ticker")
      .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true)))
    .addSubcommand(s => s.setName("remove").setDescription("Remove a ticker")
      .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true)))
    .addSubcommand(s => s.setName("reset").setDescription("Reset to default")),
  new SlashCommandBuilder()
    .setName("pnl").setDescription("Show P&L summary")
    .addStringOption(o => o.setName("period").setDescription("Period")
      .addChoices(
        { name: "Today", value: "today" }, { name: "This Week", value: "week" },
        { name: "This Month", value: "month" }, { name: "All Time", value: "all" }
      )),
  new SlashCommandBuilder()
    .setName("size").setDescription("Calculate position size")
    .addStringOption(o => o.setName("symbol").setDescription("Ticker").setRequired(true))
    .addNumberOption(o => o.setName("entry").setDescription("Entry price").setRequired(true))
    .addNumberOption(o => o.setName("stoploss").setDescription("Stop loss").setRequired(true))
    .addNumberOption(o => o.setName("risk").setDescription("Risk % override")),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands }); console.log("✅ Commands registered"); }
  catch (err) { console.error("Failed to register commands:", err); }
}

// ─── Embed helpers ────────────────────────────────────────────────────────────
function confidenceBar(score) {
  const filled = Math.round(score / 10);
  const color  = score >= 70 ? "🟩" : score >= 45 ? "🟨" : "🟥";
  return color.repeat(filled) + "⬜".repeat(10 - filled) + `  \`${score}%\``;
}

function earningsWarning(earningsInfo) {
  if (!earningsInfo) return null;
  const { daysUntil, date } = earningsInfo;
  if (daysUntil <= 1) return `⚠️ **EARNINGS TOMORROW** (${date}) — HIGH RISK`;
  if (daysUntil <= 3) return `⚠️ Earnings in ${daysUntil} days (${date}) — proceed with caution`;
  if (daysUntil <= 5) return `📅 Earnings in ${daysUntil} days (${date})`;
  return null;
}

// ─── Signal embed (with news + earnings) ─────────────────────────────────────
async function buildSignalEmbedFull(symbol, signal, source, earningsInfo, newsItems) {
  const isLong        = signal.direction === "LONG";
  const color         = isLong ? 0x00e676 : 0xff1744;
  const arrow         = isLong ? "📈" : "📉";
  const strengthEmoji = { Strong: "🔥", Medium: "⚡", Low: "💡" }[signal.strength] || "•";
  const trendEmoji    = signal.trend === "Bullish" ? "🐂" : signal.trend === "Bearish" ? "🐻" : "➖";
  const sz            = calcPositionSize(signal.entry, signal.stopLoss);
  const warning       = earningsWarning(earningsInfo);

  const fields = [
    { name: "Direction",  value: `\`${signal.direction}\``,            inline: true },
    { name: "Strength",   value: `${strengthEmoji} ${signal.strength}`, inline: true },
    { name: "Trend",      value: `${trendEmoji} ${signal.trend}`,       inline: true },
    { name: "Confidence", value: confidenceBar(signal.confidence),      inline: false },
  ];

  // Earnings warning — show prominently if risky
  if (warning) fields.push({ name: "📅  Earnings", value: warning, inline: false });

  fields.push(
    { name: "─────────────────────", value: "**📐 Trade Levels**" },
    { name: "🎯  Entry",        value: `\`$${signal.entry}\``,      inline: true },
    { name: "🛑  Stop Loss",    value: `\`$${signal.stopLoss}\``,   inline: true },
    { name: "💰  Take Profit",  value: `\`$${signal.takeProfit}\``, inline: true },
    { name: "⚖️  Risk/Reward",  value: `\`${signal.riskReward}:1\``, inline: true },
    { name: "📦  Suggested Size", value: `\`${sz.shares} shares\` (~$${sz.totalCost.toLocaleString()})`, inline: true },
    { name: "💸  Max Risk",     value: `\`$${sz.maxLoss.toFixed(2)}\``, inline: true },
    { name: "─────────────────────", value: "**📊 Indicators**" },
    { name: "RSI (14)", value: `\`${signal.rsi}\``,    inline: true },
    { name: "MA20",     value: `\`$${signal.ma20}\``,  inline: true },
    { name: "MA50",     value: `\`$${signal.ma50}\``,  inline: true },
    { name: "MA200",    value: `\`$${signal.ma200}\``, inline: true },
    { name: "VWAP",     value: signal.vwap ? `\`$${signal.vwap}\`` : "`N/A`", inline: true },
    { name: "MACD",     value: signal.macd ? `\`${signal.macd}\`` : "`N/A`", inline: true },
  );

  if (signal.bb) {
    fields.push(
      { name: "BB Upper", value: `\`$${signal.bb.upper}\``, inline: true },
      { name: "BB Lower", value: `\`$${signal.bb.lower}\``, inline: true },
    );
  }

  if (signal.allSignals.length > 1)
    fields.push({ name: "📋  All Signals", value: signal.allSignals.map(s => `\`${s}\``).join("  "), inline: false });

  // News section
  if (newsItems?.length > 0) {
    fields.push({ name: "─────────────────────", value: "**📰 Latest News**" });
    fields.push({
      name: "\u200B",
      value: newsItems.map(n => `• [${n.title}](${n.link}) — *${n.date}*`).join("\n"),
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setColor(earningsInfo?.daysUntil <= 3 ? 0xffa500 : color)
    .setTitle(`${arrow}  ${symbol}  —  ${signal.type}`)
    .setDescription(`> ${signal.reason}`)
    .addFields(fields)
    .setFooter({ text: `Source: ${source} • ATR: $${signal.atr} • ${PAPER_TRADING ? "Paper Mode" : "⚠️ LIVE"}` })
    .setTimestamp();
}

// ─── Trade execution embed ────────────────────────────────────────────────────
function buildTradeEmbed(symbol, direction, entry, stopLoss, takeProfit, sz, source, order, errorMsg, mode) {
  const isLong = direction === "LONG";
  const rr     = (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2);
  const fields = [
    { name: "Direction", value: `\`${direction}\``,       inline: true },
    { name: "Mode",      value: `\`${mode || "Manual"}\``, inline: true },
    { name: "Source",    value: `\`${source}\``,           inline: true },
    { name: "─────────────────────", value: "**📐 Trade Levels**" },
    { name: "🎯  Entry",       value: `\`$${entry}\``,       inline: true },
    { name: "🛑  Stop Loss",   value: `\`$${stopLoss}\``,    inline: true },
    { name: "💰  Take Profit", value: `\`$${takeProfit}\``,  inline: true },
    { name: "⚖️  R/R",        value: `\`${rr}:1\``,          inline: true },
    { name: "📦  Shares",      value: `\`${sz.shares}\``,    inline: true },
    { name: "💸  Max Risk",    value: `\`$${sz.maxLoss.toFixed(2)}\``, inline: true },
  ];
  if (order) {
    fields.push({ name: "─────────────────────", value: "**✅ Alpaca Order Placed**" });
    fields.push({ name: "Order ID",  value: `\`${order.id}\``,     inline: true });
    fields.push({ name: "Status",    value: `\`${order.status}\``, inline: true });
    fields.push({ name: "Filled At", value: order.filled_avg_price ? `\`$${order.filled_avg_price}\`` : "`Pending`", inline: true });
  } else if (errorMsg) {
    fields.push({ name: "⚠️  Note", value: `\`${errorMsg}\``, inline: false });
  }
  return new EmbedBuilder()
    .setColor(isLong ? 0x00e676 : 0xff1744)
    .setTitle(`${isLong ? "📈" : "📉"}  ${symbol.toUpperCase()}  —  Trade Alert`)
    .addFields(fields)
    .setFooter({ text: `${PAPER_TRADING ? "Paper Trading" : "⚠️ LIVE Trading"} • ${new Date().toLocaleTimeString()}` })
    .setTimestamp();
}

// ─── Execute trade (Discord + Alpaca) ────────────────────────────────────────
async function executeTrade({ symbol, direction, entry, stopLoss, takeProfit, source }) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const sz      = calcPositionSize(entry, stopLoss);
  const side    = direction === "LONG" ? "buy" : "sell";
  const mode    = PAPER_TRADING ? "📄 Paper" : "🔴 LIVE";
  let order = null, orderError = null;

  if (ALPACA_KEY && ALPACA_SECRET && sz.shares > 0) {
    try { order = await placeOrder({ symbol, qty: sz.shares, side, stopLoss, takeProfit }); }
    catch (err) { orderError = err?.response?.data?.message || err.message; console.error("Alpaca error:", orderError); }
  } else if (!ALPACA_KEY) {
    orderError = "No Alpaca keys configured";
  } else if (sz.shares === 0) {
    orderError = "Position size = 0 shares (check account size / risk settings)";
  }

  const embed = buildTradeEmbed(symbol, direction, entry, stopLoss, takeProfit, sz, source, order, orderError, mode);
  await channel.send({ embeds: [embed] });

  if (order) {
    const db = loadDB();
    db.trades.push({ id: order.id, symbol, direction, entry, stopLoss, takeProfit, shares: sz.shares, openedAt: new Date().toISOString(), status: "open", source, alpacaOrderId: order.id });
    saveDB(db);
  }
}

// ─── Scanner ──────────────────────────────────────────────────────────────────
let lastScanTime = null;

async function runScan(channel) {
  const db = loadDB();
  const statusMsg = await channel.send({ embeds: [
    new EmbedBuilder().setColor(0x2b2d31).setTitle("🔍  Market Scan Running...")
      .setDescription(`Scanning **${db.watchlist.length}** symbols for technical setups + checking earnings risk...`).setTimestamp()
  ]});

  const found = [], skipped = [];

  for (const symbol of db.watchlist) {
    try {
      const quote  = await fetchQuote(symbol);
      const signal = detectSignal(quote);
      if (!signal) { await sleep(400); continue; }

      // Earnings risk check
      const { risky, earnings } = await isEarningsRisk(symbol, 5);
      if (risky) {
        skipped.push({ symbol, earnings });
        await sleep(400);
        continue;
      }

      // Fetch news
      const news = await fetchStockNews(symbol, 3);
      found.push({ symbol, signal, earnings, news });
      await sleep(400);
    } catch (e) { console.error(`Error scanning ${symbol}:`, e.message); }
  }

  lastScanTime = new Date();

  if (found.length === 0 && skipped.length === 0) {
    return statusMsg.edit({ embeds: [
      new EmbedBuilder().setColor(0x607d8b).setTitle("🔍  Scan Complete — No Signals")
        .setDescription("No high-confidence setups found right now.").setTimestamp()
    ]});
  }

  found.sort((a, b) => b.signal.confidence - a.signal.confidence);

  let summary = found.map(f => `**${f.symbol}** — ${f.signal.type} (${f.signal.confidence}% confidence)`).join("\n");
  if (skipped.length > 0)
    summary += `\n\n⚠️ **Skipped (earnings risk):** ${skipped.map(s => `\`${s.symbol}\` (${s.earnings?.date})`).join(", ")}`;

  await statusMsg.edit({ embeds: [
    new EmbedBuilder().setColor(0x00e676)
      .setTitle(`✅  Scan Complete — ${found.length} Signal${found.length !== 1 ? "s" : ""} Found`)
      .setDescription(summary || "None")
      .setTimestamp()
  ]});

  for (const { symbol, signal, earnings, news } of found) {
    const embed = await buildSignalEmbedFull(symbol, signal, "Technical Scan", earnings, news);
    await channel.send({ embeds: [embed] });
    await sleep(300);
  }
}

// ─── Pre-market summary ────────────────────────────────────────────────────────
async function sendPremarketSummary(channel) {
  try {
    const db = loadDB();
    const [spyQ, qqqQ, fg] = await Promise.all([fetchQuote("SPY"), fetchQuote("QQQ"), fetchFearAndGreed()]);

    // Top movers
    const quotes = [];
    for (const sym of db.watchlist.slice(0, 8)) {
      try { quotes.push(await fetchQuote(sym)); await sleep(300); } catch {}
    }
    const movers    = [...quotes].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
    const avgChange = (spyQ.changePct + qqqQ.changePct) / 2;
    const mood      = avgChange > 0.5 ? "🟢 Bullish Open" : avgChange < -0.5 ? "🔴 Bearish Open" : "🟡 Neutral Open";

    // Earnings this week for watchlist
    const earningsThisWeek = [];
    for (const sym of db.watchlist) {
      try {
        const e = await fetchEarningsDate(sym);
        if (e && e.daysUntil >= 0 && e.daysUntil <= 5) earningsThisWeek.push({ symbol: sym, ...e });
        await sleep(200);
      } catch {}
    }

    // Alpaca positions
    let positionText = "No open positions";
    if (ALPACA_KEY) {
      try {
        const positions = await getPositions();
        if (positions.length > 0)
          positionText = positions.map(p => `\`${p.symbol}\` ${parseFloat(p.qty) > 0 ? "LONG" : "SHORT"} ${Math.abs(p.qty)} @ $${parseFloat(p.avg_entry_price).toFixed(2)}  P&L: ${parseFloat(p.unrealized_pl) >= 0 ? "+" : ""}$${parseFloat(p.unrealized_pl).toFixed(2)}`).join("\n");
      } catch {}
    }

    const fields = [
      { name: "─────────────────────", value: "**📊 Indexes**" },
      { name: `${spyQ.changePct >= 0 ? "📈" : "📉"} SPY`, value: `\`$${spyQ.price.toFixed(2)}\`  ${spyQ.changePct >= 0 ? "+" : ""}${spyQ.changePct.toFixed(2)}%`, inline: true },
      { name: `${qqqQ.changePct >= 0 ? "📈" : "📉"} QQQ`, value: `\`$${qqqQ.price.toFixed(2)}\`  ${qqqQ.changePct >= 0 ? "+" : ""}${qqqQ.changePct.toFixed(2)}%`, inline: true },
    ];

    if (fg) fields.push({ name: `${fg.emoji} Fear & Greed`, value: `\`${fg.value}/100\` — ${fg.label}`, inline: true });

    fields.push(
      { name: "─────────────────────", value: "**🚀 Top Movers (Watchlist)**" },
      ...movers.map(q => ({ name: q.symbol, value: `\`$${q.price.toFixed(2)}\`  ${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%`, inline: true })),
    );

    if (earningsThisWeek.length > 0) {
      fields.push({ name: "─────────────────────", value: "**📅 Earnings This Week (Watchlist)**" });
      fields.push({ name: "\u200B", value: earningsThisWeek.map(e => `\`${e.symbol}\` — ${e.date} (${e.daysUntil === 0 ? "TODAY" : `in ${e.daysUntil}d`})`).join("\n"), inline: false });
    }

    fields.push(
      { name: "─────────────────────", value: "**📋 Alpaca Positions**" },
      { name: "\u200B", value: positionText }
    );

    await channel.send({ embeds: [
      new EmbedBuilder().setColor(0xffd700).setTitle("🌅  Pre-Market Summary")
        .setDescription(`**Market Mood:** ${mood}\n*${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}*`)
        .addFields(fields)
        .setFooter({ text: `${PAPER_TRADING ? "Paper Trading" : "⚠️ LIVE"} • Scan at 9:35 AM ET` })
        .setTimestamp()
    ]});
  } catch (err) { console.error("Pre-market error:", err.message); }
}

// ─── Market close summary ──────────────────────────────────────────────────────
async function sendCloseSummary(channel) {
  const db      = loadDB();
  const today   = new Date().toDateString();
  const todayPnl = db.pnl.filter(p => new Date(p.closedAt).toDateString() === today);
  let alpacaLine = "";
  if (ALPACA_KEY) {
    try {
      const acc  = await getAccount();
      const dayPnl = parseFloat(acc.equity) - parseFloat(acc.last_equity);
      alpacaLine = `\nAlpaca Equity: \`$${parseFloat(acc.equity).toFixed(2)}\`  Day P&L: \`${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}\``;
    } catch {}
  }
  if (todayPnl.length === 0) {
    return channel.send({ embeds: [new EmbedBuilder().setColor(0x607d8b).setTitle("📊  Market Close").setDescription("No closed trades today." + alpacaLine).setTimestamp()] });
  }
  const total   = todayPnl.reduce((a, b) => a + b.pnl, 0);
  const wins    = todayPnl.filter(p => p.pnl > 0).length;
  const losses  = todayPnl.filter(p => p.pnl <= 0).length;
  await channel.send({ embeds: [
    new EmbedBuilder().setColor(total >= 0 ? 0x00e676 : 0xff1744)
      .setTitle(`📊  Market Close  ${total >= 0 ? "🟢" : "🔴"}`)
      .setDescription(alpacaLine || undefined)
      .addFields(
        { name: "Total P&L", value: `\`${total >= 0 ? "+" : ""}$${total.toFixed(2)}\``, inline: true },
        { name: "Win Rate",  value: `\`${((wins / todayPnl.length) * 100).toFixed(0)}%\` (${wins}W / ${losses}L)`, inline: true },
        { name: "# Trades", value: `\`${todayPnl.length}\``, inline: true },
        { name: "─────────────────────", value: "**Results**" },
        ...todayPnl.map(p => ({ name: `${p.pnl >= 0 ? "✅" : "❌"} ${p.symbol}`, value: `${p.direction} • \`${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}\``, inline: true }))
      ).setTimestamp()
  ]});
}

// ─── Monday economic calendar post ────────────────────────────────────────────
async function sendWeeklyCalendar(channel) {
  try {
    const events = await fetchRealEconomicEvents();
    const fallback = await fetchEconomicCalendar();
    const allEvents = events.length > 0 ? events : fallback;

    if (allEvents.length === 0) {
      return channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle("📅  Economic Calendar").setDescription("No major events found this week.").setTimestamp()] });
    }

    const fg = await fetchFearAndGreed();

    const fields = allEvents.map(e => ({
      name:  `${e.impact || "📅"} ${e.event}`,
      value: `${e.date}${e.forecast ? `  Forecast: \`${e.forecast}\`` : ""}${e.previous ? `  Prev: \`${e.previous}\`` : ""}`,
      inline: false,
    }));

    if (fg) fields.unshift({ name: `${fg.emoji} Current Sentiment`, value: `Fear & Greed: \`${fg.value}/100\` — **${fg.label}**`, inline: false });

    await channel.send({ embeds: [
      new EmbedBuilder().setColor(0x5865f2)
        .setTitle("📅  This Week's Economic Events")
        .setDescription("High-impact USD events that could move the market:")
        .addFields(fields)
        .setFooter({ text: "Red events = high volatility risk. Avoid opening trades right before these." })
        .setTimestamp()
    ]});
  } catch (err) { console.error("Calendar error:", err.message); }
}

// ─── Slash command handler ────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const channel = interaction.channel;
  const db = loadDB();

  // /scan
  if (interaction.commandName === "scan") {
    await interaction.reply({ content: "🔍 Starting scan...", ephemeral: true });
    await runScan(channel);
  }

  // /news
  else if (interaction.commandName === "news") {
    const symbol = interaction.options.getString("symbol").toUpperCase();
    await interaction.deferReply();
    const [news, earnings] = await Promise.all([fetchStockNews(symbol, 6), fetchEarningsDate(symbol)]);
    if (news.length === 0) return interaction.editReply({ content: `No recent news found for \`${symbol}\`.` });
    const warning = earningsWarning(earnings);
    const fields = news.map(n => ({ name: n.title, value: `[Read more](${n.link}) — *${n.date}*`, inline: false }));
    if (warning) fields.unshift({ name: "📅  Earnings", value: warning, inline: false });
    await interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle(`📰  Latest News — ${symbol}`)
        .addFields(fields).setTimestamp()
    ]});
  }

  // /earnings
  else if (interaction.commandName === "earnings") {
    const symbol = interaction.options.getString("symbol").toUpperCase();
    await interaction.deferReply();
    const earnings = await fetchEarningsDate(symbol);
    if (!earnings) return interaction.editReply({ content: `No upcoming earnings found for \`${symbol}\`.` });
    const color   = earnings.daysUntil <= 1 ? 0xff1744 : earnings.daysUntil <= 3 ? 0xffa500 : 0x00e676;
    const warning = earningsWarning(earnings);
    await interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(color).setTitle(`📅  Earnings — ${symbol}`)
        .addFields(
          { name: "Earnings Date", value: `\`${earnings.date}\``,          inline: true },
          { name: "Days Until",    value: `\`${earnings.daysUntil} days\``, inline: true },
          { name: "Risk Level",    value: earnings.daysUntil <= 3 ? "`HIGH ⚠️`" : "`LOW ✅`", inline: true },
          ...(warning ? [{ name: "⚠️  Warning", value: warning, inline: false }] : []),
          { name: "Recommendation", value: earnings.daysUntil <= 5 ? "Avoid opening new positions within 5 days of earnings. Wait for the report to drop first." : "Earnings are far enough out — no immediate risk.", inline: false }
        ).setTimestamp()
    ]});
  }

  // /calendar
  else if (interaction.commandName === "calendar") {
    await interaction.deferReply();
    await sendWeeklyCalendar(channel);
    await interaction.editReply({ content: "📅 Calendar posted above.", ephemeral: true });
  }

  // /sentiment
  else if (interaction.commandName === "sentiment") {
    await interaction.deferReply();
    const [fg, spyQ, qqqQ] = await Promise.all([fetchFearAndGreed(), fetchQuote("SPY"), fetchQuote("QQQ")]);
    const fields = [];
    if (fg) {
      const bar = "█".repeat(Math.round(fg.value / 10)) + "░".repeat(10 - Math.round(fg.value / 10));
      fields.push(
        { name: `${fg.emoji}  Fear & Greed Index`, value: `\`${bar}\`  **${fg.value}/100**\n${fg.label}`, inline: false },
        { name: "Interpretation", value:
          fg.value <= 25 ? "Extreme fear — market may be oversold. Historically a buying opportunity." :
          fg.value <= 45 ? "Fear — cautious sentiment. Look for selective longs on strong setups." :
          fg.value <= 55 ? "Neutral — no strong bias. Follow signals closely." :
          fg.value <= 75 ? "Greed — market is optimistic. Be careful chasing breakouts." :
          "Extreme greed — market may be overextended. Tighten stop losses.", inline: false }
      );
    }
    fields.push(
      { name: "─────────────────────", value: "**Index Performance**" },
      { name: `${spyQ.changePct >= 0 ? "📈" : "📉"} SPY`, value: `\`$${spyQ.price.toFixed(2)}\`  ${spyQ.changePct >= 0 ? "+" : ""}${spyQ.changePct.toFixed(2)}%`, inline: true },
      { name: `${qqqQ.changePct >= 0 ? "📈" : "📉"} QQQ`, value: `\`$${qqqQ.price.toFixed(2)}\`  ${qqqQ.changePct >= 0 ? "+" : ""}${qqqQ.changePct.toFixed(2)}%`, inline: true },
    );
    const sentColor = !fg ? 0x607d8b : fg.value <= 25 ? 0xff1744 : fg.value <= 45 ? 0xffa500 : fg.value <= 55 ? 0x607d8b : fg.value <= 75 ? 0x00e676 : 0x00c853;
    await interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(sentColor).setTitle("🧠  Market Sentiment").addFields(fields).setTimestamp()
    ]});
  }

  // /status
  else if (interaction.commandName === "status") {
    const openTrades = db.trades.filter(t => t.status === "open");
    const today      = new Date().toDateString();
    const todayTotal = db.pnl.filter(p => new Date(p.closedAt).toDateString() === today).reduce((a, b) => a + b.pnl, 0);
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle("📡  Bot Status")
        .addFields(
          { name: "Last Scan",    value: lastScanTime ? `<t:${Math.floor(lastScanTime / 1000)}:R>` : "`Never`", inline: true },
          { name: "Today's P&L", value: `\`${todayTotal >= 0 ? "+" : ""}$${todayTotal.toFixed(2)}\``,           inline: true },
          { name: "Mode",         value: `\`${PAPER_TRADING ? "📄 Paper" : "🔴 LIVE"}\``,                      inline: true },
          { name: `Open Trades (${openTrades.length})`, value: openTrades.length > 0
            ? openTrades.map(t => `\`${t.symbol}\` ${t.direction} @ $${t.entry}  SL $${t.stopLoss} / TP $${t.takeProfit}`).join("\n")
            : "None" }
        ).setTimestamp()
    ]});
  }

  // /trade
  else if (interaction.commandName === "trade") {
    const symbol     = interaction.options.getString("symbol").toUpperCase();
    const entry      = interaction.options.getNumber("entry");
    const stopLoss   = interaction.options.getNumber("stoploss");
    const takeProfit = interaction.options.getNumber("takeprofit");
    const direction  = interaction.options.getString("direction");
    const autoplace  = interaction.options.getBoolean("autoplace") ?? true;
    await interaction.reply({ content: autoplace ? "📤 Placing order..." : "📋 Posting alert...", ephemeral: true });
    if (autoplace) {
      await executeTrade({ symbol, direction, entry, stopLoss, takeProfit, source: "Manual" });
    } else {
      const sz = calcPositionSize(entry, stopLoss);
      await channel.send({ embeds: [buildTradeEmbed(symbol, direction, entry, stopLoss, takeProfit, sz, "Manual", null, "Not placed", "Manual")] });
    }
  }

  // /close
  else if (interaction.commandName === "close") {
    const symbol = interaction.options.getString("symbol").toUpperCase();
    await interaction.reply({ content: `🔒 Closing \`${symbol}\`...`, ephemeral: true });
    try {
      const result = await closePosition(symbol);
      await channel.send({ embeds: [
        new EmbedBuilder().setColor(0xffd700).setTitle(`🔒  ${symbol} — Position Closed`)
          .addFields(
            { name: "Symbol", value: `\`${symbol}\``,       inline: true },
            { name: "Qty",    value: `\`${result.qty}\``,   inline: true },
            { name: "Status", value: `\`${result.status}\``, inline: true },
          ).setFooter({ text: PAPER_TRADING ? "Paper Trading" : "⚠️ LIVE" }).setTimestamp()
      ]});
    } catch (err) {
      await channel.send({ content: `❌ Could not close \`${symbol}\`: ${err?.response?.data?.message || err.message}` });
    }
  }

  // /orders
  else if (interaction.commandName === "orders") {
    await interaction.deferReply();
    try {
      const [orders, positions] = await Promise.all([getOrders("open"), getPositions()]);
      await interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0x5865f2).setTitle("📋  Alpaca — Orders & Positions")
          .addFields(
            { name: `Open Orders (${orders.length})`, value: orders.length > 0 ? orders.map(o => `\`${o.symbol}\` ${o.side.toUpperCase()} ${o.qty} — \`${o.id.slice(0,8)}...\``).join("\n") : "None" },
            { name: `Positions (${positions.length})`, value: positions.length > 0 ? positions.map(p => `\`${p.symbol}\` ${parseFloat(p.qty) > 0 ? "LONG" : "SHORT"} ${Math.abs(p.qty)} @ $${parseFloat(p.avg_entry_price).toFixed(2)}  P&L: ${parseFloat(p.unrealized_pl) >= 0 ? "+" : ""}$${parseFloat(p.unrealized_pl).toFixed(2)}`).join("\n") : "None" }
          ).setFooter({ text: PAPER_TRADING ? "Paper Trading" : "⚠️ LIVE" }).setTimestamp()
      ]});
    } catch (err) { await interaction.editReply({ content: `❌ Alpaca error: ${err?.response?.data?.message || err.message}` }); }
  }

  // /cancelorder
  else if (interaction.commandName === "cancelorder") {
    const orderId = interaction.options.getString("orderid");
    await interaction.deferReply();
    try { await cancelOrder(orderId); await interaction.editReply({ content: `✅ Order \`${orderId}\` cancelled.` }); }
    catch (err) { await interaction.editReply({ content: `❌ ${err?.response?.data?.message || err.message}` }); }
  }

  // /account
  else if (interaction.commandName === "account") {
    await interaction.deferReply();
    try {
      const acc    = await getAccount();
      const dayPnl = parseFloat(acc.equity) - parseFloat(acc.last_equity);
      await interaction.editReply({ embeds: [
        new EmbedBuilder().setColor(0xffd700).setTitle(`💼  Alpaca Account  ${PAPER_TRADING ? "(Paper)" : "(LIVE)"}`)
          .addFields(
            { name: "Equity",       value: `\`$${parseFloat(acc.equity).toLocaleString()}\``,       inline: true },
            { name: "Cash",         value: `\`$${parseFloat(acc.cash).toLocaleString()}\``,          inline: true },
            { name: "Buying Power", value: `\`$${parseFloat(acc.buying_power).toLocaleString()}\``, inline: true },
            { name: "Day P&L",      value: `\`${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}\``,   inline: true },
            { name: "Day Trades",   value: `\`${acc.daytrade_count}\``,                             inline: true },
            { name: "Status",       value: `\`${acc.status}\``,                                     inline: true },
          ).setTimestamp()
      ]});
    } catch (err) { await interaction.editReply({ content: `❌ Alpaca error: ${err?.response?.data?.message || err.message}` }); }
  }

  // /watchlist
  else if (interaction.commandName === "watchlist") {
    const sub = interaction.options.getSubcommand();
    if (sub === "show") return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle("📋  Watchlist")
        .setDescription(db.watchlist.map(s => `\`${s}\``).join("  "))
        .setFooter({ text: `${db.watchlist.length} symbols` }).setTimestamp()
    ]});
    if (sub === "add") {
      const sym = interaction.options.getString("symbol").toUpperCase();
      if (db.watchlist.includes(sym)) return interaction.reply({ content: `\`${sym}\` already on watchlist.`, ephemeral: true });
      db.watchlist.push(sym); saveDB(db);
      return interaction.reply({ content: `✅  \`${sym}\` added. **${db.watchlist.length}** symbols total.` });
    }
    if (sub === "remove") {
      const sym = interaction.options.getString("symbol").toUpperCase();
      if (!db.watchlist.includes(sym)) return interaction.reply({ content: `\`${sym}\` not found.`, ephemeral: true });
      db.watchlist = db.watchlist.filter(s => s !== sym); saveDB(db);
      return interaction.reply({ content: `✅  \`${sym}\` removed. **${db.watchlist.length}** symbols total.` });
    }
    if (sub === "reset") { db.watchlist = defaultWatchlist(); saveDB(db); return interaction.reply({ content: `✅  Reset to default (${db.watchlist.length} symbols).` }); }
  }

  // /pnl
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
    const total   = records.reduce((a, b) => a + b.pnl, 0);
    const wins    = records.filter(r => r.pnl > 0);
    const losses  = records.filter(r => r.pnl <= 0);
    const avgWin  = wins.length > 0   ? wins.reduce((a, b)   => a + b.pnl, 0) / wins.length   : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0;
    const best    = [...records].sort((a, b) => b.pnl - a.pnl)[0];
    const worst   = [...records].sort((a, b) => a.pnl - b.pnl)[0];
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(total >= 0 ? 0x00e676 : 0xff1744).setTitle(`📊  P&L — ${labels[period]}`)
        .addFields(
          { name: "Total P&L",   value: `\`${total >= 0 ? "+" : ""}$${total.toFixed(2)}\``,                                                       inline: true },
          { name: "Win Rate",    value: `\`${((wins.length / records.length) * 100).toFixed(0)}%\` (${wins.length}W / ${losses.length}L)`,         inline: true },
          { name: "# Trades",   value: `\`${records.length}\``,                                                                                    inline: true },
          { name: "Avg Win",    value: `\`+$${avgWin.toFixed(2)}\``,                                                                               inline: true },
          { name: "Avg Loss",   value: `\`-$${Math.abs(avgLoss).toFixed(2)}\``,                                                                    inline: true },
          { name: "Expectancy", value: `\`$${((avgWin * wins.length + avgLoss * losses.length) / records.length).toFixed(2)}\` per trade`,         inline: true },
          { name: "Best",       value: best  ? `\`${best.symbol}\`  +$${best.pnl.toFixed(2)}`  : "N/A", inline: true },
          { name: "Worst",      value: worst ? `\`${worst.symbol}\`  $${worst.pnl.toFixed(2)}` : "N/A", inline: true },
        ).setTimestamp()
    ]});
  }

  // /size
  else if (interaction.commandName === "size") {
    const symbol   = interaction.options.getString("symbol").toUpperCase();
    const entry    = interaction.options.getNumber("entry");
    const stopLoss = interaction.options.getNumber("stoploss");
    const riskPct  = interaction.options.getNumber("risk") || RISK_PER_TRADE;
    const sz       = calcPositionSize(entry, stopLoss, riskPct);
    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0x5865f2).setTitle(`📦  Position Size — ${symbol}`)
        .addFields(
          { name: "Account Size", value: `\`$${ACCOUNT_SIZE.toLocaleString()}\``,         inline: true },
          { name: "Risk %",       value: `\`${riskPct}%\``,                               inline: true },
          { name: "Risk Amount",  value: `\`$${sz.riskAmount.toFixed(2)}\``,              inline: true },
          { name: "Entry",        value: `\`$${entry}\``,                                 inline: true },
          { name: "Stop Loss",    value: `\`$${stopLoss}\``,                              inline: true },
          { name: "Risk/Share",   value: `\`$${Math.abs(entry - stopLoss).toFixed(2)}\``, inline: true },
          { name: "✅  Shares",   value: `\`${sz.shares}\``,                              inline: true },
          { name: "💵  Cost",     value: `\`$${sz.totalCost.toLocaleString()}\``,         inline: true },
          { name: "💸  Max Loss", value: `\`$${sz.maxLoss.toFixed(2)}\``,                inline: true },
        ).setTimestamp()
    ]});
  }
});

// ─── Webhook server ───────────────────────────────────────────────────────────
function startWebhookServer() {
  const app = express();
  app.use(express.json());
  app.post("/trade", async (req, res) => {
    if (req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    const { symbol, direction = "LONG", entry, stop_loss, take_profit } = req.body;
    if (!symbol || !entry || !stop_loss || !take_profit) return res.status(400).json({ error: "Missing fields" });
    try {
      // Check earnings before placing
      const { risky, earnings } = await isEarningsRisk(symbol, 2);
      if (risky) {
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.send({ embeds: [
          new EmbedBuilder().setColor(0xffa500)
            .setTitle(`⚠️  ${symbol.toUpperCase()} — Trade Blocked (Earnings Risk)`)
            .setDescription(`Earnings on **${earnings.date}** (${earnings.daysUntil} day${earnings.daysUntil !== 1 ? "s" : ""} away). Trade was not placed to protect against earnings volatility.`)
            .setTimestamp()
        ]});
        return res.json({ success: false, reason: "earnings_risk", earnings });
      }
      await executeTrade({
        symbol, direction: direction.toUpperCase(),
        entry: parseFloat(entry), stopLoss: parseFloat(stop_loss), takeProfit: parseFloat(take_profit),
        source: req.body.signal_type || "TradingView",
      });
      res.json({ success: true });
    } catch (err) { console.error("Webhook error:", err); res.status(500).json({ error: "Failed" }); }
  });
  app.get("/health", (_, res) => res.json({ status: "ok", paper: PAPER_TRADING, uptime: process.uptime() }));
  app.listen(WEBHOOK_PORT, () => console.log(`🌐 Webhook server on port ${WEBHOOK_PORT}`));
}

// ─── Scheduled jobs ───────────────────────────────────────────────────────────
function scheduleJobs() {
  // Monday 8:00 AM — weekly economic calendar
  cron.schedule("0 8 * * 1", async () => { try { await sendWeeklyCalendar(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  // Weekdays 9:00 AM — pre-market summary
  cron.schedule("0 9 * * 1-5", async () => { try { await sendPremarketSummary(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  // Weekdays 9:35 AM — technical scan
  cron.schedule("35 9 * * 1-5", async () => { try { await runScan(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  // Weekdays 4:05 PM — close summary
  cron.schedule("5 16 * * 1-5", async () => { try { await sendCloseSummary(await client.channels.fetch(CHANNEL_ID)); } catch(e){console.error(e);} }, { timezone: "America/New_York" });
  console.log("📅 Scheduled: Mon 8AM calendar, 9AM pre-market, 9:35AM scan, 4:05PM close summary");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  console.log(`📄 Mode: ${PAPER_TRADING ? "PAPER TRADING" : "⚠️  LIVE TRADING"}`);
  startWebhookServer();
  scheduleJobs();
});

registerCommands();
client.login(DISCORD_TOKEN);
