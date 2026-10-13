/**
 * Solar Power Monitoring Backend - Google Apps Script
 * Plant: GPREC EEE Block 1 (Kurnool, Andhra Pradesh, India)
 * Container-bound to Google Sheets
 */

// Default configuration settings
var DEFAULTS = {
  plant_name: "GPREC EEE Block 1",
  capacity_kwp: 10,
  latitude: 15.81,
  longitude: 78.05,
  start_month: "2025-11",
  alert_drop_percent: 50,
  alert_min_sunlight: 150,
  alert_readings_in_a_row: 3,
  alert_email: "",
  tariff_per_kwh: 7,
  co2_kg_per_kwh: 0.7,
  ingest_key: ""
};

var IST_OFFSET_MS = 19800000; // 5 hours 30 minutes in milliseconds

/**
 * Menu trigger when spreadsheet opens
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Solar")
    .addItem("Set up sheets", "setup")
    .addItem("Add 30 days of SAMPLE data", "seedDemoDataMenu")
    .addItem("Turn on fault checks", "installTriggers")
    .addItem("Rebuild daily totals", "rebuildDailyMenu")
    .addItem("Sort readings by time", "sortReadingsMenu")
    .addItem("Send a test email", "sendTestEmailMenu")
    .addItem("Show my web address and key", "showWebAddressAndKey")
    .addToUi();
}

/**
 * Helper to format date into explicit IST ISO string: YYYY-MM-DDTHH:mm:ss+05:30
 */
function formatIsoIST(d) {
  if (!d || isNaN(d.getTime())) return "";
  var istDate = new Date(d.getTime() + IST_OFFSET_MS);
  var pad = function(n) { return (n < 10 ? "0" : "") + n; };
  var yyyy = istDate.getUTCFullYear();
  var mm = pad(istDate.getUTCMonth() + 1);
  var dd = pad(istDate.getUTCDate());
  var hh = pad(istDate.getUTCHours());
  var mi = pad(istDate.getUTCMinutes());
  var ss = pad(istDate.getUTCSeconds());
  return yyyy + "-" + mm + "-" + dd + "T" + hh + ":" + mi + ":" + ss + "+05:30";
}

/**
 * Helper to get IST date string YYYY-MM-DD
 */
function getISTDateString(d) {
  if (!d || isNaN(d.getTime())) return "";
  var istDate = new Date(d.getTime() + IST_OFFSET_MS);
  var pad = function(n) { return (n < 10 ? "0" : "") + n; };
  return istDate.getUTCFullYear() + "-" + pad(istDate.getUTCMonth() + 1) + "-" + pad(istDate.getUTCDate());
}

/**
 * Parses diverse timestamp formats into a valid JS Date (UTC timestamp).
 * Anything with no timezone is treated as IST (UTC+5:30).
 */
function parseTimestampToDate(raw) {
  if (!raw && raw !== 0) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;

  // Epoch numbers or numeric strings
  if (typeof raw === "number" || (/^\d+$/.test(String(raw).trim()))) {
    var num = Number(raw);
    if (String(num).length === 10) return new Date(num * 1000);
    if (String(num).length === 13) return new Date(num);
  }

  var s = String(raw).trim();

  // Explicit ISO with offset or Z (e.g. 2026-10-13T11:45:00+05:30 or 2026-10-13T06:15:00Z)
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) {
    var parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // yyyy-mm-dd hh:mm[:ss] without timezone -> treat as IST
  var mYmd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (mYmd) {
    var y = parseInt(mYmd[1], 10);
    var m = parseInt(mYmd[2], 10) - 1;
    var d = parseInt(mYmd[3], 10);
    var hh = parseInt(mYmd[4], 10);
    var mm = parseInt(mYmd[5], 10);
    var ss = mYmd[6] ? parseInt(mYmd[6], 10) : 0;
    // Calculate UTC epoch by subtracting IST offset (+5:30 = 330 min = 19,800,000 ms)
    var utcEpoch = Date.UTC(y, m, d, hh, mm, ss) - IST_OFFSET_MS;
    return new Date(utcEpoch);
  }

  // dd/mm/yyyy hh:mm[:ss] without timezone -> treat as IST
  var mDmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (mDmy) {
    var dd = parseInt(mDmy[1], 10);
    var mon = parseInt(mDmy[2], 10) - 1;
    var yr = parseInt(mDmy[3], 10);
    var h = parseInt(mDmy[4], 10);
    var min = parseInt(mDmy[5], 10);
    var sec = mDmy[6] ? parseInt(mDmy[6], 10) : 0;
    var utcEpochDmy = Date.UTC(yr, mon, dd, h, min, sec) - IST_OFFSET_MS;
    return new Date(utcEpochDmy);
  }

  // Fallback Date parser
  var fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Generate random alphanumeric key
 */
function generateRandomKey(length) {
  var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var result = "";
  for (var i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Read settings defensively from Settings sheet
 */
function getSettings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Settings");
  var settings = Object.assign({}, DEFAULTS);

  if (!sheet) return settings;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0]).trim();
    var val = data[i][1];
    if (!key) continue;

    if (key === "plant_name") {
      settings.plant_name = String(val).trim() || DEFAULTS.plant_name;
    } else if (key === "capacity_kwp") {
      var n = parseFloat(val);
      settings.capacity_kwp = (!isNaN(n) && n > 0) ? n : DEFAULTS.capacity_kwp;
    } else if (key === "latitude") {
      var lat = parseFloat(val);
      settings.latitude = (!isNaN(lat) && lat >= -90 && lat <= 90) ? lat : DEFAULTS.latitude;
    } else if (key === "longitude") {
      var lon = parseFloat(val);
      settings.longitude = (!isNaN(lon) && lon >= -180 && lon <= 180) ? lon : DEFAULTS.longitude;
    } else if (key === "start_month") {
      var sm = String(val).trim();
      settings.start_month = /^\d{4}-\d{2}$/.test(sm) ? sm : DEFAULTS.start_month;
    } else if (key === "alert_drop_percent") {
      var adp = parseFloat(val);
      settings.alert_drop_percent = (!isNaN(adp) && adp > 0 && adp <= 100) ? adp : DEFAULTS.alert_drop_percent;
    } else if (key === "alert_min_sunlight") {
      var ams = parseFloat(val);
      settings.alert_min_sunlight = (!isNaN(ams) && ams >= 0) ? ams : DEFAULTS.alert_min_sunlight;
    } else if (key === "alert_readings_in_a_row") {
      var arr = parseInt(val, 10);
      settings.alert_readings_in_a_row = (!isNaN(arr) && arr >= 1) ? arr : DEFAULTS.alert_readings_in_a_row;
    } else if (key === "alert_email") {
      settings.alert_email = String(val).trim();
    } else if (key === "tariff_per_kwh") {
      var tar = parseFloat(val);
      settings.tariff_per_kwh = (!isNaN(tar) && tar >= 0) ? tar : DEFAULTS.tariff_per_kwh;
    } else if (key === "co2_kg_per_kwh") {
      var co2 = parseFloat(val);
      settings.co2_kg_per_kwh = (!isNaN(co2) && co2 >= 0) ? co2 : DEFAULTS.co2_kg_per_kwh;
    } else if (key === "ingest_key") {
      settings.ingest_key = String(val).trim();
    }
  }

  return settings;
}

