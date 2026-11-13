// ============================================================================
//  GPREC EEE Block-1 — Solar Data Logger
//  Board  : ESP32 Dev Module  (Arduino framework)
//  Meter  : PZEM-004T v3.0
//  Inverter: Single-phase
// ============================================================================
//
//  WIRING DIAGRAM
//  ──────────────
//  PZEM-004T v3.0          ESP32 Dev Module
//  ──────────────          ────────────────
//  5 V  ─────────────────► 5 V  (Vin pin)
//  GND  ─────────────────► GND
//  TX   ─────────────────► GPIO 16  (Serial2 RX)
//  RX   ─────────────────► GPIO 17  (Serial2 TX)
//
//  AC side of PZEM-004T (the coil clamp / screw terminals):
//    L (Live) and N (Neutral) are connected to the AC output of your inverter.
//
//  ⚠️  WARNING — LETHAL VOLTAGE
//  ════════════════════════════
//  The AC terminals of the PZEM-004T carry 230 V AC.
//  ALL AC wiring MUST be performed by a qualified electrician.
//  Never touch or modify AC wiring while the system is powered.
//  Failure to follow this warning can cause death or serious injury.
// ============================================================================
//
//  LIBRARIES REQUIRED (install via Arduino Library Manager)
//  ────────────────────────────────────────────────────────
//  • PZEM004Tv30   by Jakub Mandula   (search "PZEM004T")
//  • ArduinoJson   by Benoit Blanchon (search "ArduinoJson", install v6.x)
//  • ESP32 board core: add  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
//    in File → Preferences → Additional boards manager URLs,
//    then install "esp32 by Espressif Systems" in Boards Manager.
// ============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>
#include <time.h>

// ============================================================================
//  CONFIGURATION — fill in before flashing
// ============================================================================
static const char* WIFI_SSID     = "YOUR_WIFI_NAME";       // <── change
static const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";   // <── change
static const char* INGEST_KEY    = "YOUR_INGEST_KEY";      // <── from Solar_Settings tab in your Sheet

static const char* EXEC_URL =
  "https://script.google.com/macros/s/"
  "AKfycbzDnjOTxlHeS_1h79IkF__LoeViCFfw7U5DcanqaTKCbm5IdZxY2KWePnLJOetgA-kF"
  "/exec";

// ============================================================================
//  PIN ASSIGNMENTS
// ============================================================================
#define PZEM_RX_PIN   16    // ESP32 Serial2 RX  ← PZEM TX
#define PZEM_TX_PIN   17    // ESP32 Serial2 TX  → PZEM RX

// ============================================================================
//  TIMING CONSTANTS
// ============================================================================
static const uint32_t SAMPLE_MS         =  30UL * 1000;   // read meter every 30 s
static const uint32_t QUEUE_MS          =   5UL * 60000;  // queue row every 5 min (normal)
static const uint32_t IDLE_QUEUE_MS     =  15UL * 60000;  // queue row every 15 min (idle)
static const uint32_t WATCHDOG_MS       = 120UL * 60000;  // restart if no upload for 2 h
static const uint32_t RETRY_ERR_MS      =   1UL * 60000;  // retry after error: 1 min
static const uint32_t RETRY_AUTH_MS     =  10UL * 60000;  // retry after Unauthorized: 10 min

static const int      MAX_QUEUE_ROWS    = 144;             // ~12 h at 5-min intervals
static const int      BATCH_SIZE        =  20;             // rows per POST

// ============================================================================
//  VALIDATION LIMITS
// ============================================================================
static const float    MAX_POWER_KW      = 60.0f;
static const float    MIN_VOLTAGE_V     = 10.0f;
static const float    MAX_VOLTAGE_V     = 280.0f;
static const float    IDLE_POWER_KW     =  0.02f;

// ============================================================================
//  ROW QUEUE  (circular buffer)
// ============================================================================
struct Row {
  char  ts[20];         // "YYYY-MM-DD HH:MM:SS"
  float power_kw;
  float ac_voltage;
  float frequency_hz;
};

static Row   Q[MAX_QUEUE_ROWS];
static int   qHead = 0, qLen = 0;

static void qPush(const Row& r) {
  int idx = (qHead + qLen) % MAX_QUEUE_ROWS;
  Q[idx] = r;
  if (qLen < MAX_QUEUE_ROWS) {
    qLen++;
  } else {
    qHead = (qHead + 1) % MAX_QUEUE_ROWS;   // drop oldest
    Serial.println("[QUEUE] Buffer full — dropped oldest row");
  }
}

static void qDrop(int n) {
  n = min(n, qLen);
  qHead = (qHead + n) % MAX_QUEUE_ROWS;
  qLen -= n;
}

// ============================================================================
//  METER — isolate all PZEM code here; swap to a different meter by editing
//          only this function.
// ============================================================================
static HardwareSerial pzemSerial(2);
static PZEM004Tv30    pzem(pzemSerial, PZEM_RX_PIN, PZEM_TX_PIN);

/**
 * Read PZEM-004T.
 * Returns true if reading is valid and sane.
 * Outputs: powerKw, acV, hz.
 */
