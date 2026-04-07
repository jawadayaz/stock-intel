// stock-intel Cloudflare Worker
// Version: 01.02

const WORKER_VERSION = "01.02";

// ─── Rate limiter (token bucket, 60 req/min for Finnhub) ───────────────────
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate; // tokens per ms
    this.lastRefill = Date.now();
  }
  consume() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) { this.tokens--; return true; }
    return false;
  }
}
const finnhubBucket = new TokenBucket(60, 60 / 60000);

// ─── Finnhub helper ────────────────────────────────────────────────────────
async function finnhub(env, path) {
  // Simple retry with rate limit
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!finnhubBucket.consume()) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    const res = await fetch(`https://finnhub.io/api/v1${path}`, {
      headers: { "X-Finnhub-Token": env.FINNHUB_KEY }
    });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    return res.json();
  }
  return null;
}

// ─── FMP helper ───────────────────────────────────────────────────────────
async function fmp(env, path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://financialmodelingprep.com/api/v3${path}${sep}apikey=${env.FMP_KEY}`);
  return res.json();
}

// ─── KV cache helper ──────────────────────────────────────────────────────
async function kvGet(env, key) {
  try { return JSON.parse(await env.STOCK_INTEL.get(key)); } catch { return null; }
}
async function kvPut(env, key, val, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : {};
  await env.STOCK_INTEL.put(key, JSON.stringify(val), opts);
}

// ─── Unified AI caller (Anthropic → Gemini fallback) ─────────────────────
// Returns the text response string, or null if no AI available.
async function callAI(env, userPrompt, systemPrompt = "") {
  if (env.ANTHROPIC_API_KEY) {
    const messages = [{ role: "user", content: userPrompt }];
    const body = { model: "claude-sonnet-4-6", max_tokens: 1024, messages };
    if (systemPrompt) body.system = systemPrompt;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data?.content?.[0]?.text || null;
  }

  if (env.GEMINI_API_KEY) {
    const contents = [];
    if (systemPrompt) contents.push({ role: "user", parts: [{ text: systemPrompt }] }, { role: "model", parts: [{ text: "Understood." }] });
    contents.push({ role: "user", parts: [{ text: userPrompt }] });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents })
      }
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }

  return null; // No AI configured
}

