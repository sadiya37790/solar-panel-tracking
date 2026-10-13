/**
 * GPREC Solar Power Monitor — Google Apps Script Backend
 * -------------------------------------------------------
 * Container-bound to a Google Sheet.
 * Deploy as a Web App: Execute as Me, Anyone (no sign-in required).
 *
 * Sheets: Readings | Daily | Settings | Alerts | Start here
 * API  : doGet  (public, read-only JSON)
 * Ingest: doPost (protected by ingest_key)
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Solar model constants – must match the frontend. */
const SOLAR = {
  EFFICIENCY:      0.92,   // panel + inverter combined efficiency
  TEMP_COEFF:      0.004,  // power loss per °C above 25 °C
  TEMP_AMBIENT_K:  0.03,   // cell temperature rise per W/m² of radiation
  REF_TEMP:        25,     // STC reference temperature (°C)
  MIN_PERF_RATIO:  0.5,    // floor on temperature derating factor
};

/** Default settings (also seeds the Settings sheet). */
const DEFAULTS = {
  plant_name:              'GPREC EEE Block 1',
  capacity_kwp:            10,
  latitude:                15.81,
  longitude:               78.05,
  start_month:             '2025-11',
  alert_drop_percent:      50,
  alert_min_sunlight:      150,   // W/m²
  alert_readings_in_a_row: 3,
  alert_email:             '',
  tariff_per_kwh:          7,
  co2_kg_per_kwh:          0.7,
  ingest_key:              '',    // generated on setup()
};

/** Sheet names */
const SN = {
  READINGS: 'Readings',
  DAILY:    'Daily',
  SETTINGS: 'Settings',
  ALERTS:   'Alerts',
  START:    'Start here',
};

/** Cache TTL (seconds) */
const CACHE_TTL = { BUNDLE: 15, OTHER: 60 };

/** Ingest: reject readings this many seconds in the future */
const FUTURE_GRACE_SEC = 600;

/** Gap threshold multipliers for trapezoid energy integration */
const GAP_MAX_SEC = 3 * 3600; // 3 hours absolute cap

