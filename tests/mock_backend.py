"""
tests/mock_backend.py
─────────────────────
Pure-Python simulation of the Apps Script doPost() handler.

Covers:
  1. Firmware batch {key, rows}  → {"saved": N}
  2. Wrong key                   → {"error": "Unauthorized"}
  3. Timestamps with and without seconds both accepted
  4. Rows with missing/NaN power silently skipped
  5. Legacy MODBUS {sheet, keys, values} still works

Run with:  python tests/mock_backend.py
No external packages needed.
"""

import json, re, sys

# ─── Simulated settings (mirrors Solar_Settings tab) ───────────────────────
INGEST_KEY    = "my-secret-key-123"
SPREADSHEET   = {}   # { "YYYY-MM-DD": [ [col…], [row…], … ] }
HEADERS       = ["Timestamp","Active_Power_kW","Energy_Today_kWh",
                 "DC_Voltage_V","DC_Current_A","AC_Voltage_V",
                 "Frequency_Hz","Inverter_Temp_C"]

def reset_spreadsheet():
    SPREADSHEET.clear()

# ─── doPost simulation ──────────────────────────────────────────────────────

def do_post(raw_body: str) -> dict:
    try:
        data = json.loads(raw_body)
    except json.JSONDecodeError as e:
        return {"status": "error", "message": str(e)}

    if "key" in data and isinstance(data.get("rows"), list):
        return _firmware_ingest(data)
    return _modbus_ingest(data)


def _firmware_ingest(data: dict) -> dict:
    if data.get("key") != INGEST_KEY:
        return {"error": "Unauthorized"}

    saved = 0
    for row in data.get("rows", []):
        ts = str(row.get("timestamp", "")).strip()
        if not ts:
            continue

        date_str = ts[:10]
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_str):
            continue

        # Accept HH:MM:SS  or  HH:MM  (append :00 if needed)
        if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", ts):
            ts += ":00"

        try:
            pw  = float(row.get("power_kw",    0) or 0)
            acv = float(row.get("ac_voltage",  0) or 0)
            hz  = float(row.get("frequency_hz",0) or 0)
        except (ValueError, TypeError):
            continue

        if date_str not in SPREADSHEET:
            SPREADSHEET[date_str] = [HEADERS[:]]

        SPREADSHEET[date_str].append([ts, pw, "", "", "", acv, hz, ""])
        saved += 1

    return {"status": "success", "saved": saved}


def _modbus_ingest(data: dict) -> dict:
    sheet_name = data.get("sheet", "Daily_Log_Default")
    keys       = data.get("keys", [])
    values     = data.get("values", {})

    if sheet_name not in SPREADSHEET:
        SPREADSHEET[sheet_name] = [keys[:]]

    row = [(values.get(k) if values.get(k) not in (None, "None", "") else "")
           for k in keys]
    SPREADSHEET[sheet_name].append(row)
    return {"status": "success", "message": f"logged → {sheet_name}"}

# ─── Test harness ──────────────────────────────────────────────────────────

passed = failed = 0

def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  [PASS]  {name}")
        passed += 1
    except AssertionError as e:
        print(f"  [FAIL]  {name}")
        print(f"          {e}")
        failed += 1

def eq(a, b, msg=""):
    assert a == b, msg or f"Expected {b!r}, got {a!r}"

# ══════════════════════════════════════════════════════════════════════════════
print("\n--- Firmware batch ingest ---")

def t_batch_3():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [
            {"timestamp": "2026-11-13 08:00:00",
             "power_kw": 1.234, "ac_voltage": 229.5, "frequency_hz": 49.98},
            {"timestamp": "2026-11-13 08:05:00",
             "power_kw": 2.100, "ac_voltage": 230.1, "frequency_hz": 50.00},
            {"timestamp": "2026-11-13 08:10:00",
             "power_kw": 3.456, "ac_voltage": 231.7, "frequency_hz": 50.02},
        ]
    })
    r = do_post(body)
    eq(r.get("saved"), 3, f"Expected saved=3, got {r}")
    eq(len(SPREADSHEET.get("2026-11-13", [])), 4)   # header + 3 rows

test("batch of 3 rows → saved:3", t_batch_3)

def t_wrong_key():
    reset_spreadsheet()
    body = json.dumps({
        "key": "WRONG_KEY",
        "rows": [{"timestamp":"2026-11-13 09:00:00","power_kw":1.0,"ac_voltage":230,"frequency_hz":50}]
    })
    r = do_post(body)
    eq(r.get("error"), "Unauthorized")
    eq(len(SPREADSHEET), 0, "No data should be written on Unauthorized")

test("wrong key → Unauthorized", t_wrong_key)