// ─── Criteria defaults (inlined — Workers have no filesystem) ─────────────
const CRITERIA_DEFAULTS = {
  filters: [
    {"id":"pe_ratio","label":"P/E ratio","category":"Fundamentals","metric":"pe","operators":[">","<","between"],"defaultOp":"<","defaultVal":30},
    {"id":"ps_ratio","label":"P/S ratio","category":"Fundamentals","metric":"ps","operators":[">","<","between"],"defaultOp":"<","defaultVal":10},
    {"id":"market_cap","label":"Market cap","category":"Fundamentals","metric":"marketCap","operators":[">","<","between"],"defaultOp":">","defaultVal":"10B"},
    {"id":"revenue_growth","label":"Revenue growth (YoY)","category":"Fundamentals","metric":"revenueGrowthYOY","operators":[">","<"],"defaultOp":">","defaultVal":0.10},
    {"id":"gross_margin","label":"Gross margin","category":"Fundamentals","metric":"grossMargin","operators":[">","<"],"defaultOp":">","defaultVal":0.30},
    {"id":"roe","label":"ROE","category":"Fundamentals","metric":"roe","operators":[">","<"],"defaultOp":">","defaultVal":0.10},
    {"id":"debt_equity","label":"Debt/Equity","category":"Fundamentals","metric":"totalDebt/totalEquity","operators":[">","<"],"defaultOp":"<","defaultVal":1.5},
    {"id":"pe_trend","label":"P/E trend","category":"Valuation Trend","metric":"pe","type":"trend","operators":["expanding","contracting"],"defaultOp":"contracting","defaultQuarters":4},
    {"id":"ps_trend","label":"P/S trend","category":"Valuation Trend","metric":"ps","type":"trend","operators":["expanding","contracting"],"defaultOp":"contracting","defaultQuarters":4},
    {"id":"rsi","label":"RSI","category":"Technical","metric":"rsi","operators":[">","<","between"],"defaultOp":"<","defaultVal":65},
    {"id":"vs_200ma","label":"Price vs 200MA","category":"Technical","metric":"vs200MA","operators":[">","<"],"defaultOp":">","defaultVal":0},
    {"id":"week52_position","label":"52-week position","category":"Technical","metric":"week52Position","operators":[">","<"],"defaultOp":">","defaultVal":0.5},
    {"id":"gaap_gap","label":"Non-GAAP vs GAAP spread","category":"Earnings Quality","metric":"gaapGap","type":"trend","operators":["widening","narrowing"],"defaultOp":"narrowing","defaultQuarters":4},
    {"id":"analyst_buy_pct","label":"Analyst buy %","category":"Analyst","metric":"buyPct","operators":[">","<"],"defaultOp":">","defaultVal":0.60},
    {"id":"price_target_upside","label":"Price target upside","category":"Analyst","metric":"ptUpside","operators":[">","<"],"defaultOp":">","defaultVal":0.10},
    {"id":"beat_streak","label":"Earnings beat streak","category":"Earnings Momentum","metric":"beatStreak","operators":[">","<"],"defaultOp":">","defaultVal":2},
    {"id":"surprise_trend","label":"Surprise magnitude trend","category":"Earnings Momentum","metric":"surpriseTrend","operators":["improving","deteriorating"],"defaultOp":"improving","defaultQuarters":4}
  ],
  flags: [
    {"id":"multiple_compression","label":"Multiple compression","color":"red","signal":"P/E contracting while EPS growing for 2+ quarters"},
    {"id":"gaap_gap_widening","label":"GAAP gap widening","color":"red","signal":"Non-GAAP adjustments growing as % of earnings over 3+ quarters"},
    {"id":"miss_streak","label":"Miss streak","color":"red","signal":"2+ consecutive earnings misses"},
    {"id":"decelerating_growth","label":"Decelerating growth","color":"amber","signal":"Revenue growth slowing for 3+ consecutive quarters"},
    {"id":"margin_squeeze","label":"Margin squeeze","color":"amber","signal":"Gross margin declining while revenue grows"},
    {"id":"multiple_rerating","label":"Multiple re-rating","color":"green","signal":"P/E expanding while earnings accelerating — justified expansion"},
    {"id":"estimate_revision_up","label":"Estimate revision up","color":"green","signal":"Analyst EPS estimates revised upward in last 60 days"}
  ]
};

// ─── Seed criteria defaults on first run ──────────────────────────────────
async function ensureCriteriaSeeded(env) {
  const existing = await kvGet(env, "criteria_config");
  if (!existing) await kvPut(env, "criteria_config", CRITERIA_DEFAULTS);
}