// ─────────────────────────────────────────────────────────────────────────────
// MENU
// ─────────────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('☀ Solar')
    .addItem('Set up sheets',            'setup')
    .addItem('Add 30 days of SAMPLE data', 'menuSeedDemo')
    .addItem('Turn on fault checks',     'installTriggers')
    .addItem('Rebuild daily totals',     'rebuildDaily')
    .addItem('Sort readings by time',    'sortReadings')
    .addItem('Send a test email',        'sendTestEmail')
    .addItem('Show my web address and key', 'showWebAddress')
    .addToUi();
}

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates (or re-uses) all required sheets, writes default settings,
 * and generates an ingest key if one does not already exist.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Readings ──────────────────────────────────────────────────────────────
  const rSheet = getOrCreateSheet(ss, SN.READINGS);
  if (rSheet.getLastRow() === 0) {
    rSheet.appendRow([
      'Timestamp (IST)', 'Power (kW)', 'Energy today (kWh)',
      'DC voltage (V)', 'DC current (A)', 'AC voltage (V)',
      'Frequency (Hz)', 'Inverter temp (C)',
    ]);
    rSheet.setFrozenRows(1);
    rSheet.getRange('A:A').setNumberFormat('@'); // plain text timestamps
  }

  // ── Daily ─────────────────────────────────────────────────────────────────
  const dSheet = getOrCreateSheet(ss, SN.DAILY);
  if (dSheet.getLastRow() === 0) {
    dSheet.appendRow(['Date (yyyy-mm-dd)', 'Energy (kWh)', 'Peak power (kW)', 'Readings']);
    dSheet.setFrozenRows(1);
    dSheet.getRange('A:A').setNumberFormat('@');
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  const sSheet = getOrCreateSheet(ss, SN.SETTINGS);
  sSheet.clearContents();
  sSheet.appendRow(['Setting', 'Value', 'What it means']);
  sSheet.setFrozenRows(1);
  sSheet.getRange('B:B').setNumberFormat('@'); // force plain text so "2025-11" stays

  // Generate key if needed
  const existingKey = getSettingValue(SN.SETTINGS, 'ingest_key');
  const key = (existingKey && existingKey.length >= 10) ? existingKey : generateKey(20);

  const descriptions = {
    plant_name:              'Display name of your solar plant',
    capacity_kwp:            'Installed capacity in kilowatts-peak (kWp)',
    latitude:                'GPS latitude (decimal degrees, for weather lookup)',
    longitude:               'GPS longitude (decimal degrees, for weather lookup)',
    start_month:             'Month records started — format yyyy-mm, e.g. 2025-11',
    alert_drop_percent:      'Raise a "Low output" alert when power drops below this % of expected',
    alert_min_sunlight:      'Minimum sunshine (W/m²) before alerts are checked',
    alert_readings_in_a_row: 'How many consecutive low readings before alerting',
    alert_email:             'Email address to receive fault alerts (leave blank to disable)',
    tariff_per_kwh:          'Electricity price per unit (kWh) in rupees',
    co2_kg_per_kwh:          'CO₂ emissions factor in kg per kWh (grid average for your region)',
    ingest_key:              'Secret key your data logger must include when posting readings — keep this private',
  };

  const defaults2 = Object.assign({}, DEFAULTS, { ingest_key: key });
  Object.keys(defaults2).forEach(k => {
    sSheet.appendRow([k, String(defaults2[k]), descriptions[k] || '']);
  });

  // ── Alerts ────────────────────────────────────────────────────────────────
  const aSheet = getOrCreateSheet(ss, SN.ALERTS);
  if (aSheet.getLastRow() === 0) {
    aSheet.appendRow(['Time (IST)', 'Type', 'Details']);
    aSheet.setFrozenRows(1);
  }

  // ── Start here ────────────────────────────────────────────────────────────
  const guide = getOrCreateSheet(ss, SN.START);
  guide.clearContents();
  guide.getRange('A1').setValue('Welcome to the GPREC Solar Monitor ☀');
  guide.getRange('A1').setFontSize(16).setFontWeight('bold');
  guide.getRange('A3').setValue(
    'Quick start:\n' +
    '1. Edit the "Settings" sheet — especially capacity_kwp and alert_email.\n' +
    '2. Use the ☀ Solar menu → "Add 30 days of SAMPLE data" to see how the dashboard looks.\n' +
    '3. Deploy this script as a Web App (Execute as: Me, Who has access: Anyone).\n' +
    '4. Copy the /exec URL and paste it into index.html → API_URL.\n' +
    '5. Use ☀ Solar → "Turn on fault checks" to start automatic 10-minute health monitoring.\n\n' +
    'Sheets explained:\n' +
    '  Readings – every measurement from your inverter/logger\n' +
    '  Daily    – one row per day (auto-computed)\n' +
    '  Settings – all configuration knobs\n' +
    '  Alerts   – log of problems detected\n\n' +
    'Do NOT change column order in Readings or Daily — the script relies on column positions.'
  );
  guide.getRange('A3').setWrap(true);
  guide.setColumnWidth(1, 600);

  SpreadsheetApp.getUi().alert(
    '✅ Setup complete!\n\n' +
    'Your ingest key is:\n' + key + '\n\n' +
    'Keep it secret — it protects who can post data to your sheet.\n' +
    'You can find it any time in the Settings sheet.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────────────────────────────────────

function menuSeedDemo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  if (rSheet && rSheet.getLastRow() > 1) {
    const ui = SpreadsheetApp.getUi();
    const resp = ui.alert(
      'Readings already has data',
      'Adding sample data will not erase your real data, but it may mix with it. Continue?',
      ui.ButtonSet.YES_NO
    );
    if (resp !== ui.Button.YES) return;
  }
  seedDemoData(30);
  SpreadsheetApp.getUi().alert('Done! 30 days of sample data added and daily totals rebuilt.');
}

/**
 * Generates synthetic readings every 10 minutes over [days] days
 * with a bell-curve power profile and random cloud factors.
 */
function seedDemoData(days) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = getOrCreateSheet(ss, SN.READINGS);
  if (rSheet.getLastRow() === 0) setup();

  const cfg      = loadSettings();
  const capacity = cfg.capacity_kwp;
  const rows     = [];
  const now      = new Date();
  // Start [days] days ago at 00:00 IST
  const startDay = new Date(now.getTime() - days * 86400000);
  startDay.setUTCHours(0 - 5, 60 - 30, 0, 0); // 00:00 IST = 18:30 UTC prev day

  for (let d = 0; d < days; d++) {
    const cloudFactor = 0.5 + Math.random() * 0.5; // 0.5 – 1.0
    const dayStart    = new Date(startDay.getTime() + d * 86400000);
    let energyAcc     = 0;
    let prevPower     = 0;
    let prevT         = null;

    // 06:00 to 18:50 IST in 10-min steps
    for (let minFromMidnight = 360; minFromMidnight <= 1130; minFromMidnight += 10) {
      const t = new Date(dayStart.getTime() + minFromMidnight * 60000);
      if (t > now) break;

      const hourLocal  = minFromMidnight / 60; // hours since midnight IST
      const solarNoon  = 12.0;
      const halfDay    = 6.5; // daylight half-width in hours
      const relPos     = (hourLocal - solarNoon) / halfDay; // -1 to +1
      const clearSky   = Math.max(0, Math.cos(relPos * Math.PI / 2));
      // Radiation W/m²
      const radiation  = clearSky * 900 * cloudFactor + (Math.random() - 0.5) * 30;
      const radClamped = Math.max(0, radiation);
      // Solar model
      const cellTemp   = 28 + SOLAR.TEMP_AMBIENT_K * radClamped;
      const derating   = Math.max(SOLAR.MIN_PERF_RATIO, 1 - SOLAR.TEMP_COEFF * (cellTemp - SOLAR.REF_TEMP));
      const power      = capacity * (radClamped / 1000) * SOLAR.EFFICIENCY * derating * cloudFactor;
      const powerKw    = Math.max(0, +(power + (Math.random() - 0.5) * 0.05).toFixed(3));

      // Trapezoid energy
      if (prevT !== null) {
        const dtH = (t - prevT) / 3600000;
        energyAcc += ((prevPower + powerKw) / 2) * dtH;
      }
      prevPower = powerKw;
      prevT     = t;

      const dcV   = powerKw > 0.01 ? +(340 + Math.random() * 20).toFixed(1) : 0;
      const dcA   = powerKw > 0.01 ? +(powerKw * 1000 / Math.max(1, dcV)).toFixed(2) : 0;
      const acV   = powerKw > 0.01 ? +(228 + Math.random() * 6).toFixed(1) : 0;
      const freq  = powerKw > 0.01 ? +(50 + (Math.random() - 0.5) * 0.1).toFixed(2) : 0;
      const temp  = +(35 + radClamped * 0.02 + (Math.random() - 0.5) * 2).toFixed(1);

      rows.push([
        toISTString(t),
        powerKw,
        +energyAcc.toFixed(3),
        dcV, dcA, acV, freq, temp,
      ]);
    }
  }

  // Write in batches of 500
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    rSheet.getRange(rSheet.getLastRow() + 1, 1, batch.length, batch[0].length)
          .setValues(batch);
  }

  rebuildDaily();
}

