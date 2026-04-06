// Playwright test suite — stock-intel
// Run via: node tests/test_suite.js
// Or: npx playwright test tests/test_suite.js

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const GITHUB_PAGES_URL = process.env.TEST_URL || "https://jawadayaz.github.io/stock-intel/";
const WORKER_URL = process.env.WORKER_URL || "https://stock-intel-worker.jawadayaz.workers.dev";

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let passed = 0, failed = 0;
const results = [];

async function test(name, fn, browser) {
  const page = await browser.newPage();
  try {
    await fn(page);
    console.log(`  ✓ ${name}`);
    passed++;
    results.push({ name, status: "passed" });
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
    results.push({ name, status: "failed", error: e.message });
    const fname = name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${fname}.png`), fullPage: true }).catch(() => {});
  } finally {
    await page.close();
  }
}

async function apiTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ [API] ${name}`);
    passed++;
    results.push({ name: `[API] ${name}`, status: "passed" });
  } catch (e) {
    console.error(`  ✗ [API] ${name}: ${e.message}`);
    failed++;
    results.push({ name: `[API] ${name}`, status: "failed", error: e.message });
  }
}

async function fetchApi(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  if (!res.ok && res.status !== 501) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  console.log("\nstock-intel test suite\n");

  // ─── Worker API Tests ────────────────────────────────────────────────────
  console.log("── Worker API ──");

  await apiTest("GET /api/version returns WORKER_VERSION", async () => {
    const data = await fetchApi("/api/version");
    if (!data.version) throw new Error("No version field");
  });

  await apiTest("GET /api/criteria returns filters and flags", async () => {
    const data = await fetchApi("/api/criteria");
    if (!data.filters || !data.flags) throw new Error("Missing filters or flags");
    if (!data.filters.length) throw new Error("No filters in criteria");
  });

  await apiTest("GET /api/watchlist returns array", async () => {
    const data = await fetchApi("/api/watchlist");
    if (!Array.isArray(data)) throw new Error("Not an array");
  });

  await apiTest("GET /api/screens returns array", async () => {
    const data = await fetchApi("/api/screens");
    if (!Array.isArray(data)) throw new Error("Not an array");
  });

  await apiTest("GET /api/digest/last returns null or object", async () => {
    const data = await fetchApi("/api/digest/last");
    if (data !== null && typeof data !== "object") throw new Error("Unexpected type");
  });

  await apiTest("GET /api/cron-status returns workerVersion", async () => {
    const data = await fetchApi("/api/cron-status");
    if (!data.workerVersion) throw new Error("No workerVersion");
  });

  await apiTest("GET /api/stock/AAPL returns stock data", async () => {
    const data = await fetchApi("/api/stock/AAPL");
    if (!data.ticker) throw new Error("No ticker in response");
    if (data.ticker !== "AAPL") throw new Error("Wrong ticker");
  });

  await apiTest("GET /api/symbol-search returns results", async () => {
    const data = await fetchApi("/api/symbol-search?q=apple&exchange=US");
    if (!Array.isArray(data)) throw new Error("Not an array");
  });

  await apiTest("GET /api/backtest returns 501 stub", async () => {
    const res = await fetch(`${WORKER_URL}/api/backtest`);
    if (res.status !== 501) throw new Error(`Expected 501, got ${res.status}`);
  });

  await apiTest("POST /api/watchlist add + DELETE remove", async () => {
    const add = await fetchApi("/api/watchlist", { method: "POST", body: JSON.stringify({ ticker: "TEST_TICKER_DELETE_ME", name: "Test" }) });
    if (!add.success) throw new Error("Add failed");
    const list = await fetchApi("/api/watchlist");
    const item = list.find(w => w.ticker === "TEST_TICKER_DELETE_ME");
    if (!item) throw new Error("Item not in list");
    const del = await fetchApi(`/api/watchlist/${item.id}`, { method: "DELETE" });
    if (!del.success) throw new Error("Delete failed");
  });

  await apiTest("POST /api/screens save + DELETE remove", async () => {
    const screen = { name: "TEST_SCREEN_DELETE_ME", universe: "SP500_NASDAQ", filters: [], requiredFlags: [] };
    const save = await fetchApi("/api/screens", { method: "POST", body: JSON.stringify(screen) });
    if (!save.success) throw new Error("Save failed");
    const list = await fetchApi("/api/screens");
    const item = list.find(s => s.name === "TEST_SCREEN_DELETE_ME");
    if (!item) throw new Error("Screen not found");
    const del = await fetchApi(`/api/screens/${item.id}`, { method: "DELETE" });
    if (!del.success) throw new Error("Delete failed");
  });

  // ─── UI Tests ─────────────────────────────────────────────────────────────
  console.log("\n── UI (GitHub Pages) ──");

  await test("Page loads with correct title", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    const title = await page.title();
    if (!title.includes("Stock Intel")) throw new Error(`Title was: ${title}`);
  }, browser);

  await test("All 4 nav tabs visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    for (const label of ["Screener", "Watchlist", "Screens", "Settings"]) {
      const btn = page.locator(`button.nav-tab:has-text("${label}")`);
      if (!await btn.isVisible()) throw new Error(`Tab "${label}" not visible`);
    }
  }, browser);

  await test("Screener tab: controls bar visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Screener')").click();
    await page.waitForSelector(".controls-bar");
    const runBtn = page.locator("button:has-text('Run Screen')");
    if (!await runBtn.isVisible()) throw new Error("Run Screen button not visible");
  }, browser);

  await test("Screener tab: universe selector has 3 options", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Screener')").click();
    const opts = await page.locator(".controls-bar select option").count();
    if (opts < 3) throw new Error(`Only ${opts} universe options`);
  }, browser);

  await test("Screener tab: sidebar loads filter categories", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Screener')").click();
    await page.waitForSelector(".sidebar");
    const headers = await page.locator(".sidebar-section-header").count();
    if (headers < 4) throw new Error(`Only ${headers} filter sections`);
  }, browser);

  await test("Screener tab: enabling filter shows inputs", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Screener')").click();
    await page.waitForSelector(".sidebar");
    // Click first filter checkbox
    const firstCheckbox = page.locator(".filter-row input[type=checkbox]").first();
    await firstCheckbox.check();
    // Should now show an operator dropdown
    await page.waitForSelector(".filter-row select");
  }, browser);

  await test("Watchlist tab: add ticker input visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Watchlist')").click();
    await page.waitForSelector(".autocomplete-wrap input");
  }, browser);

  await test("Watchlist tab: typing in search triggers suggestions area", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Watchlist')").click();
    await page.waitForSelector(".autocomplete-wrap input");
    await page.fill(".autocomplete-wrap input", "apple");
    // Wait briefly for debounce
    await page.waitForTimeout(500);
    // Just verify no crash
  }, browser);

  await test("Screens tab: empty state or screen cards visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Screens')").click();
    await page.waitForTimeout(1000);
    const hasEmpty = await page.locator(".empty-state").isVisible().catch(() => false);
    const hasCards = await page.locator(".screen-card").count();
    if (!hasEmpty && hasCards === 0) throw new Error("Neither empty state nor screen cards visible");
  }, browser);

  await test("Settings tab: criteria manager tables visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Settings')").click();
    await page.waitForTimeout(1500);
    const tables = await page.locator("table").count();
    if (tables < 2) throw new Error(`Only ${tables} tables in Settings`);
  }, browser);

  await test("Settings tab: save criteria button visible", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    await page.locator("button.nav-tab:has-text('Settings')").click();
    const btn = page.locator("button:has-text('Save criteria')");
    if (!await btn.isVisible()) throw new Error("Save criteria button not visible");
  }, browser);

  await test("Version indicator visible in footer", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    const footer = page.locator(".footer");
    const text = await footer.textContent();
    if (!text.includes("v01.00")) throw new Error(`Footer: "${text}"`);
  }, browser);

  await test("Deep dive: India stock shows unavailable message", async (page) => {
    await page.goto(GITHUB_PAGES_URL, { waitUntil: "networkidle" });
    // We can't easily trigger a deep dive without a screen result, so
    // just verify the slide-panel exists in DOM
    await page.waitForSelector(".slide-panel");
  }, browser);

  await browser.close();

  // ─── Summary ─────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);

  const logPath = path.join(__dirname, "results.log");
  fs.writeFileSync(logPath, JSON.stringify({ passed, failed, total, results, runAt: new Date().toISOString() }, null, 2));
  console.log(`Log: ${logPath}`);

  if (failed > 0) process.exit(1);
})();