// ─── Technicals calculation ───────────────────────────────────────────────
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function computeMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Stock data fetcher (with KV cache) ───────────────────────────────────
async function fetchStockData(env, ticker) {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `stock:${ticker}:${today}`;
  const cached = await kvGet(env, cacheKey);
  if (cached) return cached;

  const toUnix = (d) => Math.floor(d.getTime() / 1000);
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 280);

  const [quote, metrics, earnings, recommendations, sentiment, candles] = await Promise.all([
    finnhub(env, `/quote?symbol=${ticker}`),
    finnhub(env, `/stock/metric?symbol=${ticker}&metric=all`),
    finnhub(env, `/stock/earnings?symbol=${ticker}&limit=8`),
    finnhub(env, `/stock/recommendation?symbol=${ticker}`),
    finnhub(env, `/news-sentiment?symbol=${ticker}`),
    finnhub(env, `/stock/candle?symbol=${ticker}&resolution=D&from=${toUnix(from)}&to=${toUnix(now)}`)
  ]);

  const m = metrics?.metric || {};
  const q = quote || {};
  const closes = (candles?.c) || [];

  const rsi = computeRSI(closes);
  const ma200 = computeMA(closes, 200);
  const vs200MA = (ma200 && q.c) ? (q.c - ma200) / ma200 : null;
  const hi52 = m["52WeekHigh"] || q.h;
  const lo52 = m["52WeekLow"] || q.l;
  const week52Position = (hi52 && lo52 && q.c) ? (q.c - lo52) / (hi52 - lo52) : null;

  // Analyst summary
  const rec = recommendations?.[0] || {};
  const totalRec = (rec.buy || 0) + (rec.hold || 0) + (rec.sell || 0) + (rec.strongBuy || 0) + (rec.strongSell || 0);
  const buyPct = totalRec > 0 ? ((rec.buy || 0) + (rec.strongBuy || 0)) / totalRec : null;
  const ptUpside = (m.targetMedianPrice && q.c) ? (m.targetMedianPrice - q.c) / q.c : null;

  // Earnings analysis
  const earningsData = earnings || [];
  let beatStreak = 0;
  for (const e of earningsData) {
    if (e.actual !== null && e.estimate !== null && e.actual > e.estimate) beatStreak++;
    else break;
  }
  const surprises = earningsData.map(e => e.actual !== null && e.estimate !== null ? ((e.actual - e.estimate) / Math.abs(e.estimate || 1)) : null).filter(x => x !== null);
  const surpriseTrend = surprises.length >= 2 ? surprises[0] - surprises[surprises.length - 1] : null;
  const missStreak = earningsData.slice(0, 2).every(e => e.actual !== null && e.estimate !== null && e.actual < e.estimate);

  // Flags
  const flags = computeFlags({ m, earningsData, rsi, vs200MA, buyPct, beatStreak, surprises });

  const data = {
    ticker,
    name: q.name || ticker,
    price: q.c,
    change: q.dp,
    marketCap: m.marketCapitalization ? m.marketCapitalization * 1e6 : null,
    pe: m.peBasicExclExtraTTM || m.peTTM || null,
    ps: m.priceToSalesTTM || null,
    revenueGrowthYOY: m.revenueGrowthTTMYoy || null,
    grossMargin: m.grossMarginTTM || null,
    roe: m.roeTTM || null,
    totalDebt: m.totalDebtToEquityAnnual || null,
    rsi, vs200MA, week52Position,
    buyPct, ptUpside,
    beatStreak, surpriseTrend,
    missStreak,
    sentiment: sentiment?.buzz?.articlesInLastWeek || 0,
    earningsData: earningsData.slice(0, 4),
    flags,
    exchange: ticker.endsWith(".NS") ? "NSE" : ticker.endsWith(".BO") ? "BSE" : "US"
  };

  await kvPut(env, cacheKey, data, 86400);
  return data;
}

// ─── Flag computation ─────────────────────────────────────────────────────
function computeFlags({ m, earningsData, rsi, vs200MA, buyPct, beatStreak, surprises }) {
  const flags = [];

  // Multiple compression: P/E contracting while EPS growing
  if (m.peTTM && m.peBasicExclExtraTTM) {
    const peTrend = (m.peNormalizedAnnual || 0) - (m.peTTM || 0);
    const epsGrowth = m.epsGrowthTTMYoy || 0;
    if (peTrend < 0 && epsGrowth > 0) flags.push("multiple_compression");
  }

  // Miss streak
  if (earningsData.slice(0, 2).every(e => e.actual !== null && e.estimate !== null && e.actual < e.estimate)) {
    flags.push("miss_streak");
  }

  // Decelerating growth (simplified: check if latest quarter revenue growth < prior)
  if (m.revenueGrowthTTMYoy !== undefined && m.revenueGrowth3Y !== undefined) {
    if ((m.revenueGrowthTTMYoy || 0) < (m.revenueGrowth3Y || 0)) {
      flags.push("decelerating_growth");
    }
  }

  // Margin squeeze
  if ((m.grossMarginTTM || 0) < (m.grossMargin5Y || 0) && (m.revenueGrowthTTMYoy || 0) > 0) {
    flags.push("margin_squeeze");
  }

  // Multiple re-rating
  if ((m.peTTM || 0) > (m.peNormalizedAnnual || 0) && (m.epsGrowthTTMYoy || 0) > 0.15) {
    flags.push("multiple_rerating");
  }

  // Estimate revision up (simplified: beat streak + improving surprises)
  if (beatStreak >= 2 && surprises.length >= 2 && surprises[0] > surprises[1]) {
    flags.push("estimate_revision_up");
  }

  return flags;
}

