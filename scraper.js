/**
 * scraper.js — AlsoEnergy API scraper for CLN Community Solar dashboard
 *
 * Authenticates with the AlsoEnergy PowerTrack API and pulls:
 *   - Current power (kW) from the production meter (15-min bins)
 *   - Today's / yesterday's energy production (kWh)
 *   - Last 30 days of daily production history
 *   - Weather data
 *   - CO₂ / environmental equivalence data
 *   - Sunrise/sunset from Open-Meteo (free, no key)
 *
 * Writes public/data.json + public/history.json for the dashboard.
 *
 * Environment variables:
 *   ALSO_ENERGY_USERNAME  — AlsoEnergy account email
 *   ALSO_ENERGY_PASSWORD  — AlsoEnergy account password
 */

const fs = require('fs');
const https = require('https');

// ── Config ───────────────────────────────────────────────────
const SITE_ID = 72296;             // ASG 8 — Cuidando Los Niños
const METER_ID = 570224;           // METER - PRODUCTION
const PV_SIZE_AC = 4975;           // kW AC system size
const PV_SIZE_DC = 6499;           // kW DC system size
const LAT = 34.6612;
const LON = -106.7747;

const USERNAME = process.env.ALSO_ENERGY_USERNAME;
const PASSWORD = process.env.ALSO_ENERGY_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Missing ALSO_ENERGY_USERNAME or ALSO_ENERGY_PASSWORD');
  process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────
function request(method, url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers: { ...headers }
    };
    if (body) {
      const buf = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(buf);
    }
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${u.pathname} → ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── AlsoEnergy auth ──────────────────────────────────────────
async function getToken() {
  const body = `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
  const res = await request('POST', 'https://api.alsoenergy.com/Auth/token', {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, body);
  if (!res.access_token) throw new Error('Auth failed: ' + JSON.stringify(res));
  return res.access_token;
}

// ── API wrappers ─────────────────────────────────────────────
function api(token, method, path, body) {
  const hdrs = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  return request(method, `https://api.alsoenergy.com${path}`, hdrs, body);
}

/** Query BinData — the main time-series endpoint */
function binData(token, from, to, binSize, fields) {
  const qs = `fromLocalTime=${from}&toLocalTime=${to}&binSizes=${binSize}`;
  return api(token, 'POST', `/Data/BinData?${qs}`, fields);
}

