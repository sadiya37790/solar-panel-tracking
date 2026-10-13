# ☀️ GPREC Solar Power Monitoring Dashboard

A **free, end-to-end solar monitoring system** for the GPREC EEE Block 1 solar plant (or any rooftop plant).  
Non-technical visitors — students, lecturers, guests — can understand the page at a glance.

```
┌─────────────────────────┐        HTTPS / JSON        ┌───────────────────────┐
│  Google Sheet           │ ◄──────────────────────── │  index.html (Vercel)  │
│  (your data & settings) │                            │  (the web page)       │
│  + Apps Script          │ ──────────────────────────►│                       │
│  (the brains)           │                            └───────────────────────┘
└─────────────────────────┘
         ▲
         │  POST /exec  (your inverter logger or a cron script)
```

---

## What you need (all free)

| Tool | Why |
|------|-----|
| **Google account** | Hosts the Sheet and the backend |
| **Vercel account** | Hosts the webpage (one click, free) |
| A modern web browser | That's it |

---

## Step 1 — Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a **blank spreadsheet**.  
   Name it anything, e.g. *GPREC Solar Monitor*.
2. Open **Extensions → Apps Script**.  
   A code editor opens in a new tab.

---

## Step 2 — Add the backend code

1. In Apps Script, delete any placeholder code in `Code.gs`.
2. Copy the entire contents of [`backend/Code.gs`](backend/Code.gs) and paste it.
3. Click **＋ (Add a file) → Script** and name it nothing (just close the dialog) — actually you only need the one file.
4. Click the **⚙ Project settings** gear on the left sidebar.  
   Scroll down and make sure **"Show 'appsscript.json' manifest file in editor"** is **ticked**.
5. Click the `appsscript.json` file that now appears in the file list.  
   Replace its contents with the contents of [`backend/appsscript.json`](backend/appsscript.json).
6. Click **💾 Save project** (or `Ctrl+S`).

---

## Step 3 — Run the one-time setup

1. In Apps Script, choose the function `setup` from the function drop-down (top-centre).
2. Click **▶ Run**.
3. A permissions dialog will appear — click **Review permissions → Allow**.  
   *(This lets the script edit its own spreadsheet.)*
4. Switch back to your Google Sheet.  
   You should see five new sheets: **Readings, Daily, Settings, Alerts, Start here**.
5. Open the **Settings** sheet and customise any values you like (plant name, capacity, email for alerts, etc.).  
   The `ingest_key` column was auto-generated — copy it somewhere safe; your logger will need it.

---

## Step 4 — Deploy the backend as a web app

1. In Apps Script, click **Deploy → New deployment**.
2. Click the ⚙ gear next to **"Select type"** and choose **Web app**.
3. Fill in:
   - **Description:** `Solar Monitor v1`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone` *(no sign-in — the page is read-only)*
4. Click **Deploy**.
5. Copy the **Web app URL** that ends in `/exec`. You'll need it in Step 6.

> **Re-deploying after a code change:** go to **Deploy → Manage deployments → ✏ Edit → New version → Deploy**.  
> The URL stays the same.

---

## Step 5 — Turn on automatic health checks (optional but recommended)

1. In Apps Script, run the function `installTriggers`.  
   This sets up a background job that checks for faults every 10 minutes and emails `alert_email` if something goes wrong.
2. You can also add 30 days of realistic sample data via the **☀ Solar** menu that appeared in your Sheet.

---

## Step 6 — Deploy the frontend to Vercel

1. Open [`index.html`](index.html) in a text editor.
2. Find this line near the top of the `<script>` section:
   ```js
   const API_URL = '';  // paste the Apps Script /exec URL here
   ```
3. Paste your `/exec` URL between the quotes:
   ```js
   const API_URL = 'https://script.google.com/macros/s/AKfy…/exec';
   ```
4. Save the file.

### Deploy to Vercel (easiest way)

**Option A — Drag & drop (no account needed for a quick preview)**
1. Go to [vercel.com/new](https://vercel.com/new).
2. Drag the `solar-dashboard` folder onto the page.
3. Click **Deploy**. Done ✅

**Option B — GitHub + Vercel (recommended for updates)**
1. Push this folder to a GitHub repository.
2. Import the repository on Vercel: [vercel.com/import](https://vercel.com/import).
3. Vercel detects a static site automatically.  
   Set **Output directory** to `.` (a single dot) and click **Deploy**.
4. Every future `git push` will automatically update your live site.

---

## Step 7 — Connect your inverter (or send data manually)

Your inverter logger (or any script) can push readings via HTTP POST:

```bash
curl -X POST "YOUR_EXEC_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "YOUR_INGEST_KEY",
    "power_kw": 4.2,
    "energy_today_kwh": 18.5,
    "ac_voltage": 231,
    "frequency_hz": 50.01,
    "inverter_temp_c": 42
  }'
