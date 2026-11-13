# Solar Logger — ESP32 + PZEM-004T v3.0

Data-logger firmware for the GPREC EEE Block-1 rooftop solar plant.  
Reads AC power every 30 seconds, queues 5-minute averages, and POSTs them to the Google Apps Script backend.

---

## Wiring

```
PZEM-004T v3.0          ESP32 Dev Module
──────────────          ────────────────
5 V  ─────────────────► Vin  (5 V pin)
GND  ─────────────────► GND
TX   ─────────────────► GPIO 16  (Serial2 RX)
RX   ─────────────────► GPIO 17  (Serial2 TX)

AC clamp / screw terminals  ──►  Inverter AC output  (L + N)
```

> ⚠️ **LETHAL VOLTAGE WARNING**  
> The AC terminals carry 230 V. All AC wiring **must** be done by a qualified electrician.  
> Never touch AC terminals while the system is energised.

---

## Libraries to install (Arduino IDE)

| Library | Author | Install via |
|---------|--------|-------------|
| **PZEM004Tv30** | Jakub Mandula | Library Manager → search "PZEM004T" |
| **ArduinoJson** v6 | Benoit Blanchon | Library Manager → search "ArduinoJson" |
| **ESP32 board core** | Espressif | Boards Manager → search "esp32 by Espressif Systems" |

> To add the ESP32 core: open **File → Preferences** and add  
> `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`  
> to *Additional Boards Manager URLs*, then install from **Tools → Board → Boards Manager**.

---

## Configuration (edit before flashing)

Open `solar_logger.ino` and change these three lines at the top:

```cpp
static const char* WIFI_SSID     = "YOUR_WIFI_NAME";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
static const char* INGEST_KEY    = "YOUR_INGEST_KEY";
```

**Where to get the ingest key:**
1. Open your Google Sheet → **Solar_Settings** tab
2. Find the row `ingest_key` and type any secret string in the Value column  
   (e.g. `gprec-solar-2026`)
3. Copy exactly that string into `INGEST_KEY` in the firmware
4. Redeploy Apps Script: **Deploy → Manage deployments → Edit → New version → Deploy**

---

## How to flash

1. Open `solar_logger.ino` in Arduino IDE
2. Select **Tools → Board → esp32 → ESP32 Dev Module**
3. Select the correct **Tools → Port** (COMx on Windows)
4. Click **Upload** (▶)

---

## Reading the Serial output

Open **Tools → Serial Monitor**, set baud rate to **115200**.

Normal startup looks like:

```
================================================
  GPREC Solar Logger  |  ESP32 + PZEM-004T v3
================================================
[WiFi] Connecting to 'MyWiFi'..................
[WiFi] Connected — IP 192.168.1.42
[NTP] Syncing................. OK
[SETUP] Running. Meter every 30 s, queue every 5 min.
[METER] 4.231 kW | 230.4 V | 50.01 Hz  (avg over 1 samples)
[METER] 4.189 kW | 230.1 V | 50.00 Hz  (avg over 2 samples)
...
[QUEUE] Queued 2026-11-13 08:05:00 | 4.210 kW | 1 rows pending
[HTTP] POSTing 1 rows (187 bytes)
[HTTP] Step-1 response: 302
[HTTP] Redirect → https://script.google.com/...
[HTTP] Step-2 response (200): {"status":"success","saved":1}
[HTTP] ✓ saved=1
[QUEUE] Uploaded 1 rows. 0 remaining.
```

---

## First-run checklist (Serial Monitor)

| Step | What to look for |
|------|-----------------|
| 1 | `[WiFi] Connected` — if not, check SSID/password |
| 2 | `[NTP] Syncing... OK` — if TIMEOUT, check internet access |
| 3 | `[METER]` lines appear every 30 s — if not, check PZEM wiring |
| 4 | After 5 min: `[QUEUE] Queued …` appears |
| 5 | `[HTTP] Step-1 response: 302` — correct (Google always redirects) |
| 6 | `[HTTP] ✓ saved=1` — row reached the Sheet |
| 7 | `*** UNAUTHORIZED ***` → wrong `INGEST_KEY`; re-flash with correct value |
| 8 | No `[METER]` lines → PZEM not responding; check RX/TX pin swap |

---

## Confirming rows in the Sheet

1. Open your Google Sheet  
2. Look for a tab named **today's date** (e.g. `2026-11-13`)  
3. It should have columns: `Timestamp | Active_Power_kW | … | AC_Voltage_V | Frequency_Hz`  
4. New rows appear every **5 minutes** when power > 0.02 kW, or every **15 minutes** at night / zero power  
5. The dashboard at `https://solar-panel-tracking.vercel.app` refreshes every 15 seconds

---

## Behaviour summary

| Situation | Interval |
|-----------|---------|
| Solar generating (≥ 0.02 kW) | Queue one row every **5 min** |
| Night / very low power | Queue one row every **15 min** |
| Wi-Fi or server error | Retry upload every **1 min**, rows kept in RAM |
| Wrong ingest key | Pause **10 min**, then retry |
| No upload for **2 hours** | ESP32 restarts automatically |
| RAM queue full (144 rows) | Oldest row dropped, newest kept |

---

## What was NOT tested (requires real hardware)

- Actual PZEM-004T communication over Serial2
- Real Google 302-redirect timing and Location header contents  
- ESP32 Wi-Fi reconnection behaviour on a live network  
- NTP sync over a real internet connection
- Long-run watchdog (2-hour restart)

All backend logic (key validation, row parsing, tab creation, `saved:N` response) is fully tested in `tests/mock_backend.py`.