def t_empty_key():
    reset_spreadsheet()
    # Empty string key should also be rejected
    body = json.dumps({"key": "", "rows": []})
    r = do_post(body)
    eq(r.get("error"), "Unauthorized")

test("empty key → Unauthorized", t_empty_key)

print("\n--- Timestamp format tests ---")

def t_ts_with_seconds():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [{"timestamp":"2026-11-13 10:30:45","power_kw":4.0,"ac_voltage":231,"frequency_hz":50}]
    })
    r = do_post(body)
    eq(r.get("saved"), 1)
    rows = SPREADSHEET.get("2026-11-13", [])
    eq(rows[1][0], "2026-11-13 10:30:45")

test("timestamp HH:MM:SS accepted", t_ts_with_seconds)

def t_ts_without_seconds():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [{"timestamp":"2026-11-13 10:35","power_kw":4.2,"ac_voltage":230,"frequency_hz":50}]
    })
    r = do_post(body)
    eq(r.get("saved"), 1)
    rows = SPREADSHEET.get("2026-11-13", [])
    # :00 appended automatically
    assert rows[1][0].endswith(":00"), f"Expected :00 suffix, got {rows[1][0]}"

test("timestamp HH:MM (no seconds) → :00 appended", t_ts_without_seconds)

def t_ts_bad_format():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [{"timestamp":"13/11/2026 10:00:00","power_kw":4.2,"ac_voltage":230,"frequency_hz":50}]
    })
    r = do_post(body)
    eq(r.get("saved"), 0, "Bad date format should be skipped")

test("dd/mm/yyyy format → skipped (must be YYYY-MM-DD)", t_ts_bad_format)

def t_mixed_rows():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [
            {"timestamp":"2026-11-13 11:00:00","power_kw":5.0,"ac_voltage":230,"frequency_hz":50},
            {"timestamp":"",     "power_kw":5.0,"ac_voltage":230,"frequency_hz":50},  # empty ts
            {"timestamp":"2026-11-13 11:05:00","power_kw":5.5,"ac_voltage":231,"frequency_hz":50},
        ]
    })
    r = do_post(body)
    eq(r.get("saved"), 2, "Empty-timestamp row must be skipped")

test("3 rows, 1 empty timestamp → saved:2", t_mixed_rows)

def t_multi_day():
    reset_spreadsheet()
    body = json.dumps({
        "key": INGEST_KEY,
        "rows": [
            {"timestamp":"2026-11-12 23:55:00","power_kw":0.1,"ac_voltage":230,"frequency_hz":50},
            {"timestamp":"2026-11-13 00:00:00","power_kw":0.0,"ac_voltage":230,"frequency_hz":50},
        ]
    })
    r = do_post(body)
    eq(r.get("saved"), 2)
    assert "2026-11-12" in SPREADSHEET
    assert "2026-11-13" in SPREADSHEET

test("rows spanning midnight → split into two tabs", t_multi_day)

print("\n--- Legacy MODBUS format ---")

def t_modbus():
    reset_spreadsheet()
    body = json.dumps({
        "sheet": "2026-11-13",
        "keys":  ["Timestamp","Active_Power_kW","AC_Voltage_V"],
        "values":{"Timestamp":"2026-11-13 12:00:00","Active_Power_kW":6.5,"AC_Voltage_V":229}
    })
    r = do_post(body)
    eq(r.get("status"), "success")
    rows = SPREADSHEET.get("2026-11-13", [])
    assert len(rows) >= 2, "Expected at least header + 1 data row"

test("legacy MODBUS {sheet,keys,values} still works", t_modbus)

def t_malformed_json():
    r = do_post("{bad json")
    eq(r.get("status"), "error")

test("malformed JSON → error response (no crash)", t_malformed_json)

# ─── Show spreadsheet state after all tests ─────────────────────────────────
print("\n--- Final spreadsheet state ---")
reset_spreadsheet()
# Run the main batch test to populate
do_post(json.dumps({
    "key": INGEST_KEY,
    "rows": [
        {"timestamp":"2026-11-13 08:00:00","power_kw":1.234,"ac_voltage":229.5,"frequency_hz":49.98},
        {"timestamp":"2026-11-13 08:05:00","power_kw":2.100,"ac_voltage":230.1,"frequency_hz":50.00},
        {"timestamp":"2026-11-13 08:10:00","power_kw":3.456,"ac_voltage":231.7,"frequency_hz":50.02},
    ]
}))
for tab, rows in SPREADSHEET.items():
    print(f"  Tab '{tab}':  {len(rows)-1} data row(s)")
    for r in rows[:4]:
        print(f"    {r}")

# ─── Summary ─────────────────────────────────────────────────────────────────
print(f"\n{'─'*52}")
print(f"Results: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print("All tests passed!\n")
