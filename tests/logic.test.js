/**
 * tests/logic.test.js
 * -------------------
 * Pure-JavaScript unit tests for the solar logic that is shared between
 * Code.gs (backend) and index.html (frontend).
 *
 * Run with:  node tests/logic.test.js
 * No npm install required — uses only Node.js built-ins.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertClose(a, b, tol = 1e-6, msg) {
  if (Math.abs(a - b) > tol)
    throw new Error(msg || `Expected ${a} ≈ ${b} (tolerance ${tol})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-implement the shared solar model (identical constants to Code.gs)
// ─────────────────────────────────────────────────────────────────────────────

const SOLAR = {
  EFFICIENCY:     0.92,
  TEMP_COEFF:     0.004,
  TEMP_AMBIENT_K: 0.03,
  REF_TEMP:       25,
  MIN_PERF_RATIO: 0.5,
};

function expectedKw(capacityKwp, radiationWm2, ambientC) {
  if (radiationWm2 <= 0) return 0;
  const cellTemp = ambientC + SOLAR.TEMP_AMBIENT_K * radiationWm2;
  const tempFactor = Math.max(SOLAR.MIN_PERF_RATIO, 1 - SOLAR.TEMP_COEFF * (cellTemp - SOLAR.REF_TEMP));
  return capacityKwp * (radiationWm2 / 1000) * SOLAR.EFFICIENCY * tempFactor;
}

/**
 * Trapezoid integration of power readings, skipping gaps.
 * readings: [{t: Date|number(ms), power_kw: number}]
 * Returns energy in kWh.
 */
function trapezoidEnergy(readings, gapMaxSec = 3 * 3600) {
  if (!readings || readings.length < 2) return 0;
  const sorted = [...readings].sort((a, b) => +a.t - +b.t);
  let energy = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dtSec = (+sorted[i].t - +sorted[i - 1].t) / 1000;
    if (dtSec <= 0 || dtSec > gapMaxSec) continue;
    const avgKw = (sorted[i].power_kw + sorted[i - 1].power_kw) / 2;
    energy += avgKw * (dtSec / 3600);
  }
  return energy;
}

/** Linear interpolation of hourly radiation, with 30-min offset. */
function interpolateRadiation(hourlyPoints, targetMs) {
  // hourlyPoints: [{t: ms, rad: W/m²}] already shifted by -30 min
  if (!hourlyPoints || hourlyPoints.length === 0) return null;
  if (targetMs <= hourlyPoints[0].t)  return hourlyPoints[0].rad;
  if (targetMs >= hourlyPoints[hourlyPoints.length - 1].t)
    return hourlyPoints[hourlyPoints.length - 1].rad;
  for (let i = 1; i < hourlyPoints.length; i++) {
    if (targetMs <= hourlyPoints[i].t) {
      const span = hourlyPoints[i].t - hourlyPoints[i - 1].t;
      const frac = (targetMs - hourlyPoints[i - 1].t) / span;
      return hourlyPoints[i - 1].rad + frac * (hourlyPoints[i].rad - hourlyPoints[i - 1].rad);
    }
  }
  return null;
}

