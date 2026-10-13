/**
 * End-to-end Verification Server and Playwright Screenshot Generator
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createGasEnvironment } = require('./mock-backend');
const vm = require('vm');

const PORT = 3000;
let serverState = 'healthy'; // 'healthy', 'outage', 'night', 'stale', 'empty', 'unreachable'

function setupGasBackendForState(stateName) {
  const env = createGasEnvironment();
  const codePath = path.join(__dirname, '../backend/Code.gs');
  const codeContent = fs.readFileSync(codePath, 'utf8');

  const context = vm.createContext(Object.assign({}, env));
  vm.runInContext(codeContent, context);

  context.setup();
  const key = context.getSettings().ingest_key;
  const now = new Date();

  // Helper to log readings
  function logReading(powerKw, dateObj) {
    context.doPost({
      postData: {
        contents: JSON.stringify({
          key,
          power_kw: powerKw,
          timestamp: context.formatIsoIST(dateObj),
          energy_today_kwh: null,
          dc_voltage: powerKw > 0 ? 385 : 0,
          dc_current: powerKw > 0 ? (powerKw * 1000 / 385) : 0,
          ac_voltage: powerKw > 0 ? 232 : 230,
          frequency_hz: 50.0,
          inverter_temp_c: powerKw > 0 ? 41.5 : 28.0
        })
      }
    });
  }

  // Populate mock Daily historical data for past month and months
  const dSheet = env._spreadsheet.getSheetByName('Daily');
  dSheet.appendRow(["2025-11-15", 38.5, 8.2, 77]);
  dSheet.appendRow(["2025-12-15", 36.0, 7.9, 77]);
  dSheet.appendRow(["2026-01-15", 39.2, 8.4, 77]);
  dSheet.appendRow(["2026-02-15", 41.0, 8.7, 77]);
  dSheet.appendRow(["2026-03-15", 44.5, 9.1, 77]);
  dSheet.appendRow(["2026-04-15", 46.0, 9.3, 77]);
  dSheet.appendRow(["2026-05-15", 43.8, 8.9, 77]);
  dSheet.appendRow(["2026-06-15", 38.0, 8.1, 77]);
  dSheet.appendRow(["2026-07-15", 34.5, 7.5, 77]);
  dSheet.appendRow(["2026-08-15", 36.2, 7.8, 77]);
  dSheet.appendRow(["2026-09-15", 39.5, 8.3, 77]);

  // Current month daily readings
  for (let d = 1; d <= 12; d++) {
    const dayStr = `2026-10-${String(d).padStart(2, '0')}`;
    const e = 38 + 5 * Math.sin(d);
    dSheet.appendRow([dayStr, Math.round(e * 10) / 10, 8.6, 77]);
  }

  if (stateName === 'empty') {
    // No readings for today
    return { context, env };
  }

  // Generate morning curve up to 40 minutes ago
  const morningMinutes = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes() + 330)); // current IST minute
  const startMinute = 6 * 60; // 6:00 am

  for (let m = startMinute; m <= morningMinutes - 40; m += 10) {
    const frac = (m - startMinute) / (12 * 60);
    const p = Math.max(0, Math.round(9.2 * Math.sin(Math.PI * frac) * 100) / 100);
    const ptDate = new Date(Date.UTC(2026, 9, 13, Math.floor(m / 60), m % 60, 0) - 19800000);
    logReading(p, ptDate);
  }

  if (stateName === 'healthy') {
    // Normal healthy generation leading right up to now
    for (let m = morningMinutes - 30; m <= morningMinutes; m += 10) {
      const frac = (m - startMinute) / (12 * 60);
      const p = Math.max(0, Math.round(9.2 * Math.sin(Math.PI * frac) * 100) / 100);
      const ptDate = new Date(Date.UTC(2026, 9, 13, Math.floor(m / 60), m % 60, 0) - 19800000);
      logReading(p, ptDate);
    }
  } else if (stateName === 'outage') {
    // Normal generation before, but last 3 readings up to now are 0.05 kW (severe fault)
    for (let m = morningMinutes - 20; m <= morningMinutes; m += 10) {
      const ptDate = new Date(Date.UTC(2026, 9, 13, Math.floor(m / 60), m % 60, 0) - 19800000);
      logReading(0.05, ptDate); // outage!
    }
  } else if (stateName === 'stale') {
    // Do not log anything for the last 40 minutes -> last reading was at morningMinutes - 40 (>30 min ago!)
  } else if (stateName === 'night') {
    // Full day generation up to 18:30
    for (let m = morningMinutes - 30; m <= 18 * 60 + 30; m += 10) {
      const frac = (m - startMinute) / (12 * 60);
      const p = Math.max(0, Math.round(9.2 * Math.sin(Math.PI * frac) * 100) / 100);
      const ptDate = new Date(Date.UTC(2026, 9, 13, Math.floor(m / 60), m % 60, 0) - 19800000);
      logReading(p, ptDate);
    }
  }

  return { context, env };
}

// Start local test server
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
      const pathname = parsedUrl.pathname;

      // Handle Mock Apps Script API
      if (pathname === '/api/exec') {
        if (serverState === 'unreachable') {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
          return;
        }

        const gas = setupGasBackendForState(serverState);
        const route = parsedUrl.searchParams.get('route') || 'bundle';
        const date = parsedUrl.searchParams.get('date') || '2026-10-13';
        const month = parsedUrl.searchParams.get('month') || '2026-10';

        const output = gas.context.doGet({
          parameter: { route, date, month }
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(output.getContent());
        return;
      }

      // Serve index.html
      if (pathname === '/' || pathname === '/index.html') {
        const indexPath = path.join(__dirname, '../index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(PORT, () => {
      resolve(server);
    });
  });
}

async function runScreenshotSuite() {
  console.log('Starting verification test server...');
  const server = await startServer();
  console.log(`Server listening on port ${PORT}`);

  const screenshotDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log('Launching headless browser...');
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome'
  });

  const apiUrl = `http://localhost:${PORT}/api/exec`;

  // 1. Healthy State (Desktop)
  console.log('Capturing: Healthy generation state...');
  serverState = 'healthy';
  let context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-1-healthy.png'), fullPage: true });
  await context.close();

  // 2. Outage State
  console.log('Capturing: Outage state...');
  serverState = 'outage';
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-2-outage.png'), fullPage: true });
  await context.close();

  // 3. Night State (Test hook testHour=21 and testRad=0)
  console.log('Capturing: Night state...');
  serverState = 'night';
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.route('https://api.open-meteo.com/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        current: { temperature_2m: 22, relative_humidity_2m: 65, wind_speed_10m: 6.5, shortwave_radiation: 0, weather_code: 0 },
        hourly: {
          time: ["2026-10-13T06:00:00+05:30", "2026-10-13T12:00:00+05:30", "2026-10-13T18:00:00+05:30"],
          shortwave_radiation: [50, 850, 0]
        }
      })
    });
  });
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}&testHour=21&testRad=0`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-3-night.png'), fullPage: true });
  await context.close();

  // 4. Stale Logger State (>30m in daylight)
  console.log('Capturing: Stale logger state...');
  serverState = 'stale';
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-4-stale.png'), fullPage: true });
  await context.close();

  // 5. Empty Sheet State (Waiting for first reading)
  console.log('Capturing: Empty sheet state...');
  serverState = 'empty';
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-5-empty.png'), fullPage: true });
  await context.close();

  // 6. Backend Unreachable State
  console.log('Capturing: Backend unreachable state...');
  serverState = 'unreachable';
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?api=${encodeURIComponent(apiUrl)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-6-unreachable.png'), fullPage: true });
  await context.close();

  // 7. Sample Demo Mode (?demo=1)
  console.log('Capturing: Sample demo simulation mode...');
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?demo=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-7-sample.png'), fullPage: true });
  await context.close();

  // 8. 390px Mobile Phone View
  console.log('Capturing: 390px mobile view...');
  serverState = 'healthy';
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/index.html?demo=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(screenshotDir, 'screenshot-8-phone-390px.png'), fullPage: true });
  await context.close();

  console.log('All 8 screenshots successfully captured!');

  await browser.close();
  server.close();
}

runScreenshotSuite().catch(err => {
  console.error("Screenshot suite failed:", err);
  process.exit(1);
});
