const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('Starting scrape...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    let page = await context.newPage();

    // ── LOGIN (with retry) ───────────────────────────────────
    const MAX_LOGIN_ATTEMPTS = 3;
    let loggedIn = false;

    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
      try {
        console.log(`Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}...`);
        await page.goto('https://apps.alsoenergy.com/Account/login', {
          waitUntil: 'domcontentloaded', timeout: 60000
        });
        await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 30000 });
        await page.fill('input[name="username"], input[type="email"]', process.env.POWERTRACK_USER || '');
        await page.click('button:has-text("Continue")');

        // Wait for password page — Auth0 may redirect or show inline
        try {
          await page.waitForURL('**/login/password**', { timeout: 20000 });
        } catch (e) {
          // Password field might appear on the same page (Auth0 flow variation)
          console.log('URL redirect to /login/password did not happen, checking for inline password field...');
        }

        await page.waitForTimeout(1500);
        const pwd = page.locator('input[type="password"]').first();
        await pwd.waitFor({ state: 'visible', timeout: 20000 });
        await pwd.fill(process.env.POWERTRACK_PASS || '');
        await page.click('button:has-text("Continue")');

        console.log('Waiting for login redirect...');
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(2000);
          const url = page.url();
          console.log(`[${(i+1)*2}s] ${url.substring(0, 60)}`);
          if (url.includes('alsoenergy.com/powertrack')) { loggedIn = true; break; }
        }
        if (loggedIn) break;
        throw new Error('Login redirect timed out');

      } catch (loginErr) {
        console.error(`Login attempt ${attempt} failed:`, loginErr.message);
        if (attempt < MAX_LOGIN_ATTEMPTS) {
          console.log(`Retrying in ${attempt * 5} seconds...`);
          await page.waitForTimeout(attempt * 5000);
          // Fresh page for retry
          await page.close();
          page = await context.newPage();
        } else {
          throw new Error(`Login failed after ${MAX_LOGIN_ATTEMPTS} attempts: ${loginErr.message}`);
        }
      }
    }
    console.log('Logged in!');

    // ── HELPER: authenticated fetch ────────────────────────────
    async function apiFetch(endpoint) {
      const result = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        return res.json();
      }, `https://apps.alsoenergy.com${endpoint}`);
      return result;
    }

    // ── 1. PRODUCTION (live + today/yesterday/30d + sunrise/sunset) ──
    console.log('Fetching production data...');
    const prod = await apiFetch('/api/production/S72296?lastChanged=1900-01-01T00:00:00.000Z');
    console.log('Production:', JSON.stringify(prod).substring(0, 200));

    // ── 2. WEATHER from AlsoEnergy ─────────────────────────────
    console.log('Fetching weather...');
    const weather = await apiFetch('/api/view/siteweather/S72296?lastChanged=1900-01-01T00:00:00.000Z');
    console.log('Weather:', JSON.stringify(weather).substring(0, 200));

    // ── 3. DAILY HISTORY via chart API (30 days, daily bins) ──
    console.log('Fetching 30-day history...');
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const historyData = await page.evaluate(async ({ startDate, endDate }) => {
      const body = {
        binSize: 1440,
        builtInParameters: null,
        chartType: 255,
        context: 'site',
        end: endDate,
        futureDays: 0,
        hardwareSet: null,
        hardwareByType: null,
        query: null,
        sectionCode: -1,
        source: ['S72296'],
        start: startDate
      };
      const res = await fetch('https://apps.alsoenergy.com/api/view/chart?lastChanged=1900-01-01T00:00:00.000Z', {
        method: 'GET',
        credentials: 'include'
      });
      // The chart API uses GET with the key as a query param — reconstruct from production page
      // Actually navigate to get the chart data via page context
      const res2 = await fetch(`https://apps.alsoenergy.com/api/view/chart?lastChanged=1900-01-01T00:00:00.000Z`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      return null;
    }, { startDate, endDate });

    // Chart API requires a specific key format — use the dashboard page to trigger it
    // Instead, navigate to the site dashboard and intercept the chart response
    const chartResponses = [];
    const chartHandler = async (response) => {
      const url = response.url();
      if (url.includes('/api/view/chart')) {
        try {
          const body = await response.json();
          const key = typeof body.key === 'string' ? JSON.parse(body.key) : {};
          // We want the daily bin chart (binSize 1440) for history
          if (key.binSize === 1440 || key.chartType === 255) {
            chartResponses.push({ key, body });
            console.log(`Chart captured: binSize=${key.binSize} start=${key.start} end=${key.end} series=${body.series?.length}`);
          }
        } catch(e) {}
      }
    };
    page.on('response', chartHandler);

    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await page.waitForTimeout(10000);
    page.off('response', chartHandler);

    console.log('Chart responses captured:', chartResponses.length);

    // ── BUILD OUTPUT ───────────────────────────────────────────
    function toKwh(val) {
      if (!val || val === '—') return 0;
      return parseFloat(String(val).replace(',', ''));
    }

    // Production data
    const kw = prod?.power ? parseFloat(prod.power).toFixed(1) : '—';
    const capacityFactor = prod?.systemSize ? Math.round(parseFloat(prod.power) / prod.systemSize * 100) : '—';
    const todayKwh = prod?.today || 0;
    const yesterdayKwh = prod?.yesterday || 0;
    const thirtyDayKwh = prod?.energyThirtyDays || 0;

    // Format energy with smart units
    function smartUnit(kwh) {
      if (kwh >= 1000000) return { value: (kwh / 1000000).toFixed(2), unit: 'GWh' };
      if (kwh >= 1000) return { value: (kwh / 1000).toFixed(2), unit: 'MWh' };
      return { value: Math.round(kwh).toString(), unit: 'kWh' };
    }

    const co2 = thirtyDayKwh > 0 ? (thirtyDayKwh * 0.386 / 1000).toFixed(1) : null;

    // Build 30-day daily history from chart data
    const histPath = path.join(__dirname, 'public', 'history.json');
    let history = [];
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch(e) { history = []; }

    // Try to extract daily totals from chart responses
    let gotRealHistory = false;
    for (const { key, body } of chartResponses) {
      if (key.binSize === 1440 && body.series) {
        // Find the production series
        const prodSeries = body.series.find(s =>
          s.name && (s.name.toLowerCase().includes('measured') || s.name.toLowerCase().includes('production') || s.name.toLowerCase().includes('energy'))
        );
        if (prodSeries && prodSeries.data && prodSeries.data.length > 0) {
          console.log('Found daily production series:', prodSeries.name, 'points:', prodSeries.data.length);
          // Each data point: [timestamp, value]
          for (const pt of prodSeries.data) {
            if (!pt || pt[1] === null || pt[1] === undefined) continue;
            const date = new Date(pt[0]).toISOString().split('T')[0];
            const kwh = parseFloat(pt[1]);
            if (isNaN(kwh) || kwh <= 0) continue;
            const existing = history.findIndex(h => h.date === date);
            const entry = { date, kwhProduced: parseFloat(kwh.toFixed(1)), unit: 'kWh', source: 'alsoenergy' };
            if (existing >= 0) history[existing] = entry;
            else history.push(entry);
          }
          gotRealHistory = true;
          break;
        }
      }
    }

    if (!gotRealHistory) {
      console.log('No daily chart data in responses — using today/yesterday from production API');
      // At minimum update today from the production API
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const updateOrAdd = (date, kwh) => {
        if (kwh <= 0) return;
        const existing = history.findIndex(h => h.date === date);
        const entry = { date, kwhProduced: parseFloat(kwh.toFixed ? kwh.toFixed(1) : kwh), unit: 'kWh', source: 'alsoenergy' };
        if (existing >= 0) history[existing] = entry;
        else history.push(entry);
      };
      updateOrAdd(todayStr, todayKwh);
      updateOrAdd(yesterdayStr, yesterdayKwh);
    }

    // Sort and keep last 30 days
    history.sort((a, b) => a.date.localeCompare(b.date));
    history = history.slice(-30);
    fs.writeFileSync(histPath, JSON.stringify(history, null, 2));
    console.log(`History: ${history.length} entries, latest: ${history[history.length-1]?.date} = ${history[history.length-1]?.kwhProduced} kWh`);

    // Build weather object from AlsoEnergy weather
    const wxOut = weather ? {
      tempF: weather.temperature,
      condition: weather.condition,
      windSpeed: weather.windSpeed,
      windDirection: weather.windDirection,
      icon: weather.icon,
      forecast: (weather.forecast || []).slice(0, 5).map(f => ({
        date: f.date?.split('T')[0],
        high: f.high,
        low: f.low,
        condition: f.condition,
        icon: f.icon
      }))
    } : null;

    // Build main output
    const output = {
      status: 'ok',
      currentKW: kw,
      capacityFactor: String(capacityFactor),
      todayKWh: smartUnit(todayKwh),
      yesterdayKWh: smartUnit(yesterdayKwh),
      last30Days: smartUnit(thirtyDayKwh),
      thisYear: smartUnit(prod?.thisYear || 0),
      lifetime: smartUnit(prod?.lifetime || 0),
      pvSizeAC: '4,975',
      pvSizeDC: '6,499',
      co2OffsetTons30d: co2,
      sunrise: prod?.sunrise || null,
      sunset: prod?.sunset || null,
      sunElevation: prod?.sunElevation ? parseFloat(prod.sunElevation.toFixed(1)) : null,
      weather: wxOut,
      scrapedAt: new Date().toISOString()
    };

    fs.writeFileSync(path.join(__dirname, 'public', 'data.json'), JSON.stringify(output, null, 2));
    console.log('data.json written');
    console.log('Output summary:', {
      kw: output.currentKW,
      today: output.todayKWh,
      yesterday: output.yesterdayKWh,
      sunrise: output.sunrise,
      sunset: output.sunset,
      weather: output.weather?.condition
    });

  } finally {
    await browser.close();
  }
})();
