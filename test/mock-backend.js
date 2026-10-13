/**
 * Mock Google Apps Script environment for Node.js testing
 */

class MockRange {
  constructor(sheet, startRow, startCol, numRows, numCols) {
    this.sheet = sheet;
    this.startRow = startRow;
    this.startCol = startCol;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getValues() {
    const res = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr = [];
      const rowIndex = this.startRow - 1 + r;
      const sheetRow = this.sheet.rows[rowIndex] || [];
      for (let c = 0; c < this.numCols; c++) {
        const colIndex = this.startCol - 1 + c;
        rowArr.push(sheetRow[colIndex] !== undefined ? sheetRow[colIndex] : "");
      }
      res.push(rowArr);
    }
    return res;
  }

  setValues(values) {
    for (let r = 0; r < values.length; r++) {
      const rowIndex = this.startRow - 1 + r;
      if (!this.sheet.rows[rowIndex]) {
        this.sheet.rows[rowIndex] = [];
      }
      for (let c = 0; c < values[r].length; c++) {
        const colIndex = this.startCol - 1 + c;
        this.sheet.rows[rowIndex][colIndex] = values[r][c];
      }
    }
    return this;
  }

  setNumberFormat(format) {
    this.sheet.format = format;
    return this;
  }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = []; // 0-indexed array of rows
    this.frozenRows = 0;
  }

  getLastRow() {
    return this.rows.length;
  }

  setFrozenRows(n) {
    this.frozenRows = n;
  }

  clear() {
    this.rows = [];
  }

  appendRow(row) {
    this.rows.push([...row]);
  }

  getDataRange() {
    const numRows = Math.max(1, this.rows.length);
    let maxCols = 1;
    for (const r of this.rows) {
      if (r && r.length > maxCols) maxCols = r.length;
    }
    return new MockRange(this, 1, 1, numRows, maxCols);
  }

  getRange(row, col, numRows, numCols) {
    if (typeof row === 'string') {
      // e.g. "A:A" or "B:B"
      const colLetter = row.charAt(0).toUpperCase();
      const colIndex = colLetter.charCodeAt(0) - 64;
      return new MockRange(this, 1, colIndex, Math.max(1, this.rows.length), 1);
    }
    return new MockRange(this, row, col, numRows || 1, numCols || 1);
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = {};
  }

  getSheetByName(name) {
    return this.sheets[name] || null;
  }

  insertSheet(name, index) {
    const s = new MockSheet(name);
    this.sheets[name] = s;
    return s;
  }

  getSheets() {
    return Object.values(this.sheets);
  }
}

class MockCache {
  constructor() {
    this.store = new Map();
  }

  get(k) {
    return this.store.get(k) || null;
  }

  put(k, v, sec) {
    this.store.set(k, v);
  }

  remove(k) {
    this.store.delete(k);
  }

  removeAll(keys) {
    for (const k of keys) this.store.delete(k);
  }
}

class MockLock {
  waitLock(ms) { return true; }
  releaseLock() {}
}

class MockProperties {
  constructor() {
    this.props = {};
  }
  getProperty(k) { return this.props[k] || null; }
  setProperty(k, v) { this.props[k] = String(v); }
  deleteProperty(k) { delete this.props[k]; }
}

function createGasEnvironment() {
  const spreadsheet = new MockSpreadsheet();
  const cache = new MockCache();
  const properties = new MockProperties();
  const sentEmails = [];
  let urlFetchResponse = null;

  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      setActiveSheet: () => {},
      getUi: () => ({
        createMenu: () => ({ addItem: () => ({ addToUi: () => {} }) }),
        alert: () => 1,
        ButtonSet: { YES_NO: 1, OK: 2 },
        Button: { YES: 1, NO: 2, OK: 3 }
      })
    },
    CacheService: {
      getScriptCache: () => cache
    },
    LockService: {
      getScriptLock: () => new MockLock()
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (str) => ({
        content: str,
        setMimeType: function() { return this; },
        getContent: function() { return this.content; }
      })
    },
    MailApp: {
      sendEmail: (to, subject, body) => {
        sentEmails.push({ to, subject, body });
      }
    },
    PropertiesService: {
      getScriptProperties: () => properties
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (urlFetchResponse) return urlFetchResponse;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ hourly: { time: [], shortwave_radiation: [] } })
        };
      }
    },
    Logger: {
      log: (msg) => {}
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({
        timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) })
      })
    },
    // Test inspection hooks
    _spreadsheet: spreadsheet,
    _cache: cache,
    _properties: properties,
    _sentEmails: sentEmails,
    _setUrlFetchResponse: (resp) => { urlFetchResponse = resp; }
  };

  return env;
}

module.exports = { createGasEnvironment };