```

| Field | Required? | Notes |
|-------|-----------|-------|
| `key` | ✅ | Your `ingest_key` from the Settings sheet |
| `power_kw` | ✅ | Current output in kilowatts |
| `power_w` | alternative | Send watts instead — the backend converts automatically |
| `energy_today_kwh` | recommended | Today's total from the inverter; calculated automatically if omitted |
| `timestamp` | optional | ISO 8601, epoch ms/s, or `yyyy-mm-dd hh:mm`. Defaults to now. |
| `dc_voltage`, `dc_current`, `ac_voltage`, `frequency_hz`, `inverter_temp_c` | optional | Shown in the Inverter Readings table |

**Batch ingest** (up to 500 readings at once):
```json
{ "key": "…", "rows": [ {…}, {…}, {…} ] }
```

---

## Settings reference

Open the **Settings** sheet in your Google Sheet to change any of these:

| Key | Default | What it means |
|-----|---------|---------------|
| `plant_name` | GPREC EEE Block 1 | Shown at the top of the dashboard |
| `capacity_kwp` | 10 | Total installed capacity in kilowatts-peak |
| `latitude` / `longitude` | 15.81 / 78.05 | Used for weather and sun-up/sun-down times |
| `start_month` | 2025-11 | Oldest month shown in the history chart |
| `alert_drop_percent` | 50 | Alert if output drops below this % of expected |
| `alert_min_sunlight` | 150 W/m² | Minimum sunshine before alerts are raised |
| `alert_readings_in_a_row` | 3 | How many consecutive low readings trigger an alert |
| `alert_email` | *(blank)* | Email address for fault notifications |
| `tariff_per_kwh` | 7 | Electricity price in ₹, used for savings estimate |
| `co2_kg_per_kwh` | 0.7 | CO₂ avoided per kWh, used for impact strip |
| `ingest_key` | *(auto-generated)* | Secret token for your logger — keep it private |

---

## Testing without a real inverter

1. Open the **☀ Solar** menu in your Sheet and click **Add 30 days of SAMPLE data**.  
   This fills the Sheet with realistic readings (10-minute intervals, cloud factors, etc.).
2. Open your Vercel URL — the dashboard will show live-looking data.
3. On the webpage itself, you can also append `?demo=1` to the URL to run a fully local simulation with no Sheet at all.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| "Not connected" banner | `API_URL` is empty or wrong | Paste the correct `/exec` URL in `index.html` |
| CORS error in browser console | Web app not deployed as `Anyone` | Redeploy with **Who has access: Anyone** |
| Ingest returns `{ok:false, error:"bad key"}` | Wrong `ingest_key` | Copy the key from the Settings sheet |
| Data shows but is hours old | Cache not cleared | Wait 60 s, or redeploy the Apps Script |
| No email alerts | `alert_email` blank | Add an email in the Settings sheet |
| "Is the logger sending watts?" hint | `power_kw` > 30 (3× capacity) | Use `power_w` field or divide by 1000 |

---

## File structure

```
solar-dashboard/
├── index.html          ← The entire frontend (deploy this to Vercel)
├── README.md           ← This file
└── backend/
    ├── Code.gs         ← Google Apps Script backend
    └── appsscript.json ← Apps Script project manifest
```

---

## Assumptions made

- **Capacity placeholder:** 10 kWp — update `capacity_kwp` in the Settings sheet once you know the real value.
- **Tariff:** ₹7/kWh — a typical AP DISCOM commercial rate; change `tariff_per_kwh` if different.
- **CO₂ factor:** 0.7 kg/kWh — India's average grid emission factor (CEA 2022-23).
- **Sun hours:** The page shows "sun up ~6:00 am to ~6:00 pm" as a default and refines it from the Open-Meteo radiation series.
- **Data start:** November 2025 (`start_month`). The history chart will not show months before this.
- **No DST:** IST is UTC+5:30 year-round; no daylight-saving adjustments are applied.

---

*Built with Google Apps Script, vanilla HTML/CSS/JS, and Open-Meteo (free weather API). No paid services required.*