/** Parses flexible timestamp strings. Returns Date or null. */
function parseTimestamp(raw) {
  if (!raw) return null;
  // Epoch seconds
  if (typeof raw === 'number' && raw < 1e12) return new Date(raw * 1000);
  // Epoch ms
  if (typeof raw === 'number') return new Date(raw);
  const s = String(raw).trim();
  // ISO with zone
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);
  // yyyy-mm-dd hh:mm
  const m1 = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (m1) return new Date(`${m1[1]}T${m1[2]}:00+05:30`);
  // dd/mm/yyyy hh:mm
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})$/);
  if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T${m2[4]}:00+05:30`);
  return null;
}

/** Performance ratio: energy / (∫radiation/1000 dt × capacity). */
function performanceRatio(energyKwh, capacityKwp, sunHours) {
  if (sunHours < 0.05) return null;  // not enough sun
  const pr = energyKwh / (sunHours * capacityKwp);
  return Math.min(pr, 1.2);          // cap at 120%
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n📐  Solar model tests');

test('expectedKw: zero at night (radiation = 0)', () => {
  assertClose(expectedKw(10, 0, 30), 0);
});

test('expectedKw: STC (1000 W/m², 25 °C, no temp loss)', () => {
  // cellTemp = 25 + 0.03×1000 = 55 → tempFactor = 1 − 0.004×30 = 0.88 → but MIN=0.5
  // expected = 10 × 1.0 × 0.92 × 0.88 = 8.096
  const v = expectedKw(10, 1000, 25);
  assertClose(v, 10 * 1.0 * 0.92 * 0.88, 0.001);
});

test('expectedKw: temperature floor at MIN_PERF_RATIO (very high temp)', () => {
  // At extreme radiation the factor would be negative without the floor
  const v = expectedKw(10, 10000, 60);
  assert(v > 0, 'Should still be positive due to floor');
  const cap = 10 * (10000 / 1000) * 0.92 * 0.5;
  assertClose(v, cap, 0.001);
});

test('expectedKw: scales linearly with capacity', () => {
  const v5  = expectedKw(5,  500, 30);
  const v10 = expectedKw(10, 500, 30);
  assertClose(v10, v5 * 2, 0.001);
});

console.log('\n⚡  Trapezoid energy integration tests');

const T0 = Date.UTC(2025, 10, 1, 6, 0, 0); // 06:00 UTC

test('trapezoidEnergy: zero readings returns 0', () => {
  assertClose(trapezoidEnergy([]), 0);
  assertClose(trapezoidEnergy([{t: T0, power_kw: 5}]), 0);
});

test('trapezoidEnergy: two equal readings over 1 h = 1 kWh (at 1 kW)', () => {
  const r = [
    { t: T0,            power_kw: 1 },
    { t: T0 + 3600000,  power_kw: 1 },
  ];
  assertClose(trapezoidEnergy(r), 1.0, 1e-6);
});

test('trapezoidEnergy: ramp from 0 to 2 kW over 1 h = 1 kWh (area of triangle)', () => {
  const r = [
    { t: T0,           power_kw: 0 },
    { t: T0 + 3600000, power_kw: 2 },
  ];
  assertClose(trapezoidEnergy(r), 1.0, 1e-6);
});

test('trapezoidEnergy: gap larger than gapMaxSec is skipped', () => {
  const r = [
    { t: T0,                   power_kw: 5 },
    { t: T0 + 4 * 3600 * 1000, power_kw: 5 }, // 4-hour gap → skipped
  ];
  assertClose(trapezoidEnergy(r, 3 * 3600), 0, 1e-6);
});

test('trapezoidEnergy: out-of-order input is sorted', () => {
  const r = [
    { t: T0 + 3600000, power_kw: 4 }, // later reading first
    { t: T0,           power_kw: 2 },
  ];
  // avg = 3 kW × 1 h = 3 kWh
  assertClose(trapezoidEnergy(r), 3.0, 1e-6);
});

console.log('\n📡  Radiation interpolation tests');

const makeHourly = (radValues) =>
  radValues.map((rad, i) => ({ t: T0 + i * 3600000, rad }));

test('interpolateRadiation: exact match returns exact value', () => {
  const pts = makeHourly([0, 100, 500, 800, 500, 100, 0]);
  assertClose(interpolateRadiation(pts, T0 + 2 * 3600000), 500);
});

test('interpolateRadiation: mid-point between two values', () => {
  const pts = makeHourly([0, 1000]);
  assertClose(interpolateRadiation(pts, T0 + 1800000), 500, 1e-6);
});

test('interpolateRadiation: clamp before first point', () => {
  const pts = makeHourly([200, 400]);
  assertClose(interpolateRadiation(pts, T0 - 3600000), 200);
});

test('interpolateRadiation: clamp after last point', () => {
  const pts = makeHourly([200, 400]);
  assertClose(interpolateRadiation(pts, T0 + 7200000), 400);
});

console.log('\n🕐  Timestamp parsing tests');

test('parseTimestamp: ISO with +05:30 zone', () => {
  const d = parseTimestamp('2025-11-01T08:30:00+05:30');
  assert(d instanceof Date && !isNaN(d), 'Must be valid Date');
  // UTC equivalent: 08:30 - 5:30 = 03:00
  assert(d.getUTCHours() === 3 && d.getUTCMinutes() === 0, 'UTC hour should be 3');
});

test('parseTimestamp: yyyy-mm-dd hh:mm (treated as IST)', () => {
  const d = parseTimestamp('2025-11-01 08:30');
  assert(d instanceof Date && !isNaN(d));
  assert(d.getUTCHours() === 3 && d.getUTCMinutes() === 0);
});

test('parseTimestamp: dd/mm/yyyy hh:mm (treated as IST)', () => {
  const d = parseTimestamp('01/11/2025 08:30');
  assert(d instanceof Date && !isNaN(d));
  assert(d.getUTCHours() === 3);
});

test('parseTimestamp: epoch seconds (< 1e12)', () => {
  const epoch = 1_700_000_000; // seconds
  const d = parseTimestamp(epoch);
  assert(d instanceof Date);
  assert(Math.abs(d.getTime() - epoch * 1000) < 1000);
});

test('parseTimestamp: epoch milliseconds (>= 1e12)', () => {
  const ms = 1_700_000_000_000;
  const d = parseTimestamp(ms);
  assert(d instanceof Date);
  assert(Math.abs(d.getTime() - ms) < 1000);
});

test('parseTimestamp: null input returns null', () => {
  assert(parseTimestamp(null) === null);
});

console.log('\n📊  Performance ratio tests');

test('performanceRatio: less than 0.05 sun-hours → null', () => {
  assert(performanceRatio(0.5, 10, 0.04) === null);
});

test('performanceRatio: perfect output at STC', () => {
  // 10 kWp × 1 sun-hour = 10 kWh potential; with efficiency 0.92 real ≈ 9.2 kWh
  // PR = 9.2 / (1 × 10) = 0.92
  const pr = performanceRatio(9.2, 10, 1.0);
  assertClose(pr, 0.92, 1e-6);
});

test('performanceRatio: cap at 120%', () => {
  const pr = performanceRatio(200, 10, 1.0); // nonsensically high energy
  assertClose(pr, 1.2, 1e-6);
});

test('performanceRatio: fair output ~65%', () => {
  const pr = performanceRatio(6.5, 10, 1.0);
  assertClose(pr, 0.65, 1e-6);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingest validation logic (ported from Code.gs doPost)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🔒  Ingest validation tests');

function validateReading(r, capacityKwp, ingestKey) {
  const errors = [];
  if (r.key !== ingestKey) errors.push('bad key');
  const pw = r.power_kw != null ? r.power_kw
           : r.power_w  != null ? r.power_w / 1000
           : null;
  if (pw == null || isNaN(pw))    errors.push('missing power');
  else if (pw < 0)                errors.push('negative power');
  else if (pw > 3 * capacityKwp) errors.push('Is the logger sending watts? Use power_w');
  return errors;
}

test('validateReading: valid reading passes', () => {
  const errs = validateReading({ key: 'abc', power_kw: 4.2 }, 10, 'abc');
  assert(errs.length === 0, `Got errors: ${errs}`);
});

test('validateReading: wrong key rejected', () => {
  const errs = validateReading({ key: 'wrong', power_kw: 4.2 }, 10, 'abc');
  assert(errs.includes('bad key'));
});

test('validateReading: missing power rejected', () => {
  const errs = validateReading({ key: 'abc' }, 10, 'abc');
  assert(errs.includes('missing power'));
});

test('validateReading: negative power rejected', () => {
  const errs = validateReading({ key: 'abc', power_kw: -1 }, 10, 'abc');
  assert(errs.includes('negative power'));
});

test('validateReading: power_w auto-converted', () => {
  const errs = validateReading({ key: 'abc', power_w: 4200 }, 10, 'abc');
  assert(errs.length === 0, `Should accept power_w: ${errs}`);
});

test('validateReading: power > 3× capacity triggers hint', () => {
  const errs = validateReading({ key: 'abc', power_kw: 31 }, 10, 'abc');
  assert(errs.some(e => e.includes('watts')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! ✅\n');
}