/**
 * Setup function: creates and formats required sheets with frozen header rows.
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Readings Sheet
  var readingsSheet = ss.getSheetByName("Readings");
  if (!readingsSheet) {
    readingsSheet = ss.insertSheet("Readings");
  }
  var readingsHeaders = [
    "Timestamp (IST)", "Power (kW)", "Energy today (kWh)",
    "DC voltage (V)", "DC current (A)", "AC voltage (V)",
    "Frequency (Hz)", "Inverter temp (C)"
  ];
  if (readingsSheet.getLastRow() === 0) {
    readingsSheet.appendRow(readingsHeaders);
  } else {
    readingsSheet.getRange(1, 1, 1, readingsHeaders.length).setValues([readingsHeaders]);
  }
  readingsSheet.setFrozenRows(1);

  // 2. Daily Sheet
  var dailySheet = ss.getSheetByName("Daily");
  if (!dailySheet) {
    dailySheet = ss.insertSheet("Daily");
  }
  var dailyHeaders = ["Date (text yyyy-mm-dd)", "Energy (kWh)", "Peak power (kW)", "Readings"];
  if (dailySheet.getLastRow() === 0) {
    dailySheet.appendRow(dailyHeaders);
  } else {
    dailySheet.getRange(1, 1, 1, dailyHeaders.length).setValues([dailyHeaders]);
  }
  dailySheet.setFrozenRows(1);
  dailySheet.getRange("A:A").setNumberFormat("@");

  // 3. Settings Sheet
  var settingsSheet = ss.getSheetByName("Settings");
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet("Settings");
  }
  var settingsHeaders = ["Setting", "Value", "What it means"];
  settingsSheet.getRange("B:B").setNumberFormat("@"); // Format value column as plain text

  // Read existing keys if any
  var existing = {};
  if (settingsSheet.getLastRow() > 1) {
    var sData = settingsSheet.getDataRange().getValues();
    for (var r = 1; r < sData.length; r++) {
      existing[String(sData[r][0]).trim()] = sData[r][1];
    }
  }

  var ingestKey = existing["ingest_key"] || generateRandomKey(20);

  var defaultRows = [
    ["plant_name", existing["plant_name"] || DEFAULTS.plant_name, "Human-friendly plant display name"],
    ["capacity_kwp", existing["capacity_kwp"] || String(DEFAULTS.capacity_kwp), "Peak rated solar DC capacity in kWp"],
    ["latitude", existing["latitude"] || String(DEFAULTS.latitude), "Latitude coordinate for solar irradiance calculation"],
    ["longitude", existing["longitude"] || String(DEFAULTS.longitude), "Longitude coordinate for solar irradiance calculation"],
    ["start_month", existing["start_month"] || DEFAULTS.start_month, "Start month for historical records (yyyy-mm plain text)"],
    ["alert_drop_percent", existing["alert_drop_percent"] || String(DEFAULTS.alert_drop_percent), "Drop % below expected power that triggers an alert"],
    ["alert_min_sunlight", existing["alert_min_sunlight"] || String(DEFAULTS.alert_min_sunlight), "Minimum sunlight (W/m²) needed before triggering fault alarms"],
    ["alert_readings_in_a_row", existing["alert_readings_in_a_row"] || String(DEFAULTS.alert_readings_in_a_row), "Number of consecutive low readings required for alert"],
    ["alert_email", existing["alert_email"] || "", "Email address for alerts (leave blank to disable email)"],
    ["tariff_per_kwh", existing["tariff_per_kwh"] || String(DEFAULTS.tariff_per_kwh), "Electricity tariff in ₹/kWh for financial savings"],
    ["co2_kg_per_kwh", existing["co2_kg_per_kwh"] || String(DEFAULTS.co2_kg_per_kwh), "CO2 avoided in kg per kWh produced"],
    ["ingest_key", ingestKey, "Secret 20-character key for data logging (keep confidential)"]
  ];

  settingsSheet.clear();
  settingsSheet.appendRow(settingsHeaders);
  settingsSheet.getRange(2, 1, defaultRows.length, 3).setValues(defaultRows);
  settingsSheet.setFrozenRows(1);
  settingsSheet.getRange("B:B").setNumberFormat("@");

  // 4. Alerts Sheet
  var alertsSheet = ss.getSheetByName("Alerts");
  if (!alertsSheet) {
    alertsSheet = ss.insertSheet("Alerts");
  }
  var alertsHeaders = ["Time", "Type", "Details"];
  if (alertsSheet.getLastRow() === 0) {
    alertsSheet.appendRow(alertsHeaders);
  } else {
    alertsSheet.getRange(1, 1, 1, alertsHeaders.length).setValues([alertsHeaders]);
  }
  alertsSheet.setFrozenRows(1);

  // 5. Start here Sheet
  var guideSheet = ss.getSheetByName("Start here");
  if (!guideSheet) {
    guideSheet = ss.insertSheet("Start here", 0);
  }
  guideSheet.clear();
  var guideContent = [
    ["☀️ Solar Monitoring System - GPREC EEE Block 1", ""],
    ["", ""],
    ["Sheet", "Purpose"],
    ["Start here", "This quick start guide and overview."],
    ["Readings", "Real-time raw telemetry log from inverter (timestamp, power, voltages, etc.)."],
    ["Daily", "Automatic daily totals (energy, peak power, reading counts). Rebuilt automatically."],
    ["Settings", "Plant configuration, alert limits, tariff, and secret ingest key. All plain text."],
    ["Alerts", "Log of detected problems (Zero output, Low output, No data) and resolution times."],
    ["", ""],
    ["How to Log Data", ""],
    ["1. Web App URL", "Deploy as Web App (Execute as: Me, Who has access: Anyone)."],
    ["2. POST endpoint", "Send JSON: {\"key\":\"" + ingestKey + "\", \"power_kw\": 7.85}"],
    ["3. Solar Menu", "Use the 'Solar' menu at top to rebuild totals, add sample data, or test emails."]
  ];
  guideSheet.getRange(1, 1, guideContent.length, 2).setValues(guideContent);
  guideSheet.setFrozenRows(1);

  if (SpreadsheetApp.getActiveSpreadsheet().getSheets().length > 0) {
    SpreadsheetApp.setActiveSheet(guideSheet);
  }

  return { ok: true, ingest_key: ingestKey };
}

/**
 * Cache invalidation helper
 */