// ─── Screener logic ───────────────────────────────────────────────────────
function parseMarketCap(val) {
  if (typeof val === "number") return val;
  const s = String(val).toUpperCase();
  if (s.endsWith("T")) return parseFloat(s) * 1e12;
  if (s.endsWith("B")) return parseFloat(s) * 1e9;
  if (s.endsWith("M")) return parseFloat(s) * 1e6;
  return parseFloat(s);
}

function applyFilter(stock, filter, op, val, val2) {
  let metricVal = stock[filter.metric] ?? stock[filter.id];
  if (filter.metric === "totalDebt/totalEquity") metricVal = stock.totalDebt;
  if (filter.metric === "marketCap") {
    metricVal = stock.marketCap;
    val = parseMarketCap(val);
    if (val2) val2 = parseMarketCap(val2);
  }
  if (metricVal === null || metricVal === undefined) return true; // Skip if no data

  if (filter.type === "trend") {
    // Trend filters: expanding/contracting/widening/narrowing/improving/deteriorating
    const trend = stock[`${filter.id}_trend`];
    if (trend === undefined) return true;
    if (op === "contracting" || op === "narrowing" || op === "improving") return trend < 0;
    if (op === "expanding" || op === "widening" || op === "deteriorating") return trend > 0;
    return true;
  }

  switch (op) {
    case ">": return metricVal > Number(val);
    case "<": return metricVal < Number(val);
    case "=": return Math.abs(metricVal - Number(val)) < 0.001;
    case "between": return metricVal >= Number(val) && metricVal <= Number(val2);
    default: return true;
  }
}

async function runScreen(env, universe, activeFilters, requiredFlags) {
  // 1. Pre-filter with FMP
  let exchanges = [];
  if (universe === "SP500_NASDAQ") exchanges = ["NASDAQ", "NYSE"];
  else if (universe === "NIFTY500") exchanges = ["NSE"];
  else exchanges = ["NASDAQ", "NYSE", "NSE"];

  let candidates = [];
  for (const ex of exchanges) {
    try {
      const fmpRes = await fmp(env, `/stock-screener?marketCapMoreThan=500000000&exchange=${ex}`);
      if (Array.isArray(fmpRes)) candidates.push(...fmpRes.slice(0, 100));
    } catch (e) { /* skip */ }
  }

  // Deduplicate
  const seen = new Set();
  candidates = candidates.filter(c => {
    if (seen.has(c.symbol)) return false;
    seen.add(c.symbol);
    return true;
  });

  // Limit to 150 to conserve quota
  candidates = candidates.slice(0, 150);

  // 2. Fetch Finnhub data for each (with cache)
  const criteria = await kvGet(env, "criteria_config");
  const filterDefs = criteria?.filters || [];

  const results = [];
  for (const c of candidates) {
    try {
      const stock = await fetchStockData(env, c.symbol);
      if (!stock) continue;

      // Apply active filters
      let pass = true;
      for (const af of activeFilters) {
        const def = filterDefs.find(f => f.id === af.id);
        if (!def) continue;
        if (!applyFilter(stock, def, af.op, af.val, af.val2)) { pass = false; break; }
      }
      if (!pass) continue;

      // Check required flags
      for (const flagId of requiredFlags || []) {
        if (!stock.flags.includes(flagId)) { pass = false; break; }
      }
      if (!pass) continue;

      results.push(stock);
    } catch (e) { /* skip */ }
  }

  // Sort by market cap
  results.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  return results;
}

