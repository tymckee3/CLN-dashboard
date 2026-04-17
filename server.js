/**
 * server.js — Multi-Site Community Solar Dashboard Server
 *
 * Serves the dashboard AND runs the AlsoEnergy scraper on a 15-minute interval.
 * All site-specific config comes from environment variables so the same codebase
 * deploys for every site.
 *
 * Environment variables (set in Railway per service):
 *   SITE_NAME             — Display name (e.g. "Locker 505")
 *   SITE_SUBTITLE         — Subtitle line (e.g. "Community Solar · Rio Rancho, New Mexico")
 *   SITE_CITY             — City for weather display
 *   ALSO_ENERGY_SITE_ID   — AlsoEnergy site ID
 *   ALSO_ENERGY_METER_ID  — AlsoEnergy hardware/meter ID (for live kW)
 *   PV_SIZE_AC            — System AC capacity in kW (e.g. 5000)
 *   PV_SIZE_DC            — System DC capacity in kW (e.g. 7003)
 *   SITE_LAT              — Latitude
 *   SITE_LON              — Longitude
 *   SITE_TIMEZONE         — IANA timezone (default: America/Denver)
 *   ALSO_ENERGY_USERNAME  — AlsoEnergy account email
 *   ALSO_ENERGY_PASSWORD  — AlsoEnergy account password
 *   ANTHROPIC_API_KEY     — (optional) for AI-generated solar facts
 *   PORT                  — (auto-set by Railway)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');

// ═══════════════════════════════════════════════════════════════
// SITE CONFIG — all from env vars
// ═══════════════════════════════════════════════════════════════

const SITE_NAME     = process.env.SITE_NAME || 'Community Solar';
const SITE_SUBTITLE = process.env.SITE_SUBTITLE || 'Community Solar · New Mexico';
const SITE_CITY     = process.env.SITE_CITY || 'New Mexico';
const SITE_ID       = parseInt(process.env.ALSO_ENERGY_SITE_ID || '0');
const METER_ID      = parseInt(process.env.ALSO_ENERGY_METER_ID || '0');
const PV_SIZE_AC    = parseInt(process.env.PV_SIZE_AC || '5000');
const PV_SIZE_DC    = parseInt(process.env.PV_SIZE_DC || '5000');
const LAT           = parseFloat(process.env.SITE_LAT || '34.5');
const LON           = parseFloat(process.env.SITE_LON || '-106.5');
const TIMEZONE      = process.env.SITE_TIMEZONE || 'America/Denver';

const USERNAME = process.env.ALSO_ENERGY_USERNAME;
const PASSWORD = process.env.ALSO_ENERGY_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SCRAPE_INTERVAL = 15 * 60 * 1000;  // 15 minutes
const FACTS_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Timestamp of the most recent successful scrape (for /health).
let lastScrapeAt = null;

// ═══════════════════════════════════════════════════════════════
// SERVE DASHBOARD — inject site config into HTML
// ═══════════════════════════════════════════════════════════════

// Read index.html template once at startup
let htmlTemplate = '';
try {
  htmlTemplate = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
} catch (e) {
  console.error('Could not read index.html:', e.message);
}

// HTML-escape user-supplied strings before interpolating into tags/attrs.
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render the dashboard HTML with site config + per-site <title> and Open
// Graph / Twitter Card meta tags injected. Unfurlers (iMessage, Slack,
// Twitter, etc.) fetch this HTML server-side and don't run JS, so everything
// they need has to be in the initial response.
function renderDashboard(req) {
  if (!htmlTemplate) {
    return '<!doctype html><meta charset="utf-8"><title>Dashboard error</title>'
      + '<body style="font:16px sans-serif;padding:40px;background:#030609;color:#EDF1FF">'
      + 'Dashboard template unavailable — check server logs.</body>';
  }

  // Build absolute base URL for og:url and og:image. Railway terminates TLS
  // at the proxy so req.protocol reports 'http'; use x-forwarded-proto when
  // present so og:url reflects the real https:// URL the client sees.
  const host  = (req && req.headers && req.headers.host) || 'localhost';
  const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
  const baseUrl = `${proto}://${host}`;

  const title = `${SITE_NAME} · Solar Dashboard`;
  const description =
    `Live solar production for ${SITE_NAME} — current kW output, today's` +
    ` energy, 7-day history, and weather. ${SITE_SUBTITLE}`;
  const ogImage = `${baseUrl}/og.png`;

  const t = escHtml(title);
  const d = escHtml(description);
  const u = escHtml(baseUrl + '/');
  const i = escHtml(ogImage);

  const metaBlock = `<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Affordable Solar Group">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta property="og:image" content="${i}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${i}">`;

  const configScript = `<script>
window.__SITE_CONFIG__ = {
  name: ${JSON.stringify(SITE_NAME)},
  subtitle: ${JSON.stringify(SITE_SUBTITLE)},
  city: ${JSON.stringify(SITE_CITY)},
  pvSizeAC: ${PV_SIZE_AC},
  pvSizeDC: ${PV_SIZE_DC},
  lat: ${LAT},
  lon: ${LON},
  timezone: ${JSON.stringify(TIMEZONE)}
};
</script>`;

  // Replace the placeholder <title> in the template with the dynamic meta
  // block (contains its own <title>), then inject the config script.
  return htmlTemplate
    .replace(/<title>[\s\S]*?<\/title>/, metaBlock)
    .replace('</head>', configScript + '\n</head>');
}

// Dashboard entry points — must run BEFORE express.static so index.html is
// never served raw (which would skip config injection).
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(renderDashboard(req));
});

// Lightweight health check for Railway / uptime monitors.
app.get('/health', (_req, res) => {
  res.json({ ok: true, site: SITE_NAME, scrapedAt: lastScrapeAt });
});

// Serve static assets (css, js, images, json) for everything else.
app.use(express.static(PUBLIC, { index: false }));

// Anything that falls through gets the dashboard as a SPA-style fallback.
app.get('*', (req, res) => {
  res.type('html').send(renderDashboard(req));
});

// ═══════════════════════════════════════════════════════════════
// HTTP HELPER
// ═══════════════════════════════════════════════════════════════

function req(method, url, headers = {}, body = null) {
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
    const r = https.request(opts, res => {
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
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// ALSOENERGY AUTH + API
// ═══════════════════════════════════════════════════════════════

async function getToken() {
  const body = `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
  const res = await req('POST', 'https://api.alsoenergy.com/Auth/token', {
    'Content-Type': 'application/x-www-form-urlencoded'
  }, body);
  if (!res.access_token) throw new Error('Auth failed: ' + JSON.stringify(res));
  return res.access_token;
}

function api(token, method, path, body) {
  const hdrs = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  return req(method, `https://api.alsoenergy.com${path}`, hdrs, body);
}

function binData(token, from, to, binSize, fields) {
  const qs = `fromLocalTime=${from}&toLocalTime=${to}&binSizes=${binSize}`;
  return api(token, 'POST', `/Data/BinData?${qs}`, fields);
}

// ═══════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════

function mtnNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}
function fmtLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(d) { return fmtLocal(d).split('T')[0]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

// ═══════════════════════════════════════════════════════════════
// SUNRISE / SUNSET
// ═══════════════════════════════════════════════════════════════

// Return the current timezone abbreviation (e.g. "MDT", "MST") for TIMEZONE.
// Avoids hardcoding "MDT" which is wrong in winter.
function tzAbbr() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE, timeZoneName: 'short'
    }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

async function getSunTimes() {
  try {
    const d = await req('GET',
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=sunrise,sunset&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=1`);
    const rise = d.daily?.sunrise?.[0];
    const set = d.daily?.sunset?.[0];
    const abbr = tzAbbr();
    const fmtTime = iso => {
      const dt = new Date(iso);
      let h = dt.getHours(), m = dt.getMinutes();
      const ap = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12; if (h === 0) h = 12;
      return `${h}:${String(m).padStart(2, '0')} ${ap}${abbr ? ' ' + abbr : ''}`;
    };
    return { sunrise: fmtTime(rise), sunset: fmtTime(set) };
  } catch (e) {
    console.error('Sun times failed:', e.message);
    return { sunrise: null, sunset: null };
  }
}

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

function fmtEnergy(kwh) {
  if (kwh >= 1e6) return { value: (kwh / 1e6).toFixed(2), unit: 'GWh' };
  if (kwh >= 1e3) return { value: (kwh / 1e3).toFixed(2), unit: 'MWh' };
  return { value: Math.round(kwh).toString(), unit: 'kWh' };
}

// ═══════════════════════════════════════════════════════════════
// MAIN SCRAPE FUNCTION
// ═══════════════════════════════════════════════════════════════

async function scrape() {
  if (!USERNAME || !PASSWORD) {
    console.warn('Missing ALSO_ENERGY credentials — skipping scrape');
    return;
  }
  if (!SITE_ID) {
    console.warn('Missing ALSO_ENERGY_SITE_ID — skipping scrape');
    return;
  }
  console.log(`[${new Date().toISOString()}] Scraping ${SITE_NAME} (site ${SITE_ID})...`);
  try {
    const token = await getToken();
    const now = mtnNow();
    const todayStart = fmtDate(now) + 'T00:00:00';
    const nowLocal = fmtLocal(now);
    const yesterday = addDays(now, -1);
    const yesterdayStart = fmtDate(yesterday) + 'T00:00:00';
    const yesterdayEnd = fmtDate(now) + 'T00:00:00';
    const thirtyDaysAgo = addDays(now, -30);

    // Live kW: query the last hour of 15-min bins and use the most recent
    // non-null positive reading. One hour gives 3–4 bins to fall back through.
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const currentPowerQuery = METER_ID
      ? binData(token, fmtLocal(oneHourAgo), nowLocal, 'Bin15Min',
          [{ hardwareId: METER_ID, fieldName: 'KW', function: 'Avg' }])
          .catch(e => { console.error('currentPower:', e.message); return null; })
      : Promise.resolve(null);

    // Energy: AlsoEnergy's ProdKWH / KWH fields are empty on these meters, so
    // we derive kWh from KW (Avg). The Avg function is TIME-WEIGHTED, so:
    //   • 15-min bin avg × 0.25h = kWh in that bin
    //   • daily bin avg × 24h    = kWh that day (nighttime 0-kW hours are
    //     already baked into the 24-hour denominator, so multiplying by 24
    //     recovers the true integral — this is not an overestimate)
    const kwField = METER_ID
      ? [{ hardwareId: METER_ID, fieldName: 'KW', function: 'Avg' }]
      : [{ siteId: SITE_ID, fieldName: 'KW', function: 'Avg' }];

    const [currentPower, todayKWBins, yesterdayKWBins, historyKWBins, weather, sunTimes] = await Promise.all([
      currentPowerQuery,
      binData(token, todayStart, nowLocal, 'Bin15Min', kwField)
        .catch(e => { console.error('todayEnergy:', e.message); return null; }),
      binData(token, yesterdayStart, yesterdayEnd, 'Bin15Min', kwField)
        .catch(e => { console.error('yesterdayEnergy:', e.message); return null; }),
      binData(token, fmtDate(thirtyDaysAgo) + 'T00:00:00', yesterdayEnd, 'BinDay', kwField)
        .catch(e => { console.error('historyEnergy:', e.message); return null; }),
      api(token, 'GET', `/Sites/${SITE_ID}/Weather`)
        .catch(e => { console.error('weather:', e.message); return null; }),
      getSunTimes()
    ]);

    // Helper: sum 15-min KW bins into kWh (each bin = 0.25 hours)
    function sumKWhFrom15MinBins(bins) {
      if (!bins?.items?.length) return 0;
      return bins.items.reduce((sum, item) => {
        const kw = item.data?.[0];
        return sum + (kw != null && kw > 0 ? kw * 0.25 : 0);
      }, 0);
    }
    // Helper: sum daily KW avg bins into kWh (each bin ≈ 24 hours)
    function sumKWhFromDayBins(bins) {
      if (!bins?.items?.length) return 0;
      return bins.items.reduce((sum, item) => {
        const kw = item.data?.[0];
        return sum + (kw != null && kw > 0 ? kw * 24 : 0);
      }, 0);
    }

    // ── Parse current kW ───────────────────────────────────
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
      if (currentKW === '—') {
        const lastBin = currentPower.items[currentPower.items.length - 1];
        if (lastBin?.data?.[0] != null) {
          currentKW = Math.round(lastBin.data[0] * 10) / 10;
        }
      }
    }

    // ── Parse energy totals (from KW bins → kWh) ───────────
    let todayKWh = Math.round(sumKWhFrom15MinBins(todayKWBins));
    let yesterdayKWh = Math.round(sumKWhFrom15MinBins(yesterdayKWBins));
    let last30DaysKWh = Math.round(sumKWhFromDayBins(historyKWBins));

    // EPA eGRID emissions factor: 0.851 lbs CO₂/kWh → 0.0004255 short-tons/kWh.
    // Kept in sync with LBS_CO2_PER_KWH in public/index.html.
    const CO2_TONS_PER_KWH = 0.851 / 2000;
    let co2Tons30d = Math.round(last30DaysKWh * CO2_TONS_PER_KWH * 10) / 10;

    let weatherData = null;
    if (weather) {
      weatherData = {
        tempF: Math.round(weather.currentTemperatureFarenheight || 0),
        condition: weather.currentConditionDetailed || weather.currentCondition || '',
        windSpeed: 0,
        icon: (weather.currentCondition || '').toLowerCase()
      };
    }

    const capFactor = typeof currentKW === 'number' ? Math.round(currentKW / PV_SIZE_AC * 1000) / 10 : 0;

    // ── Preserve lastGoodKW from previous data ─────────────
    let prevData = {};
    try { prevData = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data.json'), 'utf8')); } catch {}

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

    fs.writeFileSync(path.join(PUBLIC, 'data.json'), JSON.stringify(data, null, 2));
    console.log('  data.json:', JSON.stringify({
      currentKW, todayKWh: data.todayKWh, last30Days: data.last30Days, co2: co2Tons30d
    }));

    // ── Build history.json ─────────────────────────────────
    const apiDays = {};
    if (historyKWBins?.items?.length) {
      for (const item of historyKWBins.items) {
        const date = item.timestamp.split('T')[0];
        const avgKW = item.data?.[0] || 0;
        apiDays[date] = Math.max(0, Math.round(avgKW * 24));  // avg kW × 24h = kWh
      }
    }
    const history = [];
    for (let i = 30; i >= 1; i--) {
      const d = addDays(now, -i);
      const date = fmtDate(d);
      history.push({
        date,
        kwhProduced: apiDays[date] || 0,
        unit: 'kWh',
        source: 'alsoenergy-api'
      });
    }

    fs.writeFileSync(path.join(PUBLIC, 'history.json'), JSON.stringify(history, null, 2));
    console.log(`  history.json: ${history.length} days (${Object.keys(apiDays).length} with production)`);

    lastScrapeAt = new Date().toISOString();
    console.log('  Scrape complete.');
  } catch (e) {
    console.error('Scrape failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// FACTS GENERATOR — Claude API (optional)
// ═══════════════════════════════════════════════════════════════

async function generateFacts() {
  if (!ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY — skipping fact generation');
    return;
  }
  console.log(`[${new Date().toISOString()}] Generating fresh solar facts...`);
  try {
    const prompt = `Generate exactly 30 interesting, educational facts about solar energy, community solar programs, and renewable energy. These will be displayed one at a time on a public kiosk dashboard for the ${SITE_NAME} community solar project in ${SITE_CITY} (operated by Affordable Solar Group).

Requirements:
- Each fact must be a single sentence, suitable for display in a bottom ticker bar
- Use <strong>bold tags</strong> around the most impactful number or phrase in each fact (exactly one per fact)
- Mix topics: solar science, community solar benefits, New Mexico solar resources, environmental impact, solar economics, solar history, fun comparisons
- Keep language accessible for a general audience (including school children)
- Be accurate — no made-up statistics
- Don't start every fact the same way — vary sentence structure
- No numbered lists or bullet points — just the fact text

Return ONLY a valid JSON array of strings, no markdown, no explanation.`;

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const res = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`API ${res.statusCode}: ${data.slice(0, 200)}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    let jsonStr = (res.content?.[0]?.text || '').trim();
    if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    const facts = JSON.parse(jsonStr);
    const valid = facts.filter(f => typeof f === 'string' && f.length > 10);
    if (valid.length < 5) throw new Error('Too few valid facts: ' + valid.length);

    fs.writeFileSync(path.join(PUBLIC, 'facts.json'), JSON.stringify(valid, null, 2));
    console.log(`  Wrote ${valid.length} facts to facts.json`);
  } catch (e) {
    console.error('Fact generation failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// START SERVER + SCHEDULE
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`${SITE_NAME} Dashboard serving on port ${PORT}`);
  console.log(`Site ID: ${SITE_ID} | Meter ID: ${METER_ID || 'NOT SET'} | AC: ${PV_SIZE_AC} kW | DC: ${PV_SIZE_DC} kW`);
  console.log(`Location: ${LAT}, ${LON} (${TIMEZONE})`);
  console.log(`Scraper interval: ${SCRAPE_INTERVAL / 60000} min`);
  console.log(`Credentials: ${USERNAME ? 'set' : 'MISSING'}`);
  console.log(`Anthropic key: ${ANTHROPIC_API_KEY ? 'set' : 'not set (facts will use fallback)'}`);

  scrape();
  setInterval(scrape, SCRAPE_INTERVAL);

  generateFacts();
  setInterval(generateFacts, FACTS_INTERVAL);
});