function clearApiCache(affectedDates) {
  var cache = CacheService.getScriptCache();
  var keys = ["bundle_latest", "months_all"];
  if (affectedDates && affectedDates.length > 0) {
    for (var i = 0; i < affectedDates.length; i++) {
      var d = affectedDates[i];
      keys.push("bundle_" + d);
      keys.push("daily_" + d.substring(0, 7));
    }
  }
  try {
    cache.removeAll(keys);
  } catch (err) {
    // If removeAll is not supported in some environments, remove individually
    for (var j = 0; j < keys.length; j++) {
      try { cache.remove(keys[j]); } catch (e) {}
    }
  }
}

/**
 * Ingest API (doPost)
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    acquired = lock.waitLock(20000);
  } catch (ex) {
    acquired = false;
  }

  if (!acquired) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Server busy. Could not acquire lock, please retry."
    })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (jsonErr) {
        payload = e.parameter || {};
      }
    } else if (e && e.parameter) {
      payload = e.parameter;
    }

    var settings = getSettings();
    var key = payload.key || (e && e.parameter && e.parameter.key);

    if (!key || key !== settings.ingest_key) {
      return ContentService.createTextOutput(JSON.stringify({
        ok: false,
        error: "Unauthorized: Invalid ingest key."
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var rawRows = [];
    if (Array.isArray(payload.rows)) {
      rawRows = payload.rows.slice(0, 500); // capped at 500
    } else {
      rawRows = [payload];
    }

    var now = new Date();
    var nowEpoch = now.getTime();
    var maxFutureEpoch = nowEpoch + 10 * 60 * 1000; // max 10 minutes in the future

    var savedRows = [];
    var rejectedList = [];
    var affectedDatesMap = {};

    var capacityKwp = settings.capacity_kwp;
    var maxPowerKw = capacityKwp * 3;

    for (var idx = 0; idx < rawRows.length; idx++) {
      var item = rawRows[idx];
      var itemPower = item.power_kw !== undefined ? item.power_kw : item.power;

      // Check power_w conversion
      if (itemPower === undefined && item.power_w !== undefined) {
        var pw = parseFloat(item.power_w);
        if (!isNaN(pw)) {
          itemPower = pw / 1000;
        }
      }

      if (itemPower === undefined || itemPower === null || String(itemPower).trim() === "") {
        rejectedList.push({ index: idx, error: "Missing power reading." });
        continue;
      }

      var powerKw = parseFloat(itemPower);
      if (isNaN(powerKw) || powerKw < 0) {
        rejectedList.push({ index: idx, error: "Power must be a non-negative number." });
        continue;
      }

      if (powerKw > maxPowerKw) {
        rejectedList.push({
          index: idx,
          error: "Power exceeds 3x capacity (" + maxPowerKw + " kW). Is the logger sending watts? Use power_w"
        });
        continue;
      }

      var dt = item.timestamp ? parseTimestampToDate(item.timestamp) : now;
      if (!dt || isNaN(dt.getTime())) {
        rejectedList.push({ index: idx, error: "Invalid timestamp format." });
        continue;
      }

      if (dt.getTime() > maxFutureEpoch) {
        rejectedList.push({ index: idx, error: "Timestamp is more than 10 minutes in the future." });
        continue;
      }

      var istIso = formatIsoIST(dt);
      var istDateStr = getISTDateString(dt);
      affectedDatesMap[istDateStr] = true;

      var energyToday = (item.energy_today_kwh !== undefined && item.energy_today_kwh !== "") ? parseFloat(item.energy_today_kwh) : "";
      var dcV = (item.dc_voltage !== undefined && item.dc_voltage !== "") ? parseFloat(item.dc_voltage) : "";
      var dcA = (item.dc_current !== undefined && item.dc_current !== "") ? parseFloat(item.dc_current) : "";
      var acV = (item.ac_voltage !== undefined && item.ac_voltage !== "") ? parseFloat(item.ac_voltage) : "";
      var freq = (item.frequency_hz !== undefined && item.frequency_hz !== "") ? parseFloat(item.frequency_hz) : (item.frequency !== undefined ? parseFloat(item.frequency) : "");
      var temp = (item.inverter_temp_c !== undefined && item.inverter_temp_c !== "") ? parseFloat(item.inverter_temp_c) : (item.inverter_temp !== undefined ? parseFloat(item.inverter_temp) : "");

      savedRows.push([
        istIso,
        powerKw,
        energyToday !== "" && !isNaN(energyToday) ? energyToday : "",
        dcV !== "" && !isNaN(dcV) ? dcV : "",
        dcA !== "" && !isNaN(dcA) ? dcA : "",
        acV !== "" && !isNaN(acV) ? acV : "",
        freq !== "" && !isNaN(freq) ? freq : "",
        temp !== "" && !isNaN(temp) ? temp : ""
      ]);
    }

    if (savedRows.length > 0) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var readingsSheet = ss.getSheetByName("Readings");
      if (!readingsSheet) {
        setup();
        readingsSheet = ss.getSheetByName("Readings");
      }
      var lastRow = readingsSheet.getLastRow();
      readingsSheet.getRange(lastRow + 1, 1, savedRows.length, 8).setValues(savedRows);

      // Update Daily sheet for each affected date
      var affectedDates = Object.keys(affectedDatesMap);
      for (var dIdx = 0; dIdx < affectedDates.length; dIdx++) {
        updateDailyRowForDate(affectedDates[dIdx]);
      }

      clearApiCache(affectedDates);
    }

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      saved: savedRows.length,
      rejected: rejectedList
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: "Ingest error: " + err.message
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Computes energy for a list of readings for a single day.
 * If energy_today_kwh is present, uses max(energy_today_kwh).
 * Otherwise trapezoid integration ignoring gaps > max(30 min, 3*median, capped at 3h).
 */