// ─────────────────────────────────────────────────────────────────────────────
// doGet — PUBLIC READ-ONLY API
// ─────────────────────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const route  = params.route || 'bundle';
    const cache  = CacheService.getScriptCache();

    let cacheKey, ttl, result;

    if (route === 'ping') {
      return jsonOut({ ok: true, server_time: toISTString(new Date()) });
    }

    if (route === 'bundle') {
      const date   = params.date || '';
      cacheKey     = 'bundle:' + (date || 'today');
      ttl          = CACHE_TTL.BUNDLE;
      const cached = cache.get(cacheKey);
      if (cached) return jsonOut(JSON.parse(cached));
      result       = buildBundle(date);
    } else if (route === 'daily') {
      const month  = params.month || '';
      cacheKey     = 'daily:' + month;
      ttl          = CACHE_TTL.OTHER;
      const cached = cache.get(cacheKey);
      if (cached) return jsonOut(JSON.parse(cached));
      result       = buildDaily(month);
    } else if (route === 'months') {
      cacheKey     = 'months';
      ttl          = CACHE_TTL.OTHER;
      const cached = cache.get(cacheKey);
      if (cached) return jsonOut(JSON.parse(cached));
      result       = buildMonths();
    } else {
      return jsonOut({ ok: false, error: 'Unknown route: ' + route });
    }

    // Cache and return
    try { cache.put(cacheKey, JSON.stringify(result), ttl); } catch (_) {}
    return jsonOut(result);

  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildBundle(dateStr) {
  const cfg     = loadSettings();
  const now     = new Date();
  const targetD = dateStr ? dateStr : toDateStr(now);

  const points  = readDayPoints(targetD);       // [{t, power_kw}]
  const latest  = points.length ? points[points.length - 1] : null;

  // energy_reported_kwh: max of energy_today_kwh column for the day
  const energyReported = readDayEnergyReported(targetD);

  // Build metric array from latest raw row
  const latestRaw  = readLatestRaw();
  const metricDefs = [
    { key: 'power',        label: 'Power right now',     value: latestRaw ? latestRaw[1] : null, unit: 'kW' },
    { key: 'dc_voltage',   label: 'DC voltage',          value: latestRaw ? latestRaw[3] : null, unit: 'V'  },
    { key: 'dc_current',   label: 'DC current',          value: latestRaw ? latestRaw[4] : null, unit: 'A'  },
    { key: 'ac_voltage',   label: 'AC voltage',          value: latestRaw ? latestRaw[5] : null, unit: 'V'  },
    { key: 'frequency',    label: 'Frequency',           value: latestRaw ? latestRaw[6] : null, unit: 'Hz' },
    { key: 'inverter_temp',label: 'Inverter temperature',value: latestRaw ? latestRaw[7] : null, unit: '°C' },
  ];

  return {
    ok:         true,
    server_time: toISTString(now),
    config: {
      plant_name:              cfg.plant_name,
      capacity_kwp:            cfg.capacity_kwp,
      latitude:                cfg.latitude,
      longitude:               cfg.longitude,
      start_month:             cfg.start_month,
      alert_drop_percent:      cfg.alert_drop_percent,
      alert_min_sunlight:      cfg.alert_min_sunlight,
      alert_readings_in_a_row: cfg.alert_readings_in_a_row,
      tariff_per_kwh:          cfg.tariff_per_kwh,
      co2_kg_per_kwh:          cfg.co2_kg_per_kwh,
    },
    latest: latest ? {
      timestamp:        latest.t,
      power_kw:         latest.power_kw,
      energy_today_kwh: energyReported,
      metrics:          metricDefs,
    } : null,
    energy_reported_kwh: energyReported,
    points: points,
  };
}