bool readMeter(float& powerKw, float& acV, float& hz) {
  float v  = pzem.voltage();
  float pw = pzem.power();      // watts
  float f  = pzem.frequency();

  if (isnan(v) || isnan(pw) || isnan(f)) {
    Serial.println("[METER] NaN — skipped");
    return false;
  }
  if (v < MIN_VOLTAGE_V || v > MAX_VOLTAGE_V) {
    Serial.printf("[METER] Voltage %.1f V out of range — skipped\n", v);
    return false;
  }
  if (pw < 0.0f) {
    Serial.printf("[METER] Negative power %.1f W — skipped\n", pw);
    return false;
  }

  powerKw = pw / 1000.0f;

  if (powerKw > MAX_POWER_KW) {
    Serial.printf("[METER] Power %.2f kW > limit %.0f kW — skipped\n",
                  powerKw, MAX_POWER_KW);
    return false;
  }

  acV = v;
  hz  = f;
  return true;
}

// ============================================================================
//  NTP / TIMESTAMP  (IST = UTC + 5:30 = 19800 s)
// ============================================================================
static bool clockReady() {
  return time(nullptr) > 1700000000UL;
}

static bool getIST(char* buf, size_t len) {
  if (!clockReady()) return false;
  time_t now = time(nullptr);
  struct tm t;
  localtime_r(&now, &t);
  strftime(buf, len, "%Y-%m-%d %H:%M:%S", &t);
  return true;
}

static void syncNTP() {
  Serial.print("[NTP] Syncing");
  configTime(19800, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");
  for (int i = 0; i < 40; i++) {
    delay(500);
    Serial.print('.');
    if (clockReady()) { Serial.println(" OK"); return; }
  }
  Serial.println(" TIMEOUT (will retry later)");
}

// ============================================================================
//  Wi-Fi
// ============================================================================
static void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[WiFi] Connecting to '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.print('.');
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected — IP %s\n",
                  WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] FAILED — will retry");
  }
}

// ============================================================================
//  HTTP POST  with manual 302-redirect handling
//
//  Google Apps Script /exec always returns HTTP 302 → Location.
//  We must NOT auto-follow; we do a separate GET to that URL to read JSON.
//
//  Return values:
//    >= 0  : number of rows confirmed saved
//    -1    : network / server error (keep rows, retry in 1 min)
//    -2    : Unauthorized (wrong key, pause 10 min)
// ============================================================================
static int postRows(const Row* rows, int n) {
  // ── Build JSON ──────────────────────────────────────────────────────────
  StaticJsonDocument<4096> doc;
  doc["key"] = INGEST_KEY;
  JsonArray arr = doc.createNestedArray("rows");
  for (int i = 0; i < n; i++) {
    JsonObject obj = arr.createNestedObject();
    obj["timestamp"]    = rows[i].ts;
    obj["power_kw"]     = serialized(String(rows[i].power_kw,    3));
    obj["ac_voltage"]   = serialized(String(rows[i].ac_voltage,  1));
    obj["frequency_hz"] = serialized(String(rows[i].frequency_hz,2));
  }
  String body;
  serializeJson(doc, body);

  Serial.printf("[HTTP] POSTing %d rows (%u bytes)\n", n, body.length());

  // ── Step 1: POST to /exec — capture Location, do NOT follow ─────────────
  WiFiClientSecure c1;
  c1.setInsecure();   // acceptable for a data-logger; replace with root-CA for production

  HTTPClient h1;
  h1.begin(c1, EXEC_URL);
  h1.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  h1.addHeader("Content-Type",  "application/json");
  h1.addHeader("Accept",        "application/json");

  const char* hdrsToCapture[] = { "Location" };
  h1.collectHeaders(hdrsToCapture, 1);

  int code1 = h1.POST(body);
  Serial.printf("[HTTP] Step-1 response: %d\n", code1);

  String location = "";
  if (code1 == 301 || code1 == 302 || code1 == 303 || code1 == 307 || code1 == 308) {
    location = h1.header("Location");
    Serial.printf("[HTTP] Redirect → %s\n", location.c_str());
  }
  h1.end();

  if (location.isEmpty()) {
    Serial.println("[HTTP] No Location header — giving up this attempt");
    return -1;
  }

  // ── Step 2: GET the redirect URL — read JSON response ───────────────────
  delay(400);
  WiFiClientSecure c2;
  c2.setInsecure();
  HTTPClient h2;
  h2.begin(c2, location);
  h2.addHeader("Accept", "application/json");
  int code2 = h2.GET();
  String reply = h2.getString();
  h2.end();

  Serial.printf("[HTTP] Step-2 response (%d): %.200s\n", code2, reply.c_str());

  // ── Step 3: Parse JSON ───────────────────────────────────────────────────
  StaticJsonDocument<512> rep;
  if (deserializeJson(rep, reply) != DeserializationError::Ok) {
    Serial.println("[HTTP] JSON parse error on response");
    return -1;
  }

  if (rep.containsKey("saved")) {
    int saved = rep["saved"].as<int>();
    Serial.printf("[HTTP] ✓ saved=%d\n", saved);
    return saved;
  }

  if (rep.containsKey("error")) {
    String err = rep["error"].as<String>();
    if (err == "Unauthorized") {
      Serial.println("[HTTP] *** UNAUTHORIZED — check INGEST_KEY in firmware ***");
      return -2;
    }
    Serial.printf("[HTTP] Server error: %s\n", err.c_str());
    return -1;
  }

  Serial.printf("[HTTP] Unrecognised response: %.100s\n", reply.c_str());
  return -1;
}