function calculateDayEnergy(readings) {
  if (!readings || readings.length === 0) return { energy: 0, peak: 0, count: 0 };

  // Sort chronologically
  readings.sort(function(a, b) {
    return a.time.getTime() - b.time.getTime();
  });

  var count = readings.length;
  var maxReportedEnergy = -1;
  var peakPower = 0;

  for (var i = 0; i < readings.length; i++) {
    var r = readings[i];
    if (r.power > peakPower) peakPower = r.power;
    if (r.energyToday !== null && r.energyToday !== undefined && !isNaN(r.energyToday)) {
      if (r.energyToday > maxReportedEnergy) {
        maxReportedEnergy = r.energyToday;
      }
    }
  }

  if (maxReportedEnergy >= 0) {
    return {
      energy: Math.round(maxReportedEnergy * 100) / 100,
      peak: Math.round(peakPower * 100) / 100,
      count: count
    };
  }

  // Trapezoid integration
  if (readings.length < 2) {
    return {
      energy: 0,
      peak: Math.round(peakPower * 100) / 100,
      count: count
    };
  }

  // Calculate median interval in minutes
  var intervals = [];
  for (var j = 0; j < readings.length - 1; j++) {
    var diffMin = (readings[j + 1].time.getTime() - readings[j].time.getTime()) / 60000;
    if (diffMin > 0) intervals.push(diffMin);
  }

  var medianInterval = 10;
  if (intervals.length > 0) {
    intervals.sort(function(a, b) { return a - b; });
    var mid = Math.floor(intervals.length / 2);
    medianInterval = (intervals.length % 2 !== 0) ? intervals[mid] : (intervals[mid - 1] + intervals[mid]) / 2;
  }

  // Gap cap: max(30 min, 3 * medianInterval), capped at 180 min (3 h)
  var maxGapMinutes = Math.min(180, Math.max(30, 3 * medianInterval));

  var integratedKwh = 0;
  for (var k = 0; k < readings.length - 1; k++) {
    var t1 = readings[k].time.getTime();
    var t2 = readings[k + 1].time.getTime();
    var dtHours = (t2 - t1) / 3600000;
    var dtMin = dtHours * 60;

    if (dtMin <= maxGapMinutes && dtHours > 0) {
      var avgP = (readings[k].power + readings[k + 1].power) / 2;
      integratedKwh += avgP * dtHours;
    }
  }

  return {
    energy: Math.round(integratedKwh * 100) / 100,
    peak: Math.round(peakPower * 100) / 100,
    count: count
  };
}

/**
 * Updates a specific date in the Daily sheet
 */
function updateDailyRowForDate(dateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");
  var dailySheet = ss.getSheetByName("Daily");
  if (!readingsSheet || !dailySheet) return;

  var readings = getReadingsForDate(dateStr, readingsSheet);
  var totals = calculateDayEnergy(readings);

  var dailyData = dailySheet.getDataRange().getValues();
  var foundRow = -1;
  for (var r = 1; r < dailyData.length; r++) {
    if (String(dailyData[r][0]).trim() === dateStr) {
      foundRow = r + 1;
      break;
    }
  }

  var rowValues = [dateStr, totals.energy, totals.peak, totals.count];
  if (foundRow > 0) {
    dailySheet.getRange(foundRow, 1, 1, 4).setValues([rowValues]);
  } else {
    dailySheet.appendRow(rowValues);
  }
}

/**
 * Efficiently reads readings for a specific date (YYYY-MM-DD IST)
 */
function getReadingsForDate(dateStr, readingsSheet) {
  var lastRow = readingsSheet.getLastRow();
  if (lastRow <= 1) return [];

  var todayStr = getISTDateString(new Date());
  var readings = [];

  if (dateStr === todayStr) {
    // For today: read newest rows (start with 2,500 and grow if midnight not reached)
    var batchSize = 2500;
    var startRow = Math.max(2, lastRow - batchSize + 1);
    var numRows = lastRow - startRow + 1;
    var data = readingsSheet.getRange(startRow, 1, numRows, 8).getValues();

    // Check if first row is still today; if so, expand backwards
    while (startRow > 2) {
      var firstDate = getISTDateString(parseTimestampToDate(data[0][0]));
      if (firstDate === dateStr) {
        var expandSize = 2500;
        var prevStart = Math.max(2, startRow - expandSize);
        var prevNum = startRow - prevStart;
        var prevData = readingsSheet.getRange(prevStart, 1, prevNum, 8).getValues();
        data = prevData.concat(data);
        startRow = prevStart;
      } else {
        break;
      }
    }

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var dt = parseTimestampToDate(row[0]);
      if (dt && getISTDateString(dt) === dateStr) {
        readings.push({
          time: dt,
          timestampIso: formatIsoIST(dt),
          power: parseFloat(row[1]) || 0,
          energyToday: row[2] !== "" ? parseFloat(row[2]) : null,
          dcVoltage: row[3] !== "" ? parseFloat(row[3]) : null,
          dcCurrent: row[4] !== "" ? parseFloat(row[4]) : null,
          acVoltage: row[5] !== "" ? parseFloat(row[5]) : null,
          frequency: row[6] !== "" ? parseFloat(row[6]) : null,
          inverterTemp: row[7] !== "" ? parseFloat(row[7]) : null
        });
      }
    }
  } else {
    // For past dates: scan timestamp column (col A) to locate block
    var timestamps = readingsSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var startBlock = -1;
    var endBlock = -1;

    for (var r = 0; r < timestamps.length; r++) {
      var d = parseTimestampToDate(timestamps[r][0]);
      if (d && getISTDateString(d) === dateStr) {
        if (startBlock === -1) startBlock = r + 2;
        endBlock = r + 2;
      } else if (startBlock !== -1) {
        // If data is mostly sequential, stop when date changes, but continue if out of order
      }
    }

    if (startBlock !== -1) {
      var blockRows = endBlock - startBlock + 1;
      var blockData = readingsSheet.getRange(startBlock, 1, blockRows, 8).getValues();
      for (var b = 0; b < blockData.length; b++) {
        var bRow = blockData[b];
        var bDt = parseTimestampToDate(bRow[0]);
        if (bDt && getISTDateString(bDt) === dateStr) {
          readings.push({
            time: bDt,
            timestampIso: formatIsoIST(bDt),
            power: parseFloat(bRow[1]) || 0,
            energyToday: bRow[2] !== "" ? parseFloat(bRow[2]) : null,
            dcVoltage: bRow[3] !== "" ? parseFloat(bRow[3]) : null,
            dcCurrent: bRow[4] !== "" ? parseFloat(bRow[4]) : null,
            acVoltage: bRow[5] !== "" ? parseFloat(bRow[5]) : null,
            frequency: bRow[6] !== "" ? parseFloat(bRow[6]) : null,
            inverterTemp: bRow[7] !== "" ? parseFloat(bRow[7]) : null
          });
        }
      }
    }
  }

  // Always sort results because pasted data may be out of order
  readings.sort(function(a, b) {
    return a.time.getTime() - b.time.getTime();
  });

  return readings;
}

