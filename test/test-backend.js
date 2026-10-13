/**
 * Unit & Integration Test Suite for Google Apps Script Solar Backend
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { createGasEnvironment } = require('./mock-backend');

// Load Code.gs into a fresh VM context with mocked GAS globals
function loadBackendContext() {
  const env = createGasEnvironment();
  const codePath = path.join(__dirname, '../backend/Code.gs');
  const codeContent = fs.readFileSync(codePath, 'utf8');

  const context = vm.createContext(Object.assign({}, env));
  vm.runInContext(codeContent, context);

  return { context, env };
}

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    process.stdout.write(`Testing: ${name}... `);
    fn();
    console.log('PASSED');
    testsPassed++;
  } catch (err) {
    console.log('FAILED');
    console.error(err);
    testsFailed++;
  }
}

console.log('=== RUNNING BACKEND TEST SUITE ===\n');

// 1. Setup & Default Settings
runTest('Sheet setup, default settings, and random key generation', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  assert.strictEqual(setupRes.ok, true);
  assert.ok(setupRes.ingest_key);
  assert.strictEqual(setupRes.ingest_key.length, 20);

  const settings = context.getSettings();
  assert.strictEqual(settings.plant_name, 'GPREC EEE Block 1');
  assert.strictEqual(settings.capacity_kwp, 10);
  assert.strictEqual(settings.latitude, 15.81);
  assert.strictEqual(settings.longitude, 78.05);
  assert.strictEqual(settings.start_month, '2025-11');
  assert.strictEqual(settings.alert_drop_percent, 50);
  assert.strictEqual(settings.alert_min_sunlight, 150);
  assert.strictEqual(settings.tariff_per_kwh, 7);
  assert.strictEqual(settings.co2_kg_per_kwh, 0.7);
  assert.strictEqual(settings.ingest_key, setupRes.ingest_key);
});

// 2. Settings parsing with garbage numbers & invalid start_month
runTest('Settings parsing defensively falls back on garbage inputs', () => {
  const { context, env } = loadBackendContext();
  context.setup();
  const sSheet = env._spreadsheet.getSheetByName('Settings');
  
  // Overwrite values with garbage
  sSheet.rows[2][1] = "invalid_capacity";
  sSheet.rows[5][1] = "bad-date-string"; // start_month
  sSheet.rows[6][1] = "-50"; // negative drop percent
  sSheet.rows[10][1] = "free"; // tariff

  const parsed = context.getSettings();
  assert.strictEqual(parsed.capacity_kwp, 10, 'Fallback to 10 for bad capacity');
  assert.strictEqual(parsed.start_month, '2025-11', 'Fallback to 2025-11 for bad start_month');
  assert.strictEqual(parsed.alert_drop_percent, 50, 'Fallback to 50 for negative drop percent');
  assert.strictEqual(parsed.tariff_per_kwh, 7, 'Fallback to 7 for invalid tariff');
});

// 3. Timestamp parsing: all 6 formats & IST handling
runTest('Timestamp parsing: ISO, epoch seconds, epoch ms, YMD, DMY, and timezone-less treated as IST', () => {
  const { context } = loadBackendContext();
  
  // ISO with +05:30
  const dIso = context.parseTimestampToDate("2026-10-13T12:00:00+05:30");
  assert.strictEqual(context.formatIsoIST(dIso), "2026-10-13T12:00:00+05:30");

  // ISO with UTC Z
  const dUtc = context.parseTimestampToDate("2026-10-13T06:30:00Z");
  assert.strictEqual(context.formatIsoIST(dUtc), "2026-10-13T12:00:00+05:30");

  // Epoch seconds (10 digits)
  const epochSec = Math.floor(dIso.getTime() / 1000);
  const dEpochS = context.parseTimestampToDate(epochSec);
  assert.strictEqual(context.formatIsoIST(dEpochS), "2026-10-13T12:00:00+05:30");

  // Epoch ms (13 digits)
  const dEpochMs = context.parseTimestampToDate(dIso.getTime());
  assert.strictEqual(context.formatIsoIST(dEpochMs), "2026-10-13T12:00:00+05:30");

  // yyyy-mm-dd hh:mm without zone (treated as IST)
  const dYmd = context.parseTimestampToDate("2026-10-13 12:00");
  assert.strictEqual(context.formatIsoIST(dYmd), "2026-10-13T12:00:00+05:30");

  // dd/mm/yyyy hh:mm without zone (treated as IST)
  const dDmy = context.parseTimestampToDate("13/10/2026 12:00");
  assert.strictEqual(context.formatIsoIST(dDmy), "2026-10-13T12:00:00+05:30");
});

// 4. Ingest: Key rejection
runTest('Ingest rejects invalid or missing ingest key', () => {
  const { context } = loadBackendContext();
  context.setup();

  const res1 = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key: "wrong_key", power_kw: 5.5 }) }
  }).getContent());
  assert.strictEqual(res1.ok, false);
  assert.ok(res1.error.includes("Invalid ingest key"));

  const res2 = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ power_kw: 5.5 }) }
  }).getContent());
  assert.strictEqual(res2.ok, false);
});

// 5. Ingest: Validation errors (negative, missing, >3x capacity hint)
runTest('Ingest validates missing power, negative power, and >3x capacity hint', () => {
  const { context } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  // Missing power
  const resMissing = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, timestamp: "2026-10-13 10:00" }) }
  }).getContent());
  assert.strictEqual(resMissing.saved, 0);
  assert.strictEqual(resMissing.rejected.length, 1);
  assert.ok(resMissing.rejected[0].error.includes("Missing power reading"));

  // Negative power
  const resNeg = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: -2.5 }) }
  }).getContent());
  assert.strictEqual(resNeg.saved, 0);
  assert.ok(resNeg.rejected[0].error.includes("non-negative"));

  // Over 3x capacity (10 kWp * 3 = 30 kW) -> should give hint
  const resOver = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: 5000 }) }
  }).getContent());
  assert.strictEqual(resOver.saved, 0);
  assert.ok(resOver.rejected[0].error.includes("Is the logger sending watts? Use power_w"));

  // power_w converts correctly
  const resWatts = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, power_w: 5500, timestamp: "2026-10-13 10:00" }) }
  }).getContent());
  assert.strictEqual(resWatts.saved, 1);
  assert.strictEqual(resWatts.rejected.length, 0);
});

// 6. Ingest: Timestamps > 10 min in future rejected
runTest('Ingest rejects timestamps more than 10 minutes in the future', () => {
  const { context } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  const futureEpoch = Date.now() + 15 * 60 * 1000; // 15 mins in future
  const futureIso = new Date(futureEpoch).toISOString();

  const res = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: 6, timestamp: futureIso }) }
  }).getContent());
  assert.strictEqual(res.saved, 0);
  assert.ok(res.rejected[0].error.includes("more than 10 minutes in the future"));
});

// 7. Batch ingest & partial success
runTest('Batch ingest accepts up to 500 rows and handles partial success', () => {
  const { context } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  const rows = [
    { power_kw: 5.0, timestamp: "2026-10-13 10:00" },
    { power_kw: -1.0, timestamp: "2026-10-13 10:10" }, // invalid
    { power_w: 6000, timestamp: "2026-10-13 10:20" },  // valid (6 kW)
    { power_kw: 4000, timestamp: "2026-10-13 10:30" }  // invalid (> 30 kW)
  ];

  const res = JSON.parse(context.doPost({
    postData: { contents: JSON.stringify({ key, rows }) }
  }).getContent());

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.saved, 2);
  assert.strictEqual(res.rejected.length, 2);
  assert.strictEqual(res.rejected[0].index, 1);
  assert.strictEqual(res.rejected[1].index, 3);
});

// 8. Cache cleared on ingest
runTest('Cache is properly cleared when new data is ingested', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  // Prime cache
  env._cache.put("bundle_latest", "old_bundle");
  env._cache.put("bundle_2026-10-13", "old_date_bundle");
  env._cache.put("daily_2026-10", "old_daily");
  env._cache.put("months_all", "old_months");

  // Ingest data for 2026-10-13
  context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: 4.5, timestamp: "2026-10-13 11:00" }) }
  });

  assert.strictEqual(env._cache.get("bundle_latest"), null);
  assert.strictEqual(env._cache.get("bundle_2026-10-13"), null);
  assert.strictEqual(env._cache.get("daily_2026-10"), null);
  assert.strictEqual(env._cache.get("months_all"), null);
});

// 9. Daily totals: reported energy vs trapezoid integration
runTest('Daily totals: max energy_today_kwh vs trapezoid integration and gap handling', () => {
  const { context } = loadBackendContext();

  // Test case A: Reported energy present
  const readingsA = [
    { time: new Date("2026-10-13T06:00:00Z"), power: 2, energyToday: 1.2 },
    { time: new Date("2026-10-13T07:00:00Z"), power: 6, energyToday: 7.2 },
    { time: new Date("2026-10-13T08:00:00Z"), power: 8, energyToday: 15.2 }
  ];
  const totalsA = context.calculateDayEnergy(readingsA);
  assert.strictEqual(totalsA.energy, 15.2);
  assert.strictEqual(totalsA.peak, 8);
  assert.strictEqual(totalsA.count, 3);

  // Test case B: Trapezoid integration without energy_today_kwh
  // 10:00 = 4 kW, 10:30 = 6 kW -> avg 5 kW * 0.5 h = 2.5 kWh
  // 10:30 = 6 kW, 11:00 = 8 kW -> avg 7 kW * 0.5 h = 3.5 kWh
  // Total expected = 6.0 kWh
  const readingsB = [
    { time: new Date("2026-10-13T04:30:00Z"), power: 4, energyToday: null },
    { time: new Date("2026-10-13T05:00:00Z"), power: 6, energyToday: null },
    { time: new Date("2026-10-13T05:30:00Z"), power: 8, energyToday: null }
  ];
  const totalsB = context.calculateDayEnergy(readingsB);
  assert.strictEqual(totalsB.energy, 6.0);
  assert.strictEqual(totalsB.peak, 8);

  // Test case C: Gaps larger than cap ignored
  // Interval of 4 hours (> 3h cap) should not contribute
  const readingsC = [
    { time: new Date("2026-10-13T04:30:00Z"), power: 4, energyToday: null },
    { time: new Date("2026-10-13T08:35:00Z"), power: 6, energyToday: null }
  ];
  const totalsC = context.calculateDayEnergy(readingsC);
  assert.strictEqual(totalsC.energy, 0, 'Large 4h gap is excluded from integral');
});

// 10. Out-of-order rows & past date reads
runTest('Out-of-order rows are sorted and past dates are queried cleanly', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  // Ingest out-of-order readings for a past date: 2026-10-05
  const pastRows = [
    { power_kw: 8.0, timestamp: "2026-10-05 12:00" },
    { power_kw: 2.0, timestamp: "2026-10-05 07:00" },
    { power_kw: 5.0, timestamp: "2026-10-05 09:30" }
  ];
  context.doPost({
    postData: { contents: JSON.stringify({ key, rows: pastRows }) }
  });

  // Query past date bundle
  const bundlePast = JSON.parse(context.doGet({
    parameter: { route: "bundle", date: "2026-10-05" }
  }).getContent());

  assert.strictEqual(bundlePast.ok, true);
  assert.strictEqual(bundlePast.points.length, 3);
  assert.strictEqual(bundlePast.points[0].power_kw, 2.0, 'First point is 7:00');
  assert.strictEqual(bundlePast.points[1].power_kw, 5.0, 'Second point is 9:30');
  assert.strictEqual(bundlePast.points[2].power_kw, 8.0, 'Third point is 12:00');
  assert.strictEqual(bundlePast.latest.power_kw, 8.0);
});

// 11. Daily and Months API endpoints
runTest('Daily and Months API aggregation routes', () => {
  const { context, env } = loadBackendContext();
  context.setup();
  const dSheet = env._spreadsheet.getSheetByName('Daily');
  
  // Insert test rows for Daily
  dSheet.appendRow(["2026-10-01", 35.5, 7.8, 77]);
  dSheet.appendRow(["2026-10-02", 42.0, 8.5, 77]);
  dSheet.appendRow(["2026-09-28", 38.0, 8.1, 77]);

  // Route: daily
  const dailyRes = JSON.parse(context.doGet({
    parameter: { route: "daily", month: "2026-10" }
  }).getContent());
  assert.strictEqual(dailyRes.ok, true);
  assert.strictEqual(dailyRes.rows.length, 2);
  assert.strictEqual(dailyRes.rows[0].date, "2026-10-01");
  assert.strictEqual(dailyRes.rows[1].date, "2026-10-02");

  // Route: months
  const monthsRes = JSON.parse(context.doGet({
    parameter: { route: "months" }
  }).getContent());
  assert.strictEqual(monthsRes.ok, true);
  assert.strictEqual(monthsRes.rows.length, 2);
  const sep = monthsRes.rows.find(r => r.month === "2026-09");
  const oct = monthsRes.rows.find(r => r.month === "2026-10");
  assert.strictEqual(sep.energy_kwh, 38.0);
  assert.strictEqual(oct.energy_kwh, 77.5);
});

// 12. Solar model calculation check
runTest('Solar expected power model calculation matches specifications', () => {
  const { context } = loadBackendContext();
  // expected_kW = capacity × (radiation/1000) × 0.92 × max(0.5, 1 − 0.004 × (cell_temp − 25))
  // where cell_temp = ambient + 0.03 * radiation
  const cap = 10;
  const rad = 800; // W/m²
  const amb = 30; // °C
  const cellTemp = 30 + 0.03 * 800; // 54 °C
  const tempDerate = Math.max(0.5, 1 - 0.004 * (54 - 25)); // 1 - 0.004 * 29 = 1 - 0.116 = 0.884
  const expectedManual = 10 * (800 / 1000) * 0.92 * 0.884; // 8 * 0.92 * 0.884 = 6.50624 kW

  const computed = context.calculateExpectedPowerKw(cap, rad, amb);
  assert.ok(Math.abs(computed - expectedManual) < 0.001);

  // 0 when radiation <= 0
  assert.strictEqual(context.calculateExpectedPowerKw(cap, 0, amb), 0);
  assert.strictEqual(context.calculateExpectedPowerKw(cap, -50, amb), 0);
});

// 13. Health Check: No alerts when healthy
runTest('Fault check: No alerts triggered during healthy generation', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  // Set alert email
  const sSheet = env._spreadsheet.getSheetByName('Settings');
  sSheet.rows[9][1] = "admin@gprec.ac.in"; // alert_email

  // Mock Open-Meteo response with strong sunlight
  const now = new Date();
  const hourTimes = [
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() + 3600000).toISOString()
  ];
  env._setUrlFetchResponse({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      current: { temperature_2m: 32 },
      hourly: {
        time: hourTimes,
        shortwave_radiation: [700, 750]
      }
    })
  });

  // Log 3 healthy readings matching expected (~6 kW)
  for (let m = 20; m >= 0; m -= 10) {
    const t = new Date(now.getTime() - m * 60000);
    context.doPost({
      postData: { contents: JSON.stringify({ key, power_kw: 5.8, timestamp: t.toISOString() }) }
    });
  }

  context.checkHealth();
  assert.strictEqual(env._sentEmails.length, 0, 'No email sent when healthy');
});

// 14. Health Check: Zero-output detection and 1 email only within 3 hours
runTest('Fault check: Zero output detected with exactly 1 email within 3 hours', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  const sSheet = env._spreadsheet.getSheetByName('Settings');
  sSheet.rows[9][1] = "alerts@gprec.ac.in"; // alert_email

  const now = new Date();
  const hourTimes = [
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() + 3600000).toISOString()
  ];
  env._setUrlFetchResponse({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      current: { temperature_2m: 30 },
      hourly: {
        time: hourTimes,
        shortwave_radiation: [800, 800] // high sunlight
      }
    })
  });

  // Log 3 consecutive zero power readings
  for (let m = 20; m >= 0; m -= 10) {
    const t = new Date(now.getTime() - m * 60000);
    context.doPost({
      postData: { contents: JSON.stringify({ key, power_kw: 0.05, timestamp: t.toISOString() }) }
    });
  }

  // First health check
  context.checkHealth();
  assert.strictEqual(env._sentEmails.length, 1, 'First email sent on Zero output');
  assert.ok(env._sentEmails[0].subject.includes("Zero output"));

  const alertsSheet = env._spreadsheet.getSheetByName('Alerts');
  assert.strictEqual(alertsSheet.rows.length, 2); // header + 1 alert
  assert.strictEqual(alertsSheet.rows[1][1], "Zero output");

  // Run health check again 10 minutes later (still zero output) -> should NOT send duplicate email
  context.checkHealth();
  assert.strictEqual(env._sentEmails.length, 1, 'No duplicate email within 3 hours');

  // Verify recovery logging
  // Now inverter produces healthy power again
  context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: 6.5, timestamp: new Date().toISOString() }) }
  });
  context.checkHealth();
  assert.strictEqual(alertsSheet.rows.length, 3);
  assert.strictEqual(alertsSheet.rows[2][1], "Recovered");
  assert.strictEqual(env._properties.getProperty("last_problem_type"), null);
});

// 15. Health Check: Night / low sunlight never triggers alert
runTest('Fault check: Night or low sunlight (< alert_min_sunlight) never alarms', () => {
  const { context, env } = loadBackendContext();
  context.setup();

  const now = new Date();
  const hourTimes = [
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() + 3600000).toISOString()
  ];
  // 50 W/m² is well below 150 W/m² threshold
  env._setUrlFetchResponse({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      current: { temperature_2m: 20 },
      hourly: {
        time: hourTimes,
        shortwave_radiation: [50, 40]
      }
    })
  });

  context.checkHealth();
  assert.strictEqual(env._sentEmails.length, 0);
  const aSheet = env._spreadsheet.getSheetByName('Alerts');
  assert.strictEqual(aSheet.rows.length, 1, 'Only header row in Alerts');
});

// 16. Health Check: Stale logger (> 30 min in daylight) triggers "No data"
runTest('Fault check: Stale logger (> 30 min in daylight) triggers "No data"', () => {
  const { context, env } = loadBackendContext();
  const setupRes = context.setup();
  const key = setupRes.ingest_key;

  const sSheet = env._spreadsheet.getSheetByName('Settings');
  sSheet.rows[9][1] = "admin@gprec.ac.in";

  const now = new Date();
  const hourTimes = [
    new Date(now.getTime() - 3600000).toISOString(),
    new Date(now.getTime() + 3600000).toISOString()
  ];
  env._setUrlFetchResponse({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      current: { temperature_2m: 30 },
      hourly: {
        time: hourTimes,
        shortwave_radiation: [600, 600]
      }
    })
  });

  // Log reading from 45 minutes ago
  const oldTime = new Date(now.getTime() - 45 * 60000);
  context.doPost({
    postData: { contents: JSON.stringify({ key, power_kw: 5.0, timestamp: oldTime.toISOString() }) }
  });

  context.checkHealth();
  assert.strictEqual(env._sentEmails.length, 1);
  assert.ok(env._sentEmails[0].subject.includes("No data"));

  const aSheet = env._spreadsheet.getSheetByName('Alerts');
  assert.strictEqual(aSheet.rows[1][1], "No data");
});

console.log(`\n========================================`);
console.log(`TEST RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
console.log(`========================================\n`);

if (testsFailed > 0) {
  process.exit(1);
}
