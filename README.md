# ☀️ Solar Power Monitoring System

**Plant:** GPREC EEE Block 1 (Kurnool, Andhra Pradesh, India)  
**Capacity:** 10 kWp (Configurable) | **Timezone:** Indian Standard Time (IST, UTC+5:30) | **Currency:** ₹ (INR)

A complete, production-ready solar plant monitoring system built in two simple parts:
1. **Backend:** Google Apps Script (`backend/Code.gs` & `backend/appsscript.json`) container-bound to a Google Sheet acting as a zero-cost, persistent database and alert engine.
2. **Frontend:** A single self-contained `index.html` (pure HTML, CSS, and vanilla JavaScript—zero frameworks, zero build steps, zero npm dependencies) deployable directly to [Vercel](https://vercel.com) or any static host.

Includes real-time generation curves, physical solar irradiance benchmarking via Open-Meteo satellite weather, automated fault detection (Zero output, Low output, Stale logger), financial savings, carbon offset metrics, daily/monthly historical reports, and responsive mobile optimization.

---

## 📋 Table of Contents
- [Architecture Overview](#-architecture-overview)
- [Step-by-Step Setup Guide](#-step-by-step-setup-guide)
  - [Part 1: Google Sheet & Backend Setup](#part-1-google-sheet--backend-setup)
  - [Part 2: Frontend Setup & Vercel Deployment](#part-2-frontend-setup--vercel-deployment)
  - [Part 3: Enable Automated Fault Checks](#part-3-enable-automated-fault-checks)
  - [Part 4: Redeploying Code Changes](#part-4-redeploying-code-changes)
- [How to Send Data to the System](#-how-to-send-data-to-the-system)
  - [Method 1: Automated Hardware Logger (ESP32 / Raspberry Pi / curl)](#method-1-automated-hardware-logger-esp32--curl)
  - [Method 2: Manual Row Pasting](#method-2-manual-row-pasting)
- [API Reference](#-api-reference)
- [Troubleshooting Table](#-troubleshooting-table)
- [Honest Limitations & Physics Model](#-honest-limitations--physics-model)

---

## 🏛️ Architecture Overview

```
 ┌──────────────────────┐         HTTP POST (JSON + Ingest Key)
 │  Inverter Telemetry  │────────────────────────────────────────────────┐
 │ (ESP32 / curl logger)│                                                │
 └──────────────────────┘                                                ▼
                                                          ┌──────────────────────────────┐
                                                          │   Google Apps Script (GAS)   │
 ┌──────────────────────┐         HTTP GET (Public)       │          (Code.gs)           │
 │ Frontend Dashboard   │◄────────────────────────────────│   doGet() & doPost() API     │
 │    (index.html)      │                                 └──────────────┬───────────────┘
 └──────────┬───────────┘                                                │
            │                                                            ▼
            │ Fetch Weather                               ┌──────────────────────────────┐
            ▼                                             │         Google Sheet         │
 ┌──────────────────────┐                                 │ Readings | Daily | Settings  │
 │ Open-Meteo Satellite │                                 │       Alerts | Start here    │
 │ Solar Irradiance API │                                 └──────────────────────────────┘
 └──────────────────────┘
```

---

## 🚀 Step-by-Step Setup Guide

### Part 1: Google Sheet & Backend Setup

1. **Create a new Google Sheet:**
   - Go to [Google Sheets](https://sheets.new) and create a blank spreadsheet.
   - Name it `GPREC Solar Telemetry Database`.

2. **Open the Apps Script Editor:**
   - In the Google Sheet top menu, click **Extensions** > **Apps Script**.

3. **Configure `appsscript.json` (Project Settings):**
   - In the Apps Script left sidebar, click the **Project Settings** (gear icon ⚙️).
   - Check the box: **Show "appsscript.json" manifest file in editor**.
   - Return to the **Editor** (< > icon).
   - Click `appsscript.json` and replace its contents with the code from [`backend/appsscript.json`](backend/appsscript.json).

4. **Add `Code.gs`:**
   - Click on `Code.gs` in the editor.
   - Replace any existing code with the complete content of [`backend/Code.gs`](backend/Code.gs).
   - Click the floppy disk icon (**Save project** or `Ctrl+S`).

5. **Run Setup & Authorize Permissions:**
   - In the toolbar dropdown at the top, ensure `setup` is selected and click **Run**.
   - Google will show an **Authorization Required** prompt. Click **Review permissions**.
   - Choose your Google account.
   - If you see *"Google hasn't verified this app"*, click **Advanced** (bottom left), then click **Go to Untitled project (unsafe)**.
   - Click **Allow**.
   - Once execution finishes, return to your Google Sheet tab. You will see five automatically organized sheets:
     - `Start here`: Plain language quick-start guide.
     - `Readings`: Raw 10-minute inverter telemetry log (frozen header row).
     - `Daily`: Automatic daily totals (date, kWh, peak kW, readings count).
     - `Settings`: Plain-text plant configuration, tariff, alert thresholds, and your secret `ingest_key`.
     - `Alerts`: Fault audit log (time, problem type, diagnostic details).

6. **Verify and Adjust Settings:**
   - Switch to the **Settings** tab in the Sheet:
     - `plant_name`: Set to your plant name (default: `GPREC EEE Block 1`).
     - `capacity_kwp`: Enter your plant's rated peak capacity in kWp (default: `10`).
     - `latitude`: `15.81` (Kurnool, Andhra Pradesh).
     - `longitude`: `78.05`.
     - `tariff_per_kwh`: Institutional electricity tariff in ₹/unit (default: `7`).
     - `co2_kg_per_kwh`: Emission factor (default: `0.7`).
     - `alert_email`: Enter the email address that should receive fault notifications (or leave empty).
     - `ingest_key`: A randomly generated 20-character secret key. Keep this handy!

7. **(Optional) Seed 30 Days of Demo Data:**
   - Refresh your Google Sheet in your browser so the custom **Solar** menu appears in the top menu bar.
   - Click **Solar** > **Add 30 days of SAMPLE data**.
   - This generates realistic clear-sky and cloudy generation days and recalculates all `Daily` totals.

8. **Deploy the Web App:**
   - In the Apps Script editor, click the blue **Deploy** button (top right) > **New deployment**.
   - Click the gear icon next to "Select type" and choose **Web app**.
   - Configure the deployment settings:
     - **Description:** `Production v1`
     - **Execute as:** `Me (your email)`
     - **Who has access:** `Anyone` *(Crucial: do not select "Only myself" or the dashboard cannot load public readings).*
   - Click **Deploy**.
   - Copy the **Web App URL** (ends in `/exec`). It looks like:
     ```
     https://script.google.com/macros/s/AKfycbx.../exec
     ```

---

### Part 2: Frontend Setup & Vercel Deployment

1. **Connect the Web App URL:**
   - Open `index.html` in your code editor.
   - At the top of the `<script>` tag (around line 777), locate:
     ```javascript
     const API_URL = ''; // paste the Apps Script /exec URL
     ```
   - Paste your copied Web App URL between the quotes:
     ```javascript
     const API_URL = 'https://script.google.com/macros/s/AKfycbx.../exec';
     ```
   - Save `index.html`.

2. **Deploy to Vercel (Instant Zero-Config):**
   - Push this repository to GitHub.
   - Visit [vercel.com](https://vercel.com) and click **Add New...** > **Project**.
   - Select your GitHub repository (`solar-panel-racking`).
   - Leave Framework Preset as **Other** (no build command or output directory needed).
   - Click **Deploy**.
   - In under 10 seconds, your solar monitoring dashboard is live on the internet!

> 💡 **Testing without deploying:** You can open `index.html` directly in any web browser. You can also append `?api=YOUR_EXEC_URL` to the URL in your browser to test any backend without editing code, or test simulation mode using `?demo=1`.

---

### Part 3: Enable Automated Fault Checks

1. Open your Google Sheet.
2. In the top menu, click **Solar** > **Turn on fault checks**.
3. This creates a time-driven background trigger that runs `checkHealth()` every 10 minutes:
   - Fetches live Open-Meteo satellite solar irradiance.
   - Checks if sunlight is at least `alert_min_sunlight` (150 W/m²).
   - Detects if inverter is outputting 0 kW (**Zero output**), more than 50% below model (**Low output**), or has stopped sending readings for over 30 minutes (**No data**).
   - Logs the incident to the `Alerts` tab and sends an email alert to `alert_email`.
   - Suppresses duplicate emails for 3 hours unless the system recovers first.
4. Click **Solar** > **Send a test email** to confirm your email notification setup works!

---

### Part 4: Redeploying Code Changes

When you make changes to `backend/Code.gs`:
1. In the Apps Script editor, save your code (`Ctrl+S`).
2. Click **Deploy** > **Manage deployments**.
3. Click the pencil edit icon ✏️ next to your active deployment.
4. Under **Version**, select **New version**.
5. Click **Deploy**. *(Note: Google Apps Script requires creating a new version for code updates to take effect on the `/exec` endpoint).*

---

## 📡 How to Send Data to the System

### Method 1: Automated Hardware Logger (ESP32 / curl)

The backend accepts `POST` requests formatted as JSON.

#### Using `curl`:

```bash
# Log a single reading (Power in kW):
curl -L -X POST "https://script.google.com/macros/s/YOUR_EXEC_ID/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "YOUR_20_CHAR_KEY",
    "power_kw": 7.85,
    "timestamp": "2026-10-13 12:30",
    "energy_today_kwh": 31.4,
    "dc_voltage": 382.5,
    "dc_current": 20.5,
    "ac_voltage": 231.0,
    "frequency_hz": 50.0,
    "inverter_temp_c": 41.2
  }'

# Or send power directly in Watts (system converts watts to kW):
curl -L -X POST "https://script.google.com/macros/s/YOUR_EXEC_ID/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "YOUR_20_CHAR_KEY",
    "power_w": 7850
  }'
```

#### Batch Telemetry Logging (up to 500 readings):

```bash
curl -L -X POST "https://script.google.com/macros/s/YOUR_EXEC_ID/exec" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "YOUR_20_CHAR_KEY",
    "rows": [
      { "timestamp": "2026-10-13 12:00", "power_kw": 7.4 },
      { "timestamp": "2026-10-13 12:10", "power_kw": 7.8 }
    ]
  }'
```

#### ⚠️ Critical Note for ESP32 / Arduino Microcontrollers:

Google Apps Script endpoints return an **HTTP 302 Redirect** to a Google UserContent domain. When writing C++ code on an ESP32 using `HTTPClient`, you **must** configure redirect following and SSL certificate bypassing:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

void sendSolarTelemetry(float powerKw) {
  WiFiClientSecure client;
  client.setInsecure(); // Essential: Google redirect SSL cert verification

  HTTPClient http;
  http.begin(client, "https://script.google.com/macros/s/YOUR_EXEC_ID/exec");
  
  // CRITICAL: Google Apps Script returns a 302 redirect. Must follow redirects!
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");

  String json = "{\"key\":\"YOUR_KEY\",\"power_kw\":" + String(powerKw, 2) + "}";
  int httpCode = http.POST(json);

  if (httpCode > 0) {
    String response = http.getString();
    Serial.println("Response: " + response);
  } else {
    Serial.println("Error: " + http.errorToString(httpCode));
  }
  http.end();
}
```

---

### Method 2: Manual Row Pasting

If internet access at the inverter is temporarily down, you can paste historical data directly into the Google Sheet:
1. Open the **Readings** tab.
2. Paste rows in columns A through H:
   - `Timestamp (IST)` | `Power (kW)` | `Energy today (kWh)` | `DC voltage` | `DC current` | `AC voltage` | `Frequency` | `Inverter temp`
   - *Only Timestamp and Power (kW) are mandatory.* Timestamps can be `YYYY-MM-DD HH:mm` or `DD/MM/YYYY HH:mm`.
3. In the top menu, click **Solar** > **Sort readings by time**.
4. In the top menu, click **Solar** > **Rebuild daily totals**.
5. All daily generation figures and peak powers are instantly recalculated.

---

## 🔌 API Reference

The backend `doGet` endpoint supports public, read-only JSON queries.

| Route | Query Parameters | Description | Cache Duration |
| :--- | :--- | :--- | :--- |
| `bundle` (default) | `date=YYYY-MM-DD` (optional, defaults to today IST) | Returns plant config, latest metrics, today's 10-minute generation curve points, and reported energy. | 15 seconds |
| `daily` | `month=YYYY-MM` (required, e.g. `2026-10`) | Returns all days in the specified month with date, total energy (kWh), and peak power (kW). | 60 seconds |
| `months` | None | Aggregates all daily historical totals by month since records began. | 60 seconds |
| `ping` | None | Returns server health and current server IST timestamp. | No cache |

---

## 🛠️ Troubleshooting Table

| Symptom | Probable Cause | Remedy |
| :--- | :--- | :--- |
| **"Could not connect to Apps Script: HTTP error 401/403"** | Deployment access restricted. | In Apps Script, click **Deploy** > **Manage deployments** > Edit. Set **Who has access** to **Anyone**. Save as New Version. |
| **"Changes made to Code.gs are not appearing on dashboard"** | Deployment not updated to new version. | Go to **Deploy** > **Manage deployments** > Edit > **Version: New version** > **Deploy**. |
| **"Power exceeds 3x capacity error on ingest"** | Inverter sending Watts instead of Kilowatts (e.g. 8000 instead of 8.0). | Send field `power_w` instead of `power_kw`, or divide by 1000 on your logger before POSTing. |
| **"No data for N minutes alert triggered at night"** | Alert trigger running during darkness. | The health checker automatically ignores readings when sunlight < 150 W/m². If this occurs, verify plant `latitude` and `longitude` in Settings. |
| **"Timestamp is more than 10 minutes in the future"** | Inverter RTC clock is set ahead of Indian Standard Time. | Synchronize inverter clock via NTP or omit `timestamp` field to let Google server timestamp the reading automatically. |
| **"ESP32 HTTP -1 error or connection refused"** | Missing `client.setInsecure()` or `setFollowRedirects`. | Add `client.setInsecure()` and `http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS)` to your Arduino/ESP32 sketch. |
| **"Start month became a date like 01/11/2025 in Settings"** | Sheet auto-formatted text as date. | Ensure column B in Settings is formatted as Plain Text (`@`). `Code.gs` handles this automatically on `setup()`. |

---

## 🔬 Honest Limitations & Physics Model

1. **Modelled Solar Output vs. Pyranometer Sensors:**  
   The expected power benchmark curve ($P_{\text{exp}}$) is computed in real time from **Open-Meteo satellite atmospheric weather data**, not an on-site pyranometer sensor. Rapid cloud passing (micro-climatic shading) directly over the rooftop may take 15–30 minutes to reflect in satellite data.
2. **Solar Physics Formula:**  
   The identical formula is evaluated in both Apps Script and the client dashboard:
   $$\text{expected\_kW} = \text{Capacity}_{\text{kWp}} \times \left(\frac{\text{Radiation}}{1000}\right) \times 0.92 \times \max\left(0.5, 1 - 0.004 \times (T_{\text{cell}} - 25)\right)$$
   $$\text{where } T_{\text{cell}} = T_{\text{ambient}} + 0.03 \times \text{Radiation}$$
   Radiation is shifted by $-30$ minutes to account for Open-Meteo's preceding-hour average reporting.
3. **Synthetic Demo Data:**  
   Demo data generated via `Solar > Add 30 days of SAMPLE data` simulates clear-sky irradiance and cloud variation for testing. It will not match historical meteorological ground-truth.
4. **Security Model:**  
   The read API (`doGet`) is public so campus visitors and students can view generation without logging in. The write endpoint (`doPost`) is secured by your private 20-character `ingest_key`. Keep your `ingest_key` confidential.

---

## 📄 License
MIT License. Created for the Department of Electrical & Electronics Engineering, G. Pulla Reddy Engineering College (GPREC), Kurnool, Andhra Pradesh, India.