function buildDaily(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return { ok: false, error: 'month must be yyyy-mm' };
  }
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheet  = ss.getSheetByName(SN.DAILY);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, rows: [] };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const rows = data
    .filter(r => String(r[0]).startsWith(month))
    .map(r => ({
      date:       String(r[0]),
      energy_kwh: toNum(r[1], 0),
      peak_kw:    toNum(r[2], 0),
    }));
  return { ok: true, rows };
}

function buildMonths() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.DAILY);
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, rows: [] };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const map  = {};
  data.forEach(r => {
    const dateStr = String(r[0]);
    const month   = dateStr.slice(0, 7);
    if (month.length === 7) {
      map[month] = (map[month] || 0) + toNum(r[1], 0);
    }
  });
  const rows = Object.keys(map).sort().map(m => ({
    month:      m,
    energy_kwh: +map[m].toFixed(3),
  }));
  return { ok: true, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// doPost — INGEST (protected by ingest_key)
// ─────────────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    // Parse body
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (_) {
      // Fall back to form parameters
      body = e.parameter || {};
    }

    const cfg = loadSettings();
    const validKey = cfg.ingest_key;

    // Key check
    const sentKey = body.key || '';
    if (!validKey || sentKey !== validKey) {
      return jsonOut({ ok: false, error: 'Invalid or missing ingest_key' });
    }

    // Batch or single
    const rawRows = Array.isArray(body.rows) ? body.rows : [body];

    if (rawRows.length > 500) {
      return jsonOut({ ok: false, error: 'Max 500 rows per request' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const result = ingestRows(rawRows, cfg);
      // Clear relevant caches
      clearBundleCache();
      return jsonOut(result);
    } finally {
      lock.releaseLock();
    }

  } catch (err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

/**
 * Validates and saves an array of raw row objects.
 * Returns { ok, saved, rejected:[{index,error}] }
 */
function ingestRows(rawRows, cfg) {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet     = ss.getSheetByName(SN.READINGS);
  const capacity   = cfg.capacity_kwp;
  const nowEpoch   = Date.now() / 1000;
  const accepted   = [];
  const rejected   = [];
  const affectedDates = new Set();

  rawRows.forEach((raw, idx) => {
    try {
      // Power: accept power_kw or power_w
      let powerKw;
      if (raw.power_kw !== undefined) {
        powerKw = toNum(raw.power_kw, null);
      } else if (raw.power_w !== undefined) {
        powerKw = toNum(raw.power_w, null) / 1000;
      } else {
        throw new Error('power_kw or power_w is required');
      }

      if (powerKw === null || isNaN(powerKw)) throw new Error('power is not a number');
      if (powerKw < 0) throw new Error('power cannot be negative');
      if (powerKw > capacity * 3) {
        throw new Error(
          `power ${powerKw} kW is over 3× capacity (${capacity} kWp). ` +
          'Is the logger sending watts? Use power_w'
        );
      }

      // Timestamp
      const ts = parseTimestamp(raw.timestamp);
      if (!ts) throw new Error('cannot parse timestamp: ' + raw.timestamp);
      if (ts.getTime() / 1000 > nowEpoch + FUTURE_GRACE_SEC) {
        throw new Error('timestamp is more than 10 minutes in the future');
      }

      const dateStr = toDateStr(ts);
      affectedDates.add(dateStr);

      accepted.push([
        toISTString(ts),
        powerKw,
        raw.energy_today_kwh !== undefined ? toNum(raw.energy_today_kwh, '') : '',
        raw.dc_voltage        !== undefined ? toNum(raw.dc_voltage, '')        : '',
        raw.dc_current        !== undefined ? toNum(raw.dc_current, '')        : '',
        raw.ac_voltage        !== undefined ? toNum(raw.ac_voltage, '')        : '',
        raw.frequency_hz      !== undefined ? toNum(raw.frequency_hz, '')      : '',
        raw.inverter_temp_c   !== undefined ? toNum(raw.inverter_temp_c, '')   : '',
      ]);

    } catch (err) {
      rejected.push({ index: idx, error: err.message });
    }
  });

  if (accepted.length) {
    rSheet.getRange(rSheet.getLastRow() + 1, 1, accepted.length, 8)
          .setValues(accepted);
    // Rebuild daily totals for affected dates
    affectedDates.forEach(d => rebuildDailyForDate(d));
  }

  return { ok: true, saved: accepted.length, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY SHEET MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full rebuild: recomputes the entire Daily sheet from Readings.
 * Called from the menu and after seedDemoData.
 */
function rebuildDaily() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  const dSheet = getOrCreateSheet(ss, SN.DAILY);

  if (!rSheet || rSheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('No readings found. Add data first.');
    return;
  }

  const data     = rSheet.getRange(2, 1, rSheet.getLastRow() - 1, 8).getValues();
  const byDate   = groupByDate(data);
  const dates    = Object.keys(byDate).sort();

  // Rebuild daily sheet
  dSheet.clearContents();
  dSheet.appendRow(['Date (yyyy-mm-dd)', 'Energy (kWh)', 'Peak power (kW)', 'Readings']);
  dSheet.setFrozenRows(1);

  const outRows = dates.map(date => {
    const rows = byDate[date];
    return computeDailyRow(date, rows);
  });

  if (outRows.length) {
    dSheet.getRange(2, 1, outRows.length, 4).setValues(outRows);
  }

  // Clear all caches
  clearAllCaches();
}

/**
 * Rebuilds the Daily row for a single date.
 * Reads only the rows for that date (binary-scan the timestamp column).
 */
function rebuildDailyForDate(dateStr) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  const dSheet = getOrCreateSheet(ss, SN.DAILY);

  if (!rSheet || rSheet.getLastRow() < 2) return;

  const data   = rSheet.getRange(2, 1, rSheet.getLastRow() - 1, 8).getValues();
  const rows   = data.filter(r => String(r[0]).startsWith(dateStr));
  if (!rows.length) return;

  const newRow = computeDailyRow(dateStr, rows);

  // Find existing row for this date in Daily
  const dData  = dSheet.getLastRow() > 1
    ? dSheet.getRange(2, 1, dSheet.getLastRow() - 1, 1).getValues()
    : [];

  let found = -1;
  for (let i = 0; i < dData.length; i++) {
    if (String(dData[i][0]) === dateStr) { found = i + 2; break; }
  }

  if (found > 0) {
    dSheet.getRange(found, 1, 1, 4).setValues([newRow]);
  } else {
    dSheet.appendRow(newRow);
    sortSheet(dSheet, 1);
  }
}

/**
 * Computes a Daily row for a given date from an array of 8-column reading rows.
 */
function computeDailyRow(dateStr, rows) {
  // Sort by timestamp
  rows.sort((a, b) => {
    const ta = parseTimestamp(String(a[0]));
    const tb = parseTimestamp(String(b[0]));
    return (ta ? ta.getTime() : 0) - (tb ? tb.getTime() : 0);
  });

  const parsed = rows
    .map(r => {
      const t = parseTimestamp(String(r[0]));
      return t ? { t, power: toNum(r[1], 0), energy: toNum(r[2], null) } : null;
    })
    .filter(Boolean);

  // Energy: use inverter's reported energy_today (max) if available
  const reportedEnergies = parsed.map(p => p.energy).filter(v => v !== null && !isNaN(v));
  let energy;
  if (reportedEnergies.length) {
    energy = Math.max(...reportedEnergies);
  } else {
    energy = trapezoidEnergy(parsed);
  }

  const peakPower = parsed.length ? Math.max(...parsed.map(p => p.power)) : 0;
  return [dateStr, +energy.toFixed(3), +peakPower.toFixed(3), parsed.length];
}

/**
 * Trapezoid integration of power over time, skipping gaps.
 */
function trapezoidEnergy(parsed) {
  if (parsed.length < 2) return 0;
  // Compute median interval
  const intervals = [];
  for (let i = 1; i < parsed.length; i++) {
    intervals.push((parsed[i].t - parsed[i-1].t) / 1000);
  }
  intervals.sort((a, b) => a - b);
  const medianSec = intervals[Math.floor(intervals.length / 2)];
  const gapLimit  = Math.min(GAP_MAX_SEC, Math.max(1800, medianSec * 3));

  let energy = 0;
  for (let i = 1; i < parsed.length; i++) {
    const dtSec = (parsed[i].t - parsed[i-1].t) / 1000;
    if (dtSec > gapLimit) continue; // skip large gaps
    const dtH = dtSec / 3600;
    energy += ((parsed[i-1].power + parsed[i].power) / 2) * dtH;
  }
  return energy;
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH CHECKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installs a time-based trigger to run checkHealth every 10 minutes.
 */
function installTriggers() {
  // Remove existing checkHealth triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'checkHealth') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkHealth').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('✅ Fault checks are now running every 10 minutes.');
}

/**
 * Main health-check function. Fetches Open-Meteo, evaluates readings,
 * logs alerts, sends email (once per incident).
 */
function checkHealth() {
  try {
    const cfg = loadSettings();
    if (!cfg.latitude || !cfg.longitude) return;

    const radiation = fetchCurrentRadiation(cfg.latitude, cfg.longitude);
    // radiation is null if the fetch failed
    if (radiation === null) return; // can't check without weather

    const minRad   = cfg.alert_min_sunlight;
    if (radiation < minRad) return; // nighttime or heavy cloud — never alarm

    const ss     = SpreadsheetApp.getActiveSpreadsheet();
    const rSheet = ss.getSheetByName(SN.READINGS);
    if (!rSheet || rSheet.getLastRow() < 2) return;

    const now     = new Date();
    const todayStr = toDateStr(now);
    // Read last 50 rows (plenty for health check)
    const lastRow = rSheet.getLastRow();
    const startR  = Math.max(2, lastRow - 49);
    const data    = rSheet.getRange(startR, 1, lastRow - startR + 1, 2).getValues();

    const recent = data
      .map(r => ({
        t:       parseTimestamp(String(r[0])),
        power:   toNum(r[1], 0),
      }))
      .filter(r => r.t && toDateStr(r.t) === todayStr)
      .sort((a, b) => a.t - b.t);

    if (!recent.length) return;

    const latestReading = recent[recent.length - 1];
    const ageMin        = (now - latestReading.t) / 60000;

    // ── No data alert ──────────────────────────────────────────────────────
    if (ageMin > 30) {
      logAndEmail(cfg, 'No data',
        `No reading for ${Math.round(ageMin)} min. Last reading: ${toISTString(latestReading.t)}`
      );
      return;
    }

    // ── Low / zero output alert ────────────────────────────────────────────
    const N           = cfg.alert_readings_in_a_row;
    const lastN       = recent.slice(-N);
    if (lastN.length < N) return; // not enough data yet

    const capacity    = cfg.capacity_kwp;
    const expected    = solarExpected(capacity, radiation, 28); // 28°C default ambient
    const threshold   = (cfg.alert_drop_percent / 100) * expected;
    const allLow      = lastN.every(r => r.power < threshold);

    if (!allLow) {
      // Recovery: clear any active alert
      clearActiveAlert(cfg);
      return;
    }

    const allZero = lastN.every(r => r.power < capacity * 0.02);
    const type    = allZero ? 'Zero output' : 'Low output';
    const detail  = `Last ${N} readings all below ${Math.round(threshold * 100) / 100} kW ` +
                    `(expected ${Math.round(expected * 100) / 100} kW, ` +
                    `radiation ${Math.round(radiation)} W/m²)`;
    logAndEmail(cfg, type, detail);

  } catch (err) {
    console.error('checkHealth error:', err.message);
  }
}

/** Fetches current radiation from Open-Meteo (W/m²), interpolating hourly data. */
function fetchCurrentRadiation(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m` +
      `&hourly=shortwave_radiation` +
      `&timezone=Asia%2FKolkata&forecast_days=1`;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());

    const times = data.hourly.time;            // ISO strings
    const rads  = data.hourly.shortwave_radiation;
    const now   = new Date();

    // Shift each hourly timestamp back 30 minutes (Open-Meteo = average of preceding hour)
    const shifted = times.map((t, i) => ({
      t:   new Date(new Date(t + ':00+05:30').getTime() - 30 * 60000),
      rad: rads[i] || 0,
    }));

    // Linear interpolation
    for (let i = 0; i < shifted.length - 1; i++) {
      if (now >= shifted[i].t && now < shifted[i+1].t) {
        const frac = (now - shifted[i].t) / (shifted[i+1].t - shifted[i].t);
        return shifted[i].rad + frac * (shifted[i+1].rad - shifted[i].rad);
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** Logs an alert and sends email (no repeat within 3 hours per problem type). */
function logAndEmail(cfg, type, detail) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const aSheet = ss.getSheetByName(SN.ALERTS);
  if (!aSheet) return;

  const now = new Date();
  // Check for recent same-type alert (within 3 hours)
  if (aSheet.getLastRow() > 1) {
    const aData = aSheet.getRange(2, 1, aSheet.getLastRow() - 1, 2).getValues();
    for (let i = aData.length - 1; i >= 0; i--) {
      const rowTime = parseTimestamp(String(aData[i][0]));
      if (!rowTime) continue;
      if ((now - rowTime) / 3600000 > 3) break;
      if (String(aData[i][1]) === type) return; // already alerted
    }
  }

  aSheet.appendRow([toISTString(now), type, detail]);

  if (cfg.alert_email) {
    try {
      MailApp.sendEmail({
        to:      cfg.alert_email,
        subject: `⚠ Solar Alert: ${type} — ${cfg.plant_name}`,
        body:    `Alert type: ${type}\n\nDetails: ${detail}\n\nTime: ${toISTString(now)}\n\n` +
                 `This is an automated alert from ${cfg.plant_name} solar monitor.`,
      });
    } catch (mailErr) {
      console.error('Email error:', mailErr.message);
    }
  }
}

/** Removes active alert if system has recovered (no action needed, just a log note). */
function clearActiveAlert(cfg) {
  // Intentionally minimal: we just stop alerting. The Alerts sheet keeps history.
}

// ─────────────────────────────────────────────────────────────────────────────
// MENU HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sortReadings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SN.READINGS);
  if (sh && sh.getLastRow() > 1) {
    sortSheet(sh, 1);
    SpreadsheetApp.getUi().alert('Readings sorted by timestamp.');
  }
}

function sendTestEmail() {
  const cfg = loadSettings();
  if (!cfg.alert_email) {
    SpreadsheetApp.getUi().alert('No alert_email set in Settings. Please add one first.');
    return;
  }
  MailApp.sendEmail({
    to:      cfg.alert_email,
    subject: `Test email from ${cfg.plant_name}`,
    body:    'If you received this, email alerts are working correctly.',
  });
  SpreadsheetApp.getUi().alert('Test email sent to ' + cfg.alert_email);
}

function showWebAddress() {
  const cfg = loadSettings();
  SpreadsheetApp.getUi().alert(
    'Web App URL:\n(Deploy this script as a Web App to get the URL)\n\n' +
    'Your ingest key:\n' + cfg.ingest_key + '\n\n' +
    'Keep the key secret — it protects who can post data.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// READING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads today's power points. Starts with newest 2500 rows and expands
 * until midnight is reached or the full sheet is read.
 */
function readDayPoints(dateStr) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  if (!rSheet || rSheet.getLastRow() < 2) return [];

  const total = rSheet.getLastRow() - 1;
  let chunkSize = Math.min(2500, total);
  let found     = false;
  let data      = [];

  while (!found && chunkSize <= total) {
    const startR = Math.max(2, rSheet.getLastRow() - chunkSize + 1);
    data = rSheet.getRange(startR, 1, rSheet.getLastRow() - startR + 1, 2).getValues();

    // Check if we've reached a row before our date
    const firstTs = parseTimestamp(String(data[0][0]));
    if (!firstTs || toDateStr(firstTs) <= dateStr) found = true;
    else chunkSize = Math.min(chunkSize * 2, total);
  }

  // Filter and sort
  const points = data
    .map(r => ({ t: parseTimestamp(String(r[0])), power_kw: toNum(r[1], 0) }))
    .filter(p => p.t && toDateStr(p.t) === dateStr)
    .sort((a, b) => a.t - b.t)
    .map(p => ({ t: toISTString(p.t), power_kw: p.power_kw }));

  return points;
}

/** Returns the max energy_today_kwh for a date, or 0. */
function readDayEnergyReported(dateStr) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  if (!rSheet || rSheet.getLastRow() < 2) return 0;

  const data = rSheet.getRange(2, 1, rSheet.getLastRow() - 1, 3).getValues();
  let max = 0;
  data.forEach(r => {
    if (String(r[0]).startsWith(dateStr)) {
      const v = toNum(r[2], 0);
      if (v > max) max = v;
    }
  });
  return max;
}

/** Returns the latest 8-column reading row, or null. */
function readLatestRaw() {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const rSheet = ss.getSheetByName(SN.READINGS);
  if (!rSheet || rSheet.getLastRow() < 2) return null;

  // Read last 10 rows, find latest by timestamp
  const startR = Math.max(2, rSheet.getLastRow() - 9);
  const data   = rSheet.getRange(startR, 1, rSheet.getLastRow() - startR + 1, 8).getValues();
  let latest   = null;
  data.forEach(r => {
    const t = parseTimestamp(String(r[0]));
    if (t && (!latest || t > parseTimestamp(String(latest[0])))) latest = r;
  });
  return latest;
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

/** Loads Settings sheet into a plain object, falling back to DEFAULTS. */
function loadSettings() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.SETTINGS);
  const cfg   = Object.assign({}, DEFAULTS);
  if (!sheet || sheet.getLastRow() < 2) return cfg;

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  data.forEach(([key, val]) => {
    const k = String(key).trim();
    if (!(k in cfg)) return;
    const raw = String(val).trim();
    if (raw === '') return; // keep default on blank

    // Numeric settings
    const numericKeys = [
      'capacity_kwp', 'latitude', 'longitude',
      'alert_drop_percent', 'alert_min_sunlight', 'alert_readings_in_a_row',
      'tariff_per_kwh', 'co2_kg_per_kwh',
    ];
    if (numericKeys.includes(k)) {
      const n = parseFloat(raw);
      cfg[k] = isNaN(n) ? cfg[k] : n; // fallback to default on garbage
    } else {
      cfg[k] = raw;
    }
  });
  return cfg;
}

/** Reads a single setting value from the Settings sheet. */
function getSettingValue(sheetName, key) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return '';
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const row  = data.find(r => String(r[0]).trim() === key);
  return row ? String(row[1]).trim() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// SOLAR MODEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected power in kW.
 * cell_temp = ambient + 0.03 × radiation
 * expected = capacity × (radiation/1000) × 0.92 × max(0.5, 1 − 0.004 × (cell_temp − 25))
 */
function solarExpected(capacityKwp, radiationWm2, ambientC) {
  if (radiationWm2 <= 0) return 0;
  const cellTemp = (ambientC || 25) + SOLAR.TEMP_AMBIENT_K * radiationWm2;
  const derating = Math.max(SOLAR.MIN_PERF_RATIO, 1 - SOLAR.TEMP_COEFF * (cellTemp - SOLAR.REF_TEMP));
  return capacityKwp * (radiationWm2 / 1000) * SOLAR.EFFICIENCY * derating;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a Date parsed from many timestamp formats, or null. All no-zone → IST. */
function parseTimestamp(raw) {
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  raw = String(raw).trim();

  // Epoch seconds or milliseconds (pure number)
  if (/^\d{10}$/.test(raw)) return new Date(parseInt(raw) * 1000);
  if (/^\d{13}$/.test(raw)) return new Date(parseInt(raw));

  // ISO with explicit zone (pass through)
  if (/[TZ+\-]\d{2}:\d{2}/.test(raw) || raw.endsWith('Z')) {
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  }

  // yyyy-mm-dd HH:MM[:SS] — treat as IST
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);
  }

  // dd/mm/yyyy HH:MM[:SS] — treat as IST
  m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);
  }

  // Google Sheets might pass a Date object serialised as a JS Date string
  const d = new Date(raw);
  return isNaN(d) ? null : d;
}

/** Formats a Date as "yyyy-mm-dd HH:MM:SS+05:30". */
function toISTString(d) {
  // Convert to IST by adding 5h30m to UTC
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth()+1)}-${pad(ist.getUTCDate())}` +
    `T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`
  );
}

/** Returns "yyyy-mm-dd" in IST for a given Date. */
function toDateStr(d) {
  return toISTString(d).slice(0, 10);
}

/** Groups raw 8-column reading rows by IST date string. */
function groupByDate(data) {
  const map = {};
  data.forEach(r => {
    const t = parseTimestamp(String(r[0]));
    if (!t) return;
    const d = toDateStr(t);
    if (!map[d]) map[d] = [];
    map[d].push(r);
  });
  return map;
}

/** Sorts a sheet by a given column (1-indexed), keeping the header row. */
function sortSheet(sheet, col) {
  if (sheet.getLastRow() < 3) return;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
       .sort({ column: col, ascending: true });
}

/** Gets a sheet by name, or creates it. */
function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** Converts a value to a number, returning fallback if not a number. */
function toNum(v, fallback) {
  const n = parseFloat(String(v));
  return isNaN(n) ? fallback : n;
}

/** Generates a random alphanumeric key of given length. */
function generateKey(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let key = '';
  for (let i = 0; i < len; i++) {
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

/** Returns a CORS-enabled JSON response. */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Clears the bundle cache key for today. */
function clearBundleCache() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove('bundle:today');
    cache.remove('bundle:' + toDateStr(new Date()));
  } catch (_) {}
}

/** Clears all known cache keys. */
function clearAllCaches() {
  try {
    const cache = CacheService.getScriptCache();
    cache.remove('bundle:today');
    cache.remove('bundle:' + toDateStr(new Date()));
    cache.remove('months');
    // Can't enumerate daily: keys are unlimited. Remove recent months.
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      const d = new Date(now.getTime() - i * 30 * 86400000);
      cache.remove('daily:' + toISTString(d).slice(0, 7));
    }
  } catch (_) {}
}