// ─── Email sender (Gmail SMTP via fetch is not natively supported in Workers)
// We use Gmail's OAuth-less App Password via a simple SMTP-over-HTTP approach
// For Workers, use the MailChannels free tier (Cloudflare integration)
async function sendDigestEmail(env, subject, html) {
  // Try MailChannels (free for Cloudflare Workers)
  const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: "jawadayaz@gmail.com", name: "Jawad" }] }],
      from: { email: env.GMAIL_USER || "noreply@stock-intel.workers.dev", name: "Stock Intel" },
      subject,
      content: [{ type: "text/html", value: html }]
    })
  });
  return res.status === 202;
}

// ─── Layer 2 — Deep dive (SEC EDGAR) ────────────────────────────────────
async function deepDive(env, ticker) {
  if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    return { comingSoon: true, message: "AI analysis coming soon — add ANTHROPIC_API_KEY or GEMINI_API_KEY to enable deep dive." };
  }

  // Fetch company profile for full name
  const profile = await finnhub(env, `/stock/profile2?symbol=${ticker}`);
  const companyName = profile?.name || ticker;

  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const edgarUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(companyName)}%22&dateRange=custom&startdt=${ninetyDaysAgo}&enddt=${today}&forms=8-K`;
  const edgarRes = await fetch(edgarUrl, { headers: { "User-Agent": "stock-intel jawadayaz@gmail.com" } });
  const edgarData = await edgarRes.json();

  const hits = edgarData?.hits?.hits || [];
  if (hits.length === 0) return { error: "No recent 8-K filings found" };

  const filing = hits[0];
  const filingText = filing?._source?.file_date + " — " + (filing?._source?.entity_name || companyName) + ": " + (filing?._source?.period_of_report || "");

  const aiText = await callAI(env,
    `Analyze this filing excerpt and return JSON with keys: credibilityScore (number 1-10), missReasons (string[]), guidanceTone (string), hedgingFlags (string[]), keyQuotes (string[]). Return only valid JSON, no other text.\n\nFiling: ${filingText}\n\nIf you cannot determine a miss, set credibilityScore to null and note that in guidanceTone.`,
    "You are analyzing an earnings call transcript or 8-K filing. Score management's explanation for any miss on a scale of 1-10 (10 = highly credible, specific, quantified reasons; 1 = vague, blame-shifting, unconvincing). Extract: (a) stated reasons for miss, (b) forward guidance language, (c) any hedging or qualifying language. Flag sentences that seem evasive. Return valid JSON only."
  );

  if (!aiText) return { error: "AI call failed" };
  try {
    const clean = aiText.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { credibilityScore: null, missReasons: [], guidanceTone: aiText, hedgingFlags: [], keyQuotes: [] };
  }
}

// ─── Cron handlers ────────────────────────────────────────────────────────
async function cronWatchlistEnrichment(env) {
  const watchlist = await kvGet(env, "watchlist") || [];
  const enriched = [];

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const item of watchlist) {
    try {
      const [news, stock] = await Promise.all([
        finnhub(env, `/company-news?symbol=${item.ticker}&from=${yesterday}&to=${today}`),
        fetchStockData(env, item.ticker)
      ]);

      const newsItems = (news || []).slice(0, 20);
      if (newsItems.length === 0) {
        enriched.push({ ...item, stockData: stock, news: [], enrichedAt: Date.now() });
        continue;
      }

      let filteredNews;
      const aiText = await callAI(env,
        `Filter this news list for ${item.ticker}. Keep only items that are meaningful (earnings, guidance, M&A, regulatory, leadership change, major contracts). Discard noise. For each kept item write a 2-sentence summary. Return a JSON array of {headline, summary} objects only — no other text. If nothing meaningful, return [].