/**
 * Public Read-only API (doGet)
 */
function doGet(e) {
  var route = (e && e.parameter && e.parameter.route) ? e.parameter.route : "bundle";
  var cache = CacheService.getScriptCache();

  try {
    if (route === "ping") {
      return jsonResponse({
        ok: true,
        pong: true,
        server_time: formatIsoIST(new Date())
      });
    }

    if (route === "bundle") {
      var targetDate = (e && e.parameter && e.parameter.date) ? String(e.parameter.date).trim() : getISTDateString(new Date());
      var cacheKey = "bundle_" + targetDate;
      var cached = cache.get(cacheKey);
      if (cached) {
        return textResponse(cached);
      }

      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var readingsSheet = ss.getSheetByName("Readings");
      var settings = getSettings();

      var readings = readingsSheet ? getReadingsForDate(targetDate, readingsSheet) : [];
      var dayEnergy = calculateDayEnergy(readings);

      var latest = null;
      if (readings.length > 0) {
        var lastR = readings[readings.length - 1];
        latest = {
          timestamp: lastR.timestampIso,
          power_kw: Math.round(lastR.power * 100) / 100,
          energy_today_kwh: lastR.energyToday !== null ? lastR.energyToday : dayEnergy.energy,
          metrics: [
            { key: "power", label: "Power", value: Math.round(lastR.power * 100) / 100, unit: "kW" },
            { key: "dc_voltage", label: "DC voltage", value: lastR.dcVoltage !== null ? lastR.dcVoltage : 0, unit: "V" },
            { key: "dc_current", label: "DC current", value: lastR.dcCurrent !== null ? lastR.dcCurrent : 0, unit: "A" },
            { key: "ac_voltage", label: "AC voltage", value: lastR.acVoltage !== null ? lastR.acVoltage : 0, unit: "V" },
            { key: "frequency", label: "Frequency", value: lastR.frequency !== null ? lastR.frequency : 50, unit: "Hz" },
            { key: "inverter_temp", label: "Inverter temp", value: lastR.inverterTemp !== null ? lastR.inverterTemp : 0, unit: "°C" }
          ]
        };
      }

      var points = [];
      for (var p = 0; p < readings.length; p++) {
        points.push({
          t: readings[p].timestampIso,
          power_kw: Math.round(readings[p].power * 100) / 100
        });
      }

      var result = {
        ok: true,
        server_time: formatIsoIST(new Date()),
        config: {
          plant_name: settings.plant_name,
          capacity_kwp: settings.capacity_kwp,
          latitude: settings.latitude,
          longitude: settings.longitude,
          start_month: settings.start_month,
          alert_drop_percent: settings.alert_drop_percent,
          alert_min_sunlight: settings.alert_min_sunlight,
          alert_readings_in_a_row: settings.alert_readings_in_a_row,
          tariff_per_kwh: settings.tariff_per_kwh,
          co2_kg_per_kwh: settings.co2_kg_per_kwh
        },
        latest: latest,
        energy_reported_kwh: dayEnergy.energy,
        points: points
      };

      var outputStr = JSON.stringify(result);
      try { cache.put(cacheKey, outputStr, 15); } catch (cErr) {} // cache 15 seconds
      return textResponse(outputStr);
    }

    if (route === "daily") {
      var monthStr = (e && e.parameter && e.parameter.month) ? String(e.parameter.month).trim() : getISTDateString(new Date()).substring(0, 7);
      var dailyCacheKey = "daily_" + monthStr;
      var cachedDaily = cache.get(dailyCacheKey);
      if (cachedDaily) {
        return textResponse(cachedDaily);
      }

      var ssDaily = SpreadsheetApp.getActiveSpreadsheet();
      var dSheet = ssDaily.getSheetByName("Daily");
      var rows = [];

      if (dSheet && dSheet.getLastRow() > 1) {
        var dValues = dSheet.getDataRange().getValues();
        for (var dr = 1; dr < dValues.length; dr++) {
          var dDate = String(dValues[dr][0]).trim();
          if (dDate.indexOf(monthStr) === 0) {
            rows.push({
              date: dDate,
              energy_kwh: parseFloat(dValues[dr][1]) || 0,
              peak_kw: parseFloat(dValues[dr][2]) || 0
            });
          }
        }
      }

      rows.sort(function(a, b) { return a.date.localeCompare(b.date); });

      var dailyOutput = JSON.stringify({ ok: true, rows: rows });
      try { cache.put(dailyCacheKey, dailyOutput, 60); } catch (cErr2) {} // cache 60 seconds
      return textResponse(dailyOutput);
    }

    if (route === "months") {
      var cachedMonths = cache.get("months_all");
      if (cachedMonths) {
        return textResponse(cachedMonths);
      }

      var ssMonths = SpreadsheetApp.getActiveSpreadsheet();
      var mSheet = ssMonths.getSheetByName("Daily");
      var monthMap = {};

      if (mSheet && mSheet.getLastRow() > 1) {
        var mValues = mSheet.getDataRange().getValues();
        for (var mr = 1; mr < mValues.length; mr++) {
          var rowDate = String(mValues[mr][0]).trim();
          if (rowDate.length >= 7) {
            var mKey = rowDate.substring(0, 7);
            var eVal = parseFloat(mValues[mr][1]) || 0;
            monthMap[mKey] = (monthMap[mKey] || 0) + eVal;
          }
        }
      }

      var monthRows = [];
      var keys = Object.keys(monthMap).sort();
      for (var k = 0; k < keys.length; k++) {
        monthRows.push({
          month: keys[k],
          energy_kwh: Math.round(monthMap[keys[k]] * 10) / 10
        });
      }

      var monthsOutput = JSON.stringify({ ok: true, rows: monthRows });
      try { cache.put("months_all", monthsOutput, 60); } catch (cErr3) {} // cache 60 seconds
      return textResponse(monthsOutput);
    }

    return jsonResponse({ ok: false, error: "Unknown route: " + route });

  } catch (err) {
    return jsonResponse({ ok: false, error: "API error: " + err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textResponse(str) {
  return ContentService.createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Solar radiation & power model formula:
 * expected_kW = capacity × (radiation / 1000) × 0.92 × max(0.5, 1 − 0.004 × (cell_temp − 25))
 * where cell_temp = ambient + 0.03 × radiation
 */
function calculateExpectedPowerKw(capacityKwp, radiationWm2, ambientTempC) {
  if (radiationWm2 <= 0) return 0;
  var cellTemp = ambientTempC + 0.03 * radiationWm2;
  var tempDerate = Math.max(0.5, 1 - 0.004 * (cellTemp - 25));
  var pExpected = capacityKwp * (radiationWm2 / 1000) * 0.92 * tempDerate;
  return Math.max(0, pExpected);
}

/**
 * Linearly interpolates hourly radiation with 30-minute shift
 */
function interpolateHourlyRadiation(hourlyTimes, hourlyRadiation, targetDate) {
  if (!hourlyTimes || hourlyTimes.length === 0) return 0;
  var targetEpoch = targetDate.getTime();

  // Shift hourly timestamps by -30 minutes
  var shiftedPoints = [];
  for (var i = 0; i < hourlyTimes.length; i++) {
    var rawD = parseTimestampToDate(hourlyTimes[i]);
    if (rawD) {
      var shiftedEpoch = rawD.getTime() - (30 * 60 * 1000);
      shiftedPoints.push({ epoch: shiftedEpoch, rad: Math.max(0, hourlyRadiation[i] || 0) });
    }
  }

  if (shiftedPoints.length === 0) return 0;
  if (targetEpoch <= shiftedPoints[0].epoch) return shiftedPoints[0].rad;
  if (targetEpoch >= shiftedPoints[shiftedPoints.length - 1].epoch) return shiftedPoints[shiftedPoints.length - 1].rad;

  for (var j = 0; j < shiftedPoints.length - 1; j++) {
    var p1 = shiftedPoints[j];
    var p2 = shiftedPoints[j + 1];
    if (targetEpoch >= p1.epoch && targetEpoch <= p2.epoch) {
      var ratio = (targetEpoch - p1.epoch) / (p2.epoch - p1.epoch);
      return p1.rad + ratio * (p2.rad - p1.rad);
    }
  }

  return 0;
}

/**
 * Fault check trigger (checkHealth)
 * Runs every 10 minutes via installTriggers()
 */
function checkHealth() {
  var settings = getSettings();
  var now = new Date();

  // 1. Fetch Open-Meteo
  var weatherUrl = "https://api.open-meteo.com/v1/forecast?latitude=" +
    encodeURIComponent(settings.latitude) +
    "&longitude=" + encodeURIComponent(settings.longitude) +
    "&current=temperature_2m&hourly=shortwave_radiation&timezone=Asia%2FKolkata&forecast_days=1";

  var weatherData = null;
  try {
    var response = UrlFetchApp.fetch(weatherUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      weatherData = JSON.parse(response.getContentText());
    }
  } catch (netErr) {
    Logger.log("Weather fetch failed: " + netErr.message);
  }

  if (!weatherData || !weatherData.hourly || !weatherData.hourly.time) {
    Logger.log("Open-Meteo data unavailable, skipping fault check to prevent false alarms.");
    return;
  }

  var ambientTemp = (weatherData.current && weatherData.current.temperature_2m !== undefined) ? weatherData.current.temperature_2m : 28;
  var currentRadiation = interpolateHourlyRadiation(weatherData.hourly.time, weatherData.hourly.shortwave_radiation, now);

  // If current sunshine is below alert_min_sunlight, do nothing (night or heavy cloud never alarms)
  if (currentRadiation < settings.alert_min_sunlight) {
    Logger.log("Sunshine (" + Math.round(currentRadiation) + " W/m²) below minimum (" + settings.alert_min_sunlight + " W/m²). Resting.");
    // Clear active problem state if night/heavy cloud arrives
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty("last_problem_type");
    props.deleteProperty("last_problem_time");
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");
  if (!readingsSheet) return;

  var todayStr = getISTDateString(now);
  var readings = getReadingsForDate(todayStr, readingsSheet);

  var problemType = null;
  var problemDetails = "";

  // Check 1: No data for > 30 min in daylight
  if (readings.length === 0) {
    problemType = "No data";
    problemDetails = "Waiting for today's first reading while sunlight is strong (" + Math.round(currentRadiation) + " W/m²).";
  } else {
    var latestReading = readings[readings.length - 1];
    var minutesSinceLastReading = (now.getTime() - latestReading.time.getTime()) / 60000;

    if (minutesSinceLastReading > 30) {
      problemType = "No data";
      problemDetails = "No fresh data for " + Math.round(minutesSinceLastReading) + " minutes in daylight (" + Math.round(currentRadiation) + " W/m²).";
    } else {
      // Check 2: Low output / Zero output for last N readings
      var N = settings.alert_readings_in_a_row;
      if (readings.length >= N) {
        var recentReadings = readings.slice(readings.length - N);
        var allLow = true;
        var allZero = true;
        var zeroThreshold = 0.02 * settings.capacity_kwp; // 2% of capacity
        var dropFraction = settings.alert_drop_percent / 100;

        for (var rIdx = 0; rIdx < recentReadings.length; rIdx++) {
          var rItem = recentReadings[rIdx];
          var radAtTime = interpolateHourlyRadiation(weatherData.hourly.time, weatherData.hourly.shortwave_radiation, rItem.time);
          var expectedAtTime = calculateExpectedPowerKw(settings.capacity_kwp, radAtTime, ambientTemp);

          if (radAtTime >= settings.alert_min_sunlight) {
            var dropThreshold = dropFraction * expectedAtTime;
            if (rItem.power >= dropThreshold) {
              allLow = false;
            }
          } else {
            allLow = false; // below min sunlight reading cannot be counted as fault
          }

          if (rItem.power > zeroThreshold) {
            allZero = false;
          }
        }

        if (allLow) {
          if (allZero) {
            problemType = "Zero output";
            problemDetails = "Inverter output has dropped to 0 kW for the last " + N + " readings despite " + Math.round(currentRadiation) + " W/m² sunlight. Check breakers, inverter display and AC grid supply.";
          } else {
            problemType = "Low output";
            problemDetails = "Power is running more than " + settings.alert_drop_percent + "% below expected model for " + N + " readings in a row. Potential string fault, heavy shading, or inverter derating.";
          }
        }
      }
    }
  }

  var scriptProps = PropertiesService.getScriptProperties();
  var lastProblemType = scriptProps.getProperty("last_problem_type");
  var lastProblemTimeStr = scriptProps.getProperty("last_problem_time");
  var lastProblemTime = lastProblemTimeStr ? parseInt(lastProblemTimeStr, 10) : 0;
  var nowMs = now.getTime();
  var threeHoursMs = 3 * 60 * 60 * 1000;

  if (problemType) {
    var shouldNotify = false;
    if (lastProblemType !== problemType) {
      shouldNotify = true;
    } else if (nowMs - lastProblemTime >= threeHoursMs) {
      shouldNotify = true;
    }

    if (shouldNotify) {
      // 1. Log to Alerts sheet
      var alertsSheet = ss.getSheetByName("Alerts");
      if (alertsSheet) {
        alertsSheet.appendRow([formatIsoIST(now), problemType, problemDetails]);
      }

      // 2. Email alert_email once per problem
      if (settings.alert_email && settings.alert_email.indexOf("@") > 0) {
        var subject = "⚠️ Solar Alert: " + problemType + " at " + settings.plant_name;
        var body = "Solar Monitoring System Alert\n\n" +
          "Plant: " + settings.plant_name + "\n" +
          "Time: " + formatIsoIST(now) + "\n" +
          "Problem: " + problemType + "\n" +
          "Details: " + problemDetails + "\n\n" +
          "Please verify plant hardware status.";
        try {
          MailApp.sendEmail(settings.alert_email, subject, body);
        } catch (mailErr) {
          Logger.log("Failed to send alert email: " + mailErr.message);
        }
      }

      scriptProps.setProperty("last_problem_type", problemType);
      scriptProps.setProperty("last_problem_time", String(nowMs));
    }
  } else {
    // Normal healthy operation
    if (lastProblemType) {
      // Log recovery
      var aSheet = ss.getSheetByName("Alerts");
      if (aSheet) {
        aSheet.appendRow([formatIsoIST(now), "Recovered", "System output returned to normal operational limits."]);
      }
      scriptProps.deleteProperty("last_problem_type");
      scriptProps.deleteProperty("last_problem_time");
    }
  }
}

/**
 * Rebuilds the entire Daily sheet from Readings
 */
function rebuildDaily() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");
  var dailySheet = ss.getSheetByName("Daily");
  if (!readingsSheet || !dailySheet) return;

  var lastRow = readingsSheet.getLastRow();
  if (lastRow <= 1) {
    dailySheet.clear();
    dailySheet.appendRow(["Date (text yyyy-mm-dd)", "Energy (kWh)", "Peak power (kW)", "Readings"]);
    dailySheet.setFrozenRows(1);
    clearApiCache();
    return;
  }

  var data = readingsSheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var dayMap = {};

  for (var i = 0; i < data.length; i++) {
    var dt = parseTimestampToDate(data[i][0]);
    if (!dt) continue;
    var dStr = getISTDateString(dt);
    if (!dayMap[dStr]) dayMap[dStr] = [];

    dayMap[dStr].push({
      time: dt,
      timestampIso: formatIsoIST(dt),
      power: parseFloat(data[i][1]) || 0,
      energyToday: data[i][2] !== "" ? parseFloat(data[i][2]) : null,
      dcVoltage: data[i][3] !== "" ? parseFloat(data[i][3]) : null,
      dcCurrent: data[i][4] !== "" ? parseFloat(data[i][4]) : null,
      acVoltage: data[i][5] !== "" ? parseFloat(data[i][5]) : null,
      frequency: data[i][6] !== "" ? parseFloat(data[i][6]) : null,
      inverterTemp: data[i][7] !== "" ? parseFloat(data[i][7]) : null
    });
  }

  var dateKeys = Object.keys(dayMap).sort();
  var dailyRows = [];

  for (var k = 0; k < dateKeys.length; k++) {
    var dKey = dateKeys[k];
    var totals = calculateDayEnergy(dayMap[dKey]);
    dailyRows.push([dKey, totals.energy, totals.peak, totals.count]);
  }

  dailySheet.clear();
  dailySheet.appendRow(["Date (text yyyy-mm-dd)", "Energy (kWh)", "Peak power (kW)", "Readings"]);
  if (dailyRows.length > 0) {
    dailySheet.getRange(2, 1, dailyRows.length, 4).setValues(dailyRows);
  }
  dailySheet.setFrozenRows(1);
  dailySheet.getRange("A:A").setNumberFormat("@");

  clearApiCache(dateKeys);
}

/**
 * Sorts Readings sheet chronologically by timestamp
 */
function sortReadings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");
  if (!readingsSheet) return;

  var lastRow = readingsSheet.getLastRow();
  if (lastRow <= 2) return;

  var range = readingsSheet.getRange(2, 1, lastRow - 1, 8);
  var values = range.getValues();

  values.sort(function(a, b) {
    var da = parseTimestampToDate(a[0]);
    var db = parseTimestampToDate(b[0]);
    var ta = da ? da.getTime() : 0;
    var tb = db ? db.getTime() : 0;
    return ta - tb;
  });

  range.setValues(values);
}

/**
 * Generates sample demo readings for N days up to today.
 * Simulates clear sky with per-day cloud variation every 10 min from 6:00 to 18:45 IST.
 */
function seedDemoData(days) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");
  if (!readingsSheet) {
    setup();
    readingsSheet = ss.getSheetByName("Readings");
  }

  var settings = getSettings();
  var capacity = settings.capacity_kwp;
  var now = new Date();
  var totalDays = days || 30;

  var demoRows = [];

  for (var d = totalDays - 1; d >= 0; d--) {
    var targetDate = new Date(now.getTime() - d * 24 * 3600 * 1000);
    var istYear = targetDate.getUTCFullYear();
    var istMonth = targetDate.getUTCMonth();
    var istDay = targetDate.getUTCDate();

    // Cloud factor for the day (e.g. 0.85 to 1.0, some days cloudy 0.4)
    var cloudFactor = (d % 7 === 2) ? 0.45 : (0.8 + 0.2 * Math.sin(d * 1.5));
    var cumulativeEnergy = 0;

    // 6:00 to 18:45 every 10 minutes (77 intervals)
    for (var hour = 6; hour <= 18; hour++) {
      for (var min = 0; min < 60; min += 10) {
        if (hour === 18 && min > 45) break;

        // UTC epoch for IST date hour:min
        var readingUtcEpoch = Date.UTC(istYear, istMonth, istDay, hour, min, 0) - IST_OFFSET_MS;
        if (readingUtcEpoch > now.getTime()) break; // Don't generate into the future

        var fracDay = (hour + min / 60 - 6) / 12.75; // 0 at 6:00, 1 at 18:45
        var bell = Math.sin(Math.PI * fracDay);
        if (bell < 0) bell = 0;

        // Peak irradiance ~ 950 W/m² on clear sky
        var irradiance = Math.round(950 * bell * cloudFactor);
        var ambient = 24 + 10 * bell;
        var pKw = calculateExpectedPowerKw(capacity, irradiance, ambient);
        // Add realistic slight inverter fluctuation
        if (pKw > 0) {
          pKw = pKw * (0.97 + 0.05 * Math.sin((hour * 60 + min) / 15));
        }
        pKw = Math.max(0, Math.round(pKw * 100) / 100);

        cumulativeEnergy += pKw * (10 / 60);

        var dcV = pKw > 0 ? Math.round(380 + 20 * bell) : 0;
        var dcA = (pKw > 0 && dcV > 0) ? Math.round(((pKw * 1000) / dcV) * 10) / 10 : 0;
        var acV = pKw > 0 ? Math.round(230 + 3 * Math.sin(min)) : 230;
        var freq = 50.0;
        var temp = Math.round(ambient + 15 * bell);

        var istDateObj = new Date(readingUtcEpoch);
        demoRows.push([
          formatIsoIST(istDateObj),
          pKw,
          Math.round(cumulativeEnergy * 100) / 100,
          dcV,
          dcA,
          acV,
          freq,
          temp
        ]);
      }
    }
  }

  if (demoRows.length > 0) {
    // Append in batches of 2000
    var chunkSize = 2000;
    for (var c = 0; c < demoRows.length; c += chunkSize) {
      var chunk = demoRows.slice(c, c + chunkSize);
      var curLast = readingsSheet.getLastRow();
      readingsSheet.getRange(curLast + 1, 1, chunk.length, 8).setValues(chunk);
    }
    rebuildDaily();
  }
}

/**
 * Menu wrapper for seedDemoData
 */
function seedDemoDataMenu() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var readingsSheet = ss.getSheetByName("Readings");

  if (readingsSheet && readingsSheet.getLastRow() > 1) {
    var response = ui.alert(
      "Confirm Sample Data",
      "Readings sheet already contains data. Do you want to add 30 days of sample data?",
      ui.ButtonSet.YES_NO
    );
    if (response !== ui.Button.YES) return;
  }

  seedDemoData(30);
  ui.alert("Success", "Added 30 days of sample data and rebuilt daily totals.", ui.ButtonSet.OK);
}

/**
 * Menu wrapper for rebuildDaily
 */
function rebuildDailyMenu() {
  rebuildDaily();
  SpreadsheetApp.getUi().alert("Rebuild Complete", "All daily totals have been recomputed from the Readings sheet.", SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Menu wrapper for sortReadings
 */
function sortReadingsMenu() {
  sortReadings();
  SpreadsheetApp.getUi().alert("Sort Complete", "Readings have been sorted chronologically by timestamp.", SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Installs 10-minute time trigger for checkHealth
 */
function installTriggers() {
  // Remove existing checkHealth triggers
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkHealth") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger("checkHealth")
    .timeBased()
    .everyMinutes(10)
    .create();

  SpreadsheetApp.getUi().alert("Fault Checks Enabled", "Automatic health checks will run every 10 minutes to verify plant status.", SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Sends test email to alert_email setting
 */
function sendTestEmailMenu() {
  var settings = getSettings();
  var ui = SpreadsheetApp.getUi();

  if (!settings.alert_email || settings.alert_email.indexOf("@") === -1) {
    ui.alert("No Email Set", "Please set a valid alert_email in the Settings sheet first.", ui.ButtonSet.OK);
    return;
  }

  try {
    MailApp.sendEmail(
      settings.alert_email,
      "✅ Test Alert: Solar Monitoring System - " + settings.plant_name,
      "This is a test alert from your solar power monitoring system (" + settings.plant_name + ").\n\nEmail notifications are configured and working properly!"
    );
    ui.alert("Email Sent", "A test notification was successfully sent to " + settings.alert_email, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert("Email Failed", "Could not send email: " + err.message, ui.ButtonSet.OK);
  }
}

/**
 * Displays modal dialog with Web app URL and ingest key
 */
function showWebAddressAndKey() {
  var settings = getSettings();
  var ui = SpreadsheetApp.getUi();
  var msg = "Secret Ingest Key:\n" + settings.ingest_key + "\n\n" +
    "Web App URL:\nDeploy via 'Deploy' > 'New deployment' > 'Web app' (Execute as Me, Who has access: Anyone).\n\n" +
    "API endpoints:\n" +
    "• GET ?route=bundle (Live data & config)\n" +
    "• GET ?route=daily&month=YYYY-MM (Daily history)\n" +
    "• GET ?route=months (Monthly totals)\n" +
    "• POST (Log readings with key)";
  ui.alert("Solar System Credentials", msg, ui.ButtonSet.OK);
}
