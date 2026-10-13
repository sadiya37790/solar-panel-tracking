/**
 * ============================================================================
 * GPREC EEE Block-1 Solar — UNIFIED Apps Script
 * ============================================================================
 * Merges your existing MODBUS logger with the solar dashboard API.
 *
 * HOW TO DEPLOY
 * ─────────────
 * 1. Open your existing Apps Script project (Extensions → Apps Script in your Sheet).
 * 2. Replace ALL the code in Code.gs with this file.
 * 3. Click Save (Ctrl+S).
 * 4. Run setupDashboard() ONCE (choose it from the function drop-down, click ▶ Run).
 *    This creates a "Solar_Settings" tab in your sheet.
 * 5. Deploy → New deployment → Web app → Execute as Me → Anyone → Deploy.
 * 6. Copy the /exec URL and paste it into index.html (const API_URL = '...').
 *
 * Your MODBUS logger continues to POST to the same URL — no changes needed there.
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// TARGET SPREADSHEET (your existing sheet — DO NOT CHANGE)
// ─────────────────────────────────────────────────────────────────────────────
var SPREADSHEET_ID = "1AdBjvpwcuAPetNtZXWR1nWwQTdbLCpslQ6xWbcPr5M0";

// ─────────────────────────────────────────────────────────────────────────────
// COLUMN MAPPING
// Maps your MODBUS column headers → dashboard field names.
// Edit these if your headers differ.
// ─────────────────────────────────────────────────────────────────────────────
var COL = {
  TIMESTAMP:    "Timestamp",
  POWER_KW:     "Active_Power_kW",
  ENERGY_KWH:   "Energy_Today_kWh",
  DC_VOLTAGE:   "DC_Voltage_V",
  DC_CURRENT:   "DC_Current_A",
  AC_VOLTAGE:   "AC_Voltage_V",
  FREQUENCY:    "Frequency_Hz",
  INVERTER_TEMP:"Inverter_Temp_C"
};

// Tab name pattern: your logger sends dates as "YYYY-MM-DD"
// We find today's tab by looking for a tab named like the date.
var TAB_DATE_FORMAT = "yyyy-MM-dd";   // matches your tab names exactly

// ─────────────────────────────────────────────────────────────────────────────
// SOLAR MODEL CONSTANTS (must match index.html)
// ─────────────────────────────────────────────────────────────────────────────
var SOLAR = {
  EFFICIENCY:      0.92,
  TEMP_COEFF:      0.004,
  TEMP_AMBIENT_K:  0.03,
  REF_TEMP:        25,
  MIN_PERF_RATIO:  0.5
};

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────
var DEFAULTS = {
  plant_name:              "GPREC EEE Block 1",
  capacity_kwp:            10,
  latitude:                15.81,
  longitude:               78.05,
  start_month:             "2025-11",
  alert_drop_percent:      50,
  alert_min_sunlight:      150,
  alert_readings_in_a_row: 3,
  alert_email:             "gpreccems@gmail.com",
  tariff_per_kwh:          7,
  co2_kg_per_kwh:          0.7
};

var SETTINGS_SHEET = "Solar_Settings";
var CACHE_TTL = { BUNDLE: 15, OTHER: 60 };

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — YOUR ORIGINAL doPost (UNCHANGED)
// The MODBUS logger continues to work exactly as before.
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No POST payload received.");
    }
    var jsonString = e.postData.contents;
    var data = JSON.parse(jsonString);
    var targetSheetName = data.sheet || "Daily_Log_Default";
    var keys = data.keys || [];
    var valuesObject = data.values || {};

    var targetSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

    // Auto-archive if approaching 8M cells
    var totalCells = getTotalWorkbookCells(targetSpreadsheet);
    if (totalCells >= 8000000) {
      emailAndResetSpreadsheet(targetSpreadsheet, DEFAULTS.alert_email);
    }

    var sheet = targetSpreadsheet.getSheetByName(targetSheetName);
    if (!sheet) {
      sheet = targetSpreadsheet.insertSheet(targetSheetName);
      var defaultSheet = targetSpreadsheet.getSheetByName("Sheet1");
      if (defaultSheet && targetSpreadsheet.getSheets().length > 1) {
        targetSpreadsheet.deleteSheet(defaultSheet);
      }
      if (keys.length > 0) {
        sheet.appendRow(keys);
      }
      SpreadsheetApp.flush();
    }

    var rowData = [];
    for (var i = 0; i < keys.length; i++) {
      var val = valuesObject[keys[i]];
      rowData.push((val === null || val === "None" || val === undefined) ? "" : val);
    }
    if (rowData.length > 0) {
      sheet.appendRow(rowData);
    }

    // Clear dashboard cache for today so fresh data appears immediately
    try {
      var cache = CacheService.getScriptCache();
      var todayStr = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
      cache.remove("bundle_" + todayStr);
      cache.remove("bundle_");
    } catch(ex) { /* ignore cache errors */ }

    return ContentService.createTextOutput(JSON.stringify({
      "status": "success",
      "message": "Data logged into tab → " + targetSheetName
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      "status": "error",
      "message": error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — DASHBOARD doGet API (NEW)
// Routes: bundle | daily | months | ping
// ═══════════════════════════════════════════════════════════════════════════

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var route  = params.route || "bundle";
  var output;

  try {
    if      (route === "bundle") output = routeBundle(params);
    else if (route === "daily")  output = routeDaily(params);
    else if (route === "months") output = routeMonths();
    else if (route === "ping")   output = { ok: true, pong: new Date().toISOString() };
    else                         output = { ok: false, error: "unknown route: " + route };
  } catch (err) {
    output = { ok: false, error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(output))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: bundle
// Returns config + today's latest reading + today's points
// ─────────────────────────────────────────────────────────────────────────────
function routeBundle(params) {
  var dateStr = params.date || Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd");
  var cacheKey = "bundle_" + dateStr;
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var cfg     = loadSettings();
  var ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet   = ss.getSheetByName(dateStr);
  var points  = [];
  var latest  = null;
  var energyReported = 0;

  if (sheet) {
    var data = readSheet(sheet);
    var hdrs = data.headers;
    var rows = data.rows;

    var iTs  = hdrs.indexOf(COL.TIMESTAMP);
    var iPow = hdrs.indexOf(COL.POWER_KW);
    var iEng = hdrs.indexOf(COL.ENERGY_KWH);
    var iDcV = hdrs.indexOf(COL.DC_VOLTAGE);
    var iDcI = hdrs.indexOf(COL.DC_CURRENT);
    var iAcV = hdrs.indexOf(COL.AC_VOLTAGE);
    var iFreq= hdrs.indexOf(COL.FREQUENCY);
    var iTemp= hdrs.indexOf(COL.INVERTER_TEMP);

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var tsRaw = (iTs >= 0) ? row[iTs] : null;
      var powRaw= (iPow >= 0)? row[iPow]: null;
      if (!tsRaw && powRaw === null) continue;

      var tsDate = parseTimestamp(tsRaw);
      var powKw  = parseFloat(powRaw);
      if (!tsDate || isNaN(powKw) || powKw < 0) continue;

      var tsIso = formatIST(tsDate);
      points.push({ t: tsIso, power_kw: powKw });

      var engVal = (iEng >= 0) ? parseFloat(row[iEng]) : NaN;
      if (!isNaN(engVal) && engVal > energyReported) energyReported = engVal;
    }

    // Sort by time
    points.sort(function(a, b) { return a.t < b.t ? -1 : 1; });

    if (points.length > 0) {
      var last = points[points.length - 1];
      var lastRow = rows.filter(function(row) {
        return row[iTs] && formatIST(parseTimestamp(row[iTs])) === last.t;
      })[0] || rows[rows.length - 1];

      var metrics = [];
      var addM = function(key, label, idx, unit) {
        var v = (idx >= 0) ? parseFloat(lastRow[idx]) : NaN;
        metrics.push({ key: key, label: label, value: isNaN(v) ? null : v, unit: unit });
      };
      addM("power",         "Power",             iPow,  "kW");
      addM("dc_voltage",    "DC Voltage",         iDcV,  "V");
      addM("dc_current",    "DC Current",         iDcI,  "A");
      addM("ac_voltage",    "AC Voltage",         iAcV,  "V");
      addM("frequency",     "Frequency",          iFreq, "Hz");
      addM("inverter_temp", "Inverter Temp",      iTemp, "°C");

      latest = {
        timestamp:        last.t,
        power_kw:         last.power_kw,
        energy_today_kwh: energyReported || null,
        metrics:          metrics
      };
    }
  }

  var result = {
    ok:                  true,
    server_time:         formatIST(new Date()),
    config:              cfg,
    latest:              latest,
    energy_reported_kwh: energyReported || 0,
    points:              points
  };

  cache.put(cacheKey, JSON.stringify(result), CACHE_TTL.BUNDLE);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: daily — returns daily rows for a given month
// ─────────────────────────────────────────────────────────────────────────────
function routeDaily(params) {
  var month = params.month; // "yyyy-MM"
  if (!month) return { ok: false, error: "month param required (yyyy-MM)" };

  var cacheKey = "daily_" + month;
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheets = ss.getSheets();
  var rows   = [];

  sheets.forEach(function(sh) {
    var name = sh.getName();
    if (!name.startsWith(month)) return; // e.g. "2025-11-01" starts with "2025-11"
    var data  = readSheet(sh);
    var hdrs  = data.headers;
    var sRows = data.rows;
    var iPow  = hdrs.indexOf(COL.POWER_KW);
    var iEng  = hdrs.indexOf(COL.ENERGY_KWH);

    var energyKwh = 0;
    var peakKw    = 0;
    var maxEngReported = 0;

    sRows.forEach(function(row) {
      var pv = parseFloat(row[iPow]);
      if (!isNaN(pv) && pv > peakKw) peakKw = pv;
      var ev = parseFloat(row[iEng]);
      if (!isNaN(ev) && ev > maxEngReported) maxEngReported = ev;
    });

    if (maxEngReported > 0) {
      energyKwh = maxEngReported;
    } else {
      energyKwh = trapezoidEnergy(sh, hdrs);
    }

    if (peakKw > 0 || energyKwh > 0) {
      rows.push({ date: name, energy_kwh: energyKwh, peak_kw: peakKw });
    }
  });

  rows.sort(function(a, b) { return a.date < b.date ? -1 : 1; });
  var result = { ok: true, rows: rows };
  cache.put(cacheKey, JSON.stringify(result), CACHE_TTL.OTHER);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: months — returns monthly totals aggregated from all daily tabs
// ─────────────────────────────────────────────────────────────────────────────
function routeMonths() {
  var cacheKey = "months_all";
  var cache    = CacheService.getScriptCache();
  var cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var ss      = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheets  = ss.getSheets();
  var monthly = {}; // { "2025-11": { energy_kwh: X } }

  sheets.forEach(function(sh) {
    var name = sh.getName();
    // Accept tabs named YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return;
    var month = name.substring(0, 7); // "YYYY-MM"

    var data   = readSheet(sh);
    var hdrs   = data.headers;
    var sRows  = data.rows;
    var iEng   = hdrs.indexOf(COL.ENERGY_KWH);
    var iPow   = hdrs.indexOf(COL.POWER_KW);

    var maxEng = 0;
    sRows.forEach(function(row) {
      var ev = parseFloat(row[iEng]);
      if (!isNaN(ev) && ev > maxEng) maxEng = ev;
    });

    var dayEnergy = maxEng > 0 ? maxEng : trapezoidEnergy(sh, hdrs);

    if (!monthly[month]) monthly[month] = { energy_kwh: 0 };
    monthly[month].energy_kwh += dayEnergy;
  });

  var rows = Object.keys(monthly).sort().map(function(m) {
    return { month: m, energy_kwh: monthly[m].energy_kwh };
  });

  var result = { ok: true, rows: rows };
  cache.put(cacheKey, JSON.stringify(result), CACHE_TTL.OTHER);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

function loadSettings() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  var cfg   = JSON.parse(JSON.stringify(DEFAULTS)); // clone defaults
  if (!sheet) return cfg;

  var rows = sheet.getDataRange().getValues();
  rows.forEach(function(row) {
    var key = String(row[0]).trim();
    var val = row[1];
    if (!key || !(key in cfg)) return;
    var def = DEFAULTS[key];
    if (typeof def === "number") {
      var n = parseFloat(val);
      cfg[key] = isNaN(n) ? def : n;
    } else {
      cfg[key] = (val !== null && val !== undefined && val !== "") ? String(val) : def;
    }
  });
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time setup: create Solar_Settings tab if it doesn't exist
// ─────────────────────────────────────────────────────────────────────────────
function setupDashboard() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
  }

  var descriptions = {
    plant_name:              "Name shown at the top of the dashboard",
    capacity_kwp:            "Total panel capacity in kilowatts-peak",
    latitude:                "GPS latitude (for weather)",
    longitude:               "GPS longitude (for weather)",
    start_month:             "Oldest month in history chart (yyyy-mm)",
    alert_drop_percent:      "Alert if output < this % of expected",
    alert_min_sunlight:      "Minimum W/m² sunshine before alerts fire",
    alert_readings_in_a_row: "Consecutive low readings before alerting",
    alert_email:             "Email to notify on faults (leave blank to disable)",
    tariff_per_kwh:          "Electricity price in rupees per kWh",
    co2_kg_per_kwh:          "kg CO2 avoided per kWh generated"
  };

  // Header row
  sheet.getRange(1, 1, 1, 3).setValues([["Setting", "Value", "What it means"]]);
  sheet.getRange(1, 1, 1, 3).setFontWeight("bold");

  var data = Object.keys(DEFAULTS).map(function(k) {
    return [k, DEFAULTS[k], descriptions[k] || ""];
  });
  sheet.getRange(2, 1, data.length, 3).setValues(data);

  // Format value column as plain text
  sheet.getRange(2, 2, data.length, 1).setNumberFormat("@");
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 150);
  sheet.setColumnWidth(3, 350);
  sheet.setFrozenRows(1);

  SpreadsheetApp.getUi().alert(
    "Solar_Settings tab created!\n\n" +
    "Customise the values there, then:\n" +
    "Deploy → New deployment → Web app → Execute as Me → Anyone → Deploy.\n" +
    "Copy the /exec URL into index.html."
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read a sheet and return {headers, rows} — both as string arrays.
 */
function readSheet(sheet) {
  if (sheet.getLastRow() < 1) return { headers: [], rows: [] };
  var all  = sheet.getDataRange().getValues();
  return {
    headers: all[0].map(function(h) { return String(h).trim(); }),
    rows:    all.slice(1)
  };
}

/**
 * Trapezoid energy integration (kWh) from a sheet.
 * Uses the Power column. Skips gaps > 3 hours.
 */
function trapezoidEnergy(sheet, headers) {
  var GAP_MAX_MS = 3 * 3600 * 1000;
  var MIN_GAP_MS = 100; // ignore duplicate timestamps
  var data = readSheet(sheet);
  var hdrs = data.headers.length ? data.headers : headers;
  var rows = data.rows;

  var iTs  = hdrs.indexOf(COL.TIMESTAMP);
  var iPow = hdrs.indexOf(COL.POWER_KW);
  if (iTs < 0 || iPow < 0 || rows.length < 2) return 0;

  var points = [];
  rows.forEach(function(row) {
    var ts = parseTimestamp(row[iTs]);
    var pw = parseFloat(row[iPow]);
    if (ts && !isNaN(pw) && pw >= 0) points.push({ t: ts.getTime(), p: pw });
  });
  points.sort(function(a, b) { return a.t - b.t; });

  var energy = 0;
  for (var i = 1; i < points.length; i++) {
    var dtMs = points[i].t - points[i-1].t;
    if (dtMs < MIN_GAP_MS || dtMs > GAP_MAX_MS) continue;
    energy += (points[i].p + points[i-1].p) / 2 * (dtMs / 3600000);
  }
  return energy;
}

/**
 * Parse a timestamp from various formats → Date or null.
 * Treats bare date-time strings (no zone) as IST (+05:30).
 */
function parseTimestamp(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw;

  // Google Sheets may return a Date object for timestamp cells
  var s = String(raw).trim();
  if (!s) return null;

  // Already a JS date serial (number)
  var n = Number(s);
  if (!isNaN(n) && n > 0) {
    if (n < 1e10) return new Date(n * 1000);       // epoch seconds
    if (n < 1e13) return new Date(n);              // epoch ms
  }

  // ISO with zone — parse directly
  if (/[+-]\d{2}:\d{2}$|Z$/.test(s)) {
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  // "yyyy-MM-dd HH:mm:ss" or "yyyy-MM-dd HH:mm" → treat as IST
  var m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)/);
  if (m) {
    var d2 = new Date(m[1] + "T" + m[2].substring(0, 5) + ":00+05:30");
    return isNaN(d2) ? null : d2;
  }

  // dd/mm/yyyy HH:mm
  var m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/);
  if (m2) {
    var d3 = new Date(m2[3] + "-" + m2[2] + "-" + m2[1] + "T" + m2[4] + ":00+05:30");
    return isNaN(d3) ? null : d3;
  }

  return null;
}

/**
 * Format a Date as IST ISO string (with +05:30 suffix).
 */
function formatIST(date) {
  return Utilities.formatDate(date, "Asia/Kolkata", "yyyy-MM-dd'T'HH:mm:ss'+05:30'");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers from original script (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function getTotalWorkbookCells(ss) {
  var sheets = ss.getSheets();
  var total  = 0;
  sheets.forEach(function(sh) {
    total += sh.getMaxRows() * sh.getMaxColumns();
  });
  return total;
}

function emailAndResetSpreadsheet(ss, recipientEmail) {
  var sheetName = ss.getName();
  var dateStr   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HH-mm");
  var url       = "https://docs.google.com/spreadsheets/d/" + ss.getId() + "/export?format=xlsx";
  var params    = {
    method:  "GET",
    headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  var response = UrlFetchApp.fetch(url, params);
  var blob     = response.getBlob().setName(sheetName + "_Full_Archive_" + dateStr + ".xlsx");
  var subject  = "CEMS Automated Archive: " + sheetName + " (" + dateStr + ")";
  var body     = "The target Google Sheet reached cell capacity (8,000,000 cells).\n\n" +
                 "Attached is the full exported Excel backup.\n" +
                 "The live spreadsheet has been cleared and reset for continuous logging.";
  GmailApp.sendEmail(recipientEmail, subject, body, { attachments: [blob] });

  var tempSheet = ss.insertSheet("Sheet1");
  var sheets    = ss.getSheets();
  sheets.forEach(function(sh) {
    if (sh.getName() !== "Sheet1") ss.deleteSheet(sh);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom menu
// ─────────────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("☀ Solar Dashboard")
    .addItem("Set up dashboard settings tab", "setupDashboard")
    .addItem("Clear API cache (force refresh)", "clearAllCache")
    .addToUi();
}

function clearAllCache() {
  CacheService.getScriptCache().removeAll(
    ["bundle_", "months_all"].concat(
      // Clear today + last 7 days of bundle cache
      (function() {
        var keys = [];
        for (var i = 0; i < 7; i++) {
          var d = new Date();
          d.setDate(d.getDate() - i);
          keys.push("bundle_" + Utilities.formatDate(d, "Asia/Kolkata", "yyyy-MM-dd"));
          keys.push("daily_"  + Utilities.formatDate(d, "Asia/Kolkata", "yyyy-MM"));
        }
        return keys;
      })()
    )
  );
  SpreadsheetApp.getUi().alert("Cache cleared! Next page load will fetch fresh data.");
}