News: ${JSON.stringify(newsItems.map(n => ({ headline: n.headline, summary: n.summary })))}`,
        "You are a financial news filter. Return only valid JSON arrays."
      );
      if (aiText) {
        try {
          const clean = aiText.replace(/```json|```/g, "").trim();
          filteredNews = JSON.parse(clean);
        } catch { filteredNews = newsItems.map(n => ({ headline: n.headline, summary: n.summary || "" })); }
      } else {
        // No AI configured — include all items as-is
        filteredNews = newsItems.map(n => ({ headline: n.headline, summary: n.summary || "" }));
      }

      enriched.push({ ...item, stockData: stock, news: filteredNews, enrichedAt: Date.now() });
    } catch (e) {
      enriched.push({ ...item, news: [], enrichedAt: Date.now() });
    }
  }

  await kvPut(env, "watchlist_enriched", enriched, 86400 * 2);
}

async function cronScreenRunner(env) {
  const screens = await kvGet(env, "saved_screens") || [];
  for (const screen of screens) {
    try {
      const results = await runScreen(env, screen.universe, screen.filters || [], screen.requiredFlags || []);
      const prev = await kvGet(env, `screen:${screen.id}:last`) || [];

      const prevTickers = new Set(prev.map(s => s.ticker));
      const currTickers = new Set(results.map(s => s.ticker));

      const entered = results.filter(s => !prevTickers.has(s.ticker));
      const exited = prev.filter(s => !currTickers.has(s.ticker));
      const flagChanges = [];

      for (const curr of results) {
        const prevStock = prev.find(p => p.ticker === curr.ticker);
        if (!prevStock) continue;
        const newFlags = curr.flags.filter(f => !prevStock.flags.includes(f));
        const clearedFlags = prevStock.flags.filter(f => !curr.flags.includes(f));
        if (newFlags.length || clearedFlags.length) flagChanges.push({ ticker: curr.ticker, newFlags, clearedFlags });
      }

      await kvPut(env, `screen:${screen.id}:last`, results);
      await kvPut(env, `screen:${screen.id}:diff`, { entered, exited, flagChanges, runAt: Date.now() }, 86400 * 2);

      // Update last run info on screen
      screen.lastRun = Date.now();
      screen.lastMatchCount = results.length;
    } catch (e) { /* skip */ }
  }
  await kvPut(env, "saved_screens", screens);
}

async function cronEmailSender(env) {
  const enriched = await kvGet(env, "watchlist_enriched") || [];
  const screens = await kvGet(env, "saved_screens") || [];
  const date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "long" });

  let html = `<div style="font-family:monospace;max-width:700px;margin:0 auto;color:#1a1a1a">`;
  html += `<h2 style="border-bottom:2px solid #333;padding-bottom:8px">[Stock Intel] Daily Digest — ${date}</h2>`;

  // Watchlist section
  html += `<h3>WATCHLIST DIGEST</h3>`;
  if (enriched.length === 0) {
    html += `<p>No watchlist items.</p>`;
  } else {
    for (const item of enriched) {
      const s = item.stockData;
      const priceStr = s?.price ? `$${s.price.toFixed(2)}` : "—";
      const changeStr = s?.change ? `${s.change > 0 ? "+" : ""}${s.change.toFixed(2)}%` : "—";
      html += `<div style="margin-bottom:16px;padding:12px;border:1px solid #ddd;border-radius:4px">`;
      html += `<strong>${item.ticker}</strong> &nbsp; ${item.exchange || ""} &nbsp; ${priceStr} &nbsp; <span style="color:${(s?.change||0)>=0?'green':'red'}">${changeStr}</span>`;
      if (item.news && item.news.length > 0) {
        for (const n of item.news) {
          html += `<p style="margin:8px 0 0;font-size:13px"><strong>${n.headline}</strong><br>${n.summary}</p>`;
        }
      } else {
        html += `<p style="margin:8px 0 0;color:#888;font-size:13px">No material news</p>`;
      }
      html += `</div>`;
    }
  }

  // Screen alerts
  html += `<h3>SCREEN ALERTS</h3>`;
  let anyAlerts = false;
  for (const screen of screens) {
    const diff = await kvGet(env, `screen:${screen.id}:diff`);
    if (!diff) continue;
    const { entered, exited, flagChanges } = diff;
    if (!entered?.length && !exited?.length && !flagChanges?.length) continue;
    anyAlerts = true;
    html += `<div style="margin-bottom:16px;padding:12px;border:1px solid #ddd;border-radius:4px">`;
    html += `<strong>${screen.name}</strong> → ${entered?.length||0} new entries, ${exited?.length||0} exits, ${flagChanges?.length||0} flag changes<br>`;
    if (entered?.length) {
      html += `<br><em>New entries:</em><br>`;
      for (const s of entered) {
        html += `${s.ticker} &nbsp; ${s.name} &nbsp; Mkt cap: ${s.marketCap ? (s.marketCap/1e9).toFixed(1)+"B" : "—"} &nbsp; Flags: ${s.flags.join(", ") || "none"}<br>`;
      }
    }
    if (exited?.length) {
      html += `<br><em>Exits:</em><br>`;
      for (const s of exited) html += `${s.ticker} — exited screen<br>`;
    }
    if (flagChanges?.length) {
      html += `<br><em>Flag changes:</em><br>`;
      for (const fc of flagChanges) {
        if (fc.newFlags?.length) html += `${fc.ticker} — New flag: ${fc.newFlags.join(", ")}<br>`;
        if (fc.clearedFlags?.length) html += `${fc.ticker} — Flag cleared: ${fc.clearedFlags.join(", ")}<br>`;
      }
    }
    html += `</div>`;
  }
  if (!anyAlerts) html += `<p>No screen changes today.</p>`;

  html += `<hr><p style="color:#888;font-size:12px">Digest generated at 05:00 IST | stock-intel v${WORKER_VERSION}</p></div>`;

  const sent = await sendDigestEmail(env, `[Stock Intel] Daily Digest — ${date}`, html);

  const log = await kvGet(env, "digest_log") || [];
  log.unshift({ date, sentAt: Date.now(), status: sent ? "sent" : "failed", html });
  await kvPut(env, "digest_log", log.slice(0, 30));
}

// ─── Router ───────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  await ensureCriteriaSeeded(env);

  // GET /api/health
  if (path === "/api/health") {
    return json({ status: "ok", version: WORKER_VERSION, environment: env.ENVIRONMENT || "production" });
  }

  // GET /api/version
  if (path === "/api/version") return json({ version: WORKER_VERSION });

  // GET /api/screen
  if (path === "/api/screen" && method === "GET") {
    const universe = url.searchParams.get("universe") || "SP500_NASDAQ";
    const filtersRaw = url.searchParams.get("filters");
    const flagsRaw = url.searchParams.get("flags");
    const filters = filtersRaw ? JSON.parse(decodeURIComponent(filtersRaw)) : [];
    const requiredFlags = flagsRaw ? JSON.parse(decodeURIComponent(flagsRaw)) : [];
    const results = await runScreen(env, universe, filters, requiredFlags);
    return json({ results, count: results.length, universe, runAt: Date.now() });
  }

  // GET /api/stock/:ticker
  if (path.startsWith("/api/stock/") && method === "GET") {
    const ticker = decodeURIComponent(path.split("/api/stock/")[1]);
    const data = await fetchStockData(env, ticker);
    return json(data || { error: "Not found" });
  }

  // GET /api/watchlist
  if (path === "/api/watchlist" && method === "GET") {
    const watchlist = await kvGet(env, "watchlist") || [];
    return json(watchlist);
  }

  // POST /api/watchlist
  if (path === "/api/watchlist" && method === "POST") {
    const body = await request.json();
    const watchlist = await kvGet(env, "watchlist") || [];
    const existing = watchlist.find(w => w.ticker === body.ticker);
    if (!existing) {
      watchlist.push({ id: Date.now().toString(), ticker: body.ticker, name: body.name || body.ticker, exchange: body.exchange || "US", addedAt: Date.now() });
      await kvPut(env, "watchlist", watchlist);
    }
    return json({ success: true, watchlist });
  }

  // DELETE /api/watchlist/:id
  if (path.startsWith("/api/watchlist/") && method === "DELETE") {
    const id = path.split("/api/watchlist/")[1];
    let watchlist = await kvGet(env, "watchlist") || [];
    watchlist = watchlist.filter(w => w.id !== id);
    await kvPut(env, "watchlist", watchlist);
    return json({ success: true });
  }

  // GET /api/screens
  if (path === "/api/screens" && method === "GET") {
    const screens = await kvGet(env, "saved_screens") || [];
    return json(screens);
  }

  // POST /api/screens
  if (path === "/api/screens" && method === "POST") {
    const body = await request.json();
    const screens = await kvGet(env, "saved_screens") || [];
    const existing = screens.findIndex(s => s.id === body.id);
    if (existing >= 0) screens[existing] = { ...screens[existing], ...body };
    else screens.push({ id: Date.now().toString(), createdAt: Date.now(), ...body });
    await kvPut(env, "saved_screens", screens);
    return json({ success: true });
  }

  // DELETE /api/screens/:id
  if (path.startsWith("/api/screens/") && method === "DELETE") {
    const id = path.split("/api/screens/")[1];
    let screens = await kvGet(env, "saved_screens") || [];
    screens = screens.filter(s => s.id !== id);
    await kvPut(env, "saved_screens", screens);
    return json({ success: true });
  }

  // GET /api/criteria
  if (path === "/api/criteria" && method === "GET") {
    const criteria = await kvGet(env, "criteria_config");
    return json(criteria || { filters: [], flags: [] });
  }

  // POST /api/criteria
  if (path === "/api/criteria" && method === "POST") {
    const body = await request.json();
    await kvPut(env, "criteria_config", body);
    return json({ success: true });
  }

  // GET /api/digest/last
  if (path === "/api/digest/last" && method === "GET") {
    const log = await kvGet(env, "digest_log") || [];
    return json(log[0] || null);
  }

  // POST /api/deepdive/:ticker
  if (path.startsWith("/api/deepdive/") && method === "POST") {
    const ticker = decodeURIComponent(path.split("/api/deepdive/")[1]);
    if (ticker.endsWith(".NS") || ticker.endsWith(".BO")) {
      return json({ error: "Transcript analysis not available for Indian exchanges" });
    }
    const result = await deepDive(env, ticker);
    return json(result);
  }

  // GET /api/symbol-search
  if (path === "/api/symbol-search" && method === "GET") {
    const q = url.searchParams.get("q") || "";
    const exchange = url.searchParams.get("exchange") || "US";
    const data = await finnhub(env, `/search?q=${encodeURIComponent(q)}&exchange=${exchange}`);
    return json(data?.result || []);
  }

  // GET /api/backtest — v2 stub
  if (path === "/api/backtest") {
    return json({ error: "Backtesting coming in v2" }, 501);
  }

  // GET /api/cron-status
  if (path === "/api/cron-status") {
    const log = await kvGet(env, "digest_log") || [];
    return json({
      lastDigest: log[0] || null,
      workerVersion: WORKER_VERSION
    });
  }

  // POST /api/test-email
  if (path === "/api/test-email" && method === "POST") {
    const sent = await sendDigestEmail(env, "[Stock Intel] Test Email", "<p>This is a test email from Stock Intel.</p>");
    return json({ success: sent });
  }

  return json({ error: "Not found" }, 404);
}

// ─── Entry point ──────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }
  },

  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === "0 23 * * *") await cronWatchlistEnrichment(env);
    else if (cron === "15 23 * * *") await cronScreenRunner(env);
    else if (cron === "30 23 * * *") await cronEmailSender(env);
  }
};