// ── Date helpers (Mountain Time) ─────────────────────────────
function mtnNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Denver' }));
}
function fmtLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(d) { return fmtLocal(d).split('T')[0]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// ── Sunrise / Sunset from Open-Meteo ─────────────────────────
async function getSunTimes() {
  try {
    const d = await request('GET',
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=sunrise,sunset&timezone=America%2FDenver&forecast_days=1`);
    const rise = d.daily?.sunrise?.[0]; // "2026-04-13T06:57"
    const set = d.daily?.sunset?.[0];
    const fmtTime = iso => {
      const dt = new Date(iso);
      let h = dt.getHours(), m = dt.getMinutes();
      const ap = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12; if (h === 0) h = 12;
      return `${h}:${String(m).padStart(2, '0')} ${ap} MDT`;
    };
    return { sunrise: fmtTime(rise), sunset: fmtTime(set) };
  } catch (e) {
    console.error('Sun times failed:', e.message);
    return { sunrise: '6:57 AM MDT', sunset: '7:24 PM MDT' };
  }
}

// ── Sun elevation calc ───────────────────────────────────────
function sunElevation(lat, lon) {
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
  const declination = 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));
  const hourAngle = (now.getUTCHours() + now.getUTCMinutes() / 60 + lon / 15 - 12) * 15;
  const latRad = lat * Math.PI / 180;
  const decRad = declination * Math.PI / 180;
  const haRad = hourAngle * Math.PI / 180;
  const sinElev = Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  return Math.round(Math.asin(sinElev) * 180 / Math.PI * 10) / 10;
}

// ── Format kWh to readable value + unit ──────────────────────
function fmtEnergy(kwh) {
  if (kwh >= 1e6) return { value: (kwh / 1e6).toFixed(2), unit: 'GWh' };
  if (kwh >= 1e3) return { value: (kwh / 1e3).toFixed(2), unit: 'MWh' };
  return { value: Math.round(kwh).toString(), unit: 'kWh' };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('Authenticating with AlsoEnergy API...');
  const token = await getToken();
  console.log('Authenticated. Fetching data for site', SITE_ID);

  const now = mtnNow();
  const todayStart = fmtDate(now) + 'T00:00:00';
  const nowLocal = fmtLocal(now);
  const yesterday = addDays(now, -1);
  const yesterdayStart = fmtDate(yesterday) + 'T00:00:00';
  const yesterdayEnd = fmtDate(now) + 'T00:00:00';
  const thirtyDaysAgo = addDays(now, -30);

  // ── Parallel API calls ───────────────────────────────────
  const [
    currentPower,     // Most recent 15-min kW from meter
    todayEnergy,      // Today's kWh (site summary)
    yesterdayEnergy,   // Yesterday's kWh
    historyEnergy,     // Daily kWh for last 30 days
    weather,          // Current weather
    sunTimes          // Sunrise/sunset
  ] = await Promise.all([
    // Current power: last 30 minutes of 15-min bins from meter
    binData(token, fmtLocal(addDays(now, 0)).replace(/T.*/, 'T' + String(now.getHours()).padStart(2, '0') + ':00:00'),
      nowLocal, 'Bin15Min',
      [{ hardwareId: METER_ID, fieldName: 'KW', function: 'Avg' }])
      .catch(e => { console.error('currentPower:', e.message); return null; }),

    // Today's production (site summary)
    binData(token, todayStart, nowLocal, 'BinDay',
      [{ siteId: SITE_ID, fieldName: 'ProdKWH', function: 'Diff' }])
      .catch(e => { console.error('todayEnergy:', e.message); return null; }),

    // Yesterday's production
    binData(token, yesterdayStart, yesterdayEnd, 'BinDay',
      [{ siteId: SITE_ID, fieldName: 'ProdKWH', function: 'Diff' }])
      .catch(e => { console.error('yesterdayEnergy:', e.message); return null; }),

    // Last 30 days daily history
    binData(token, fmtDate(thirtyDaysAgo) + 'T00:00:00', yesterdayEnd, 'BinDay',
      [{ siteId: SITE_ID, fieldName: 'ProdKWH', function: 'Diff' }])
      .catch(e => { console.error('historyEnergy:', e.message); return null; }),

    // Weather
    api(token, 'GET', `/Sites/${SITE_ID}/Weather`)
      .catch(e => { console.error('weather:', e.message); return null; }),

    // Sunrise/sunset
    getSunTimes()
  ]);

  // ── Parse results ────────────────────────────────────────

  // Current kW: take the last non-zero bin
  let currentKW = '—';
  let lastGoodKW = null;
  let lastGoodKWTime = null;
  if (currentPower?.items?.length) {
    for (let i = currentPower.items.length - 1; i >= 0; i--) {
      const val = currentPower.items[i].data?.[0];
      if (val != null && val > 0) {
        currentKW = Math.round(val * 10) / 10;
        lastGoodKW = currentKW;
        lastGoodKWTime = new Date().toISOString();
        break;
      }
    }
    // If all zero, use the most recent bin value (could genuinely be 0)
    if (currentKW === '—') {
      const lastBin = currentPower.items[currentPower.items.length - 1];
      if (lastBin?.data?.[0] != null) {
        currentKW = Math.round(lastBin.data[0] * 10) / 10;
      }
    }
  }

  // Today's kWh
  let todayKWh = 0;
  if (todayEnergy?.items?.[0]?.data?.[0] != null) {
    todayKWh = Math.max(0, Math.round(todayEnergy.items[0].data[0]));
  }

  // Yesterday's kWh
  let yesterdayKWh = 0;
  if (yesterdayEnergy?.items?.[0]?.data?.[0] != null) {
    yesterdayKWh = Math.max(0, Math.round(yesterdayEnergy.items[0].data[0]));
  }

  // Last 30 days total
  let last30DaysKWh = 0;
  if (historyEnergy?.items?.length) {
    last30DaysKWh = historyEnergy.items.reduce((sum, item) => {
      const v = item.data?.[0] || 0;
      return sum + Math.max(0, v);
    }, 0);
  }

  // CO₂ offset (30-day) — calculated from actual production
  // EPA eGRID avg: ~0.000386 metric tons CO₂ per kWh for US grid
  let co2Tons30d = Math.round(last30DaysKWh * 0.000386 * 10) / 10;

  // Weather
  let weatherData = null;
  if (weather) {
    weatherData = {
      tempF: Math.round(weather.currentTemperatureFarenheight || 0),
      condition: weather.currentConditionDetailed || weather.currentCondition || '',
      windSpeed: 0, // Basic weather endpoint doesn't include wind
      icon: (weather.currentCondition || '').toLowerCase()
    };
  }

  // Capacity factor
  const capFactor = typeof currentKW === 'number' ? Math.round(currentKW / PV_SIZE_AC * 1000) / 10 : 0;

  // ── Build data.json ──────────────────────────────────────
  // Try to preserve lastGoodKW from previous data.json if current is zero
  let prevData = {};
  try { prevData = JSON.parse(fs.readFileSync('./public/data.json', 'utf8')); } catch {}

  if (!lastGoodKW && prevData.lastGoodKW) {
    lastGoodKW = prevData.lastGoodKW;
    lastGoodKWTime = prevData.lastGoodKWTime;
  }

  const data = {
    status: 'ok',
    currentKW: String(currentKW),
    capacityFactor: String(capFactor),
    todayKWh: fmtEnergy(todayKWh),
    yesterdayKWh: fmtEnergy(yesterdayKWh),
    last30Days: fmtEnergy(last30DaysKWh),
    pvSizeAC: PV_SIZE_AC.toLocaleString(),
    pvSizeDC: PV_SIZE_DC.toLocaleString(),
    co2OffsetTons30d: String(co2Tons30d),
    sunrise: sunTimes.sunrise,
    sunset: sunTimes.sunset,
    sunElevation: sunElevation(LAT, LON),
    weather: weatherData,
    scrapedAt: new Date().toISOString(),
    lastGoodKW: lastGoodKW ? String(lastGoodKW) : prevData.lastGoodKW || null,
    lastGoodKWTime: lastGoodKWTime || prevData.lastGoodKWTime || null,
    source: 'alsoenergy-api'
  };

  fs.writeFileSync('./public/data.json', JSON.stringify(data, null, 2));
  console.log('Wrote data.json:', JSON.stringify({
    currentKW, todayKWh: data.todayKWh, yesterdayKWh: data.yesterdayKWh,
    last30Days: data.last30Days, co2: co2Tons30d
  }));

  // ── Build history.json ───────────────────────────────────
  const history = [];
  if (historyEnergy?.items?.length) {
    for (const item of historyEnergy.items) {
      const kwh = Math.max(0, Math.round(item.data?.[0] || 0));
      if (kwh > 0) {
        history.push({
          date: item.timestamp.split('T')[0],
          kwhProduced: kwh,
          unit: 'kWh',
          source: 'alsoenergy-api'
        });
      }
    }
  }

  if (history.length > 0) {
    fs.writeFileSync('./public/history.json', JSON.stringify(history, null, 2));
    console.log(`Wrote history.json: ${history.length} days`);
  } else {
    console.log('No history data — keeping existing history.json');
  }

  console.log('Done.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