// ============================================================================
//  UPLOAD MANAGER
// ============================================================================
static uint32_t lastUploadOkMs  = 0;
static uint32_t lastUploadTryMs = 0;
static uint32_t nextRetryMs     = RETRY_ERR_MS;

static void tryUpload() {
  if (qLen == 0)                           return;
  if (WiFi.status() != WL_CONNECTED)      { connectWiFi(); return; }
  if (!clockReady())                       { syncNTP(); return; }

  uint32_t now = millis();
  if (now - lastUploadTryMs < nextRetryMs) return;
  lastUploadTryMs = now;

  int batch = min(qLen, BATCH_SIZE);
  Row buf[BATCH_SIZE];
  for (int i = 0; i < batch; i++)
    buf[i] = Q[(qHead + i) % MAX_QUEUE_ROWS];

  int result = postRows(buf, batch);

  if (result >= 0) {
    qDrop(batch);
    lastUploadOkMs = millis();
    nextRetryMs    = RETRY_ERR_MS;
    Serial.printf("[QUEUE] Uploaded %d rows. %d remaining.\n", batch, qLen);
  } else if (result == -2) {
    nextRetryMs = RETRY_AUTH_MS;
  } else {
    nextRetryMs = RETRY_ERR_MS;
    Serial.printf("[QUEUE] Upload failed — retry in %lu s\n", nextRetryMs / 1000);
  }
}

// ============================================================================
//  SAMPLING STATE
// ============================================================================
struct Accum { float pw; float v; float hz; int n; };
static Accum   acc          = {0, 0, 0, 0};
static uint32_t lastSampleMs = 0;
static uint32_t lastQueueMs  = 0;

// ============================================================================
//  SETUP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(600);
  Serial.println();
  Serial.println("================================================");
  Serial.println("  GPREC Solar Logger  |  ESP32 + PZEM-004T v3");
  Serial.println("================================================");

  connectWiFi();
  if (WiFi.status() == WL_CONNECTED) syncNTP();

  lastSampleMs  = millis();
  lastQueueMs   = millis();
  lastUploadOkMs= millis();   // give 2 h from boot before watchdog fires

  Serial.println("[SETUP] Running. Meter every 30 s, queue every 5 min.");
}

// ============================================================================
//  LOOP
// ============================================================================
void loop() {
  uint32_t now = millis();

  // ── Maintain Wi-Fi ───────────────────────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Reconnecting...");
    connectWiFi();
    if (WiFi.status() == WL_CONNECTED && !clockReady()) syncNTP();
  }

  // ── Sample meter every 30 s ──────────────────────────────────────────────
  if (now - lastSampleMs >= SAMPLE_MS) {
    lastSampleMs = now;
    float pw, v, hz;
    if (readMeter(pw, v, hz)) {
      acc.pw += pw; acc.v += v; acc.hz += hz; acc.n++;
      Serial.printf("[METER] %.3f kW | %.1f V | %.2f Hz  (avg over %d samples)\n",
                    pw, v, hz, acc.n);
    }
  }

  // ── Queue averaged row (5 min normal, 15 min idle) ───────────────────────
  float curPow  = (acc.n > 0) ? (acc.pw / acc.n) : 0.0f;
  uint32_t qInt = (curPow < IDLE_POWER_KW) ? IDLE_QUEUE_MS : QUEUE_MS;

  if (now - lastQueueMs >= qInt) {
    lastQueueMs = now;

    if (acc.n > 0) {
      char ts[20];
      if (!getIST(ts, sizeof(ts))) {
        Serial.println("[QUEUE] Clock not set — row skipped");
      } else {
        Row r;
        strlcpy(r.ts, ts, sizeof(r.ts));
        r.power_kw    = acc.pw / acc.n;
        r.ac_voltage  = acc.v  / acc.n;
        r.frequency_hz= acc.hz / acc.n;
        qPush(r);
        Serial.printf("[QUEUE] Queued %s | %.3f kW | %d rows pending\n",
                      r.ts, r.power_kw, qLen);
      }
    } else {
      Serial.println("[QUEUE] No valid samples this interval — skipped");
    }
    acc = {0, 0, 0, 0};   // reset accumulator
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  tryUpload();

  // ── Watchdog: restart if nothing uploaded in 2 h (and queue has rows) ───
  if (qLen > 0 && (millis() - lastUploadOkMs) >= WATCHDOG_MS) {
    Serial.println("[WATCHDOG] No upload for 2 h — restarting ESP32");
    delay(1000);
    ESP.restart();
  }

  delay(100);
}
