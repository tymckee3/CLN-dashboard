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
    const page = await context.newPage();

    await page.goto('https://apps.alsoenergy.com/Account/login', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
    await page.fill('input[name="username"], input[type="email"]', process.env.POWERTRACK_USER || '');
    await page.click('button:has-text("Continue")');
    await page.waitForURL('**/login/password**', { timeout: 15000 });
    await page.waitForTimeout(1000);
    const pwd = page.locator('input[type="password"]').first();
    await pwd.waitFor({ state: 'visible', timeout: 10000 });
    await pwd.fill(process.env.POWERTRACK_PASS || '');
    await page.click('button:has-text("Continue")');

    console.log('Waiting for redirect...');
    let loggedIn = false;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      console.log(`[${(i+1)*2}s] ${url.substring(0, 60)}`);
      if (url.includes('alsoenergy.com/powertrack')) { loggedIn = true; break; }
    }
    if (!loggedIn) throw new Error('Login timed out at: ' + page.url());

    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await page.waitForTimeout(8000);

    const data = await page.evaluate(() => {
      const t = document.body.innerText;
      const m = (r) => { const x = t.match(r); return x ? x[1] : null; };
      const mu = (r) => { const x = t.match(r); return x ? { value: x[1], unit: x[2] } : null; };
      return {
        currentKW: m(/PV Production[:\s]+([\d,\.]+)\s*kW\s*AC/i),
        capacityFactor: m(/PV Capacity Factor[:\s]+([\d]+)%/i),
        todayKWh: mu(/Today\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i),
        yesterdayKWh: mu(/Yesterday\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i),
        last30Days: mu(/Last 30d?\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i),
        pvSizeAC: m(/([\d,\.]+)\s*kW\s*\(AC\)/) || '4,975',
        pvSizeDC: m(/([\d,\.]+)\s*kW\s*\(DC\)/) || '6,499',
      };
    });
    console.log('Scraped:', JSON.stringify(data));

    function toKwh(val, unit) {
      if (!val || val === '—') return 0;
      const v = parseFloat(val.replace(',', ''));
      if (unit === 'GWh') return v * 1000000;
      if (unit === 'MWh') return v * 1000;
      return v;
    }

    let co2 = null;
    if (data.last30Days) {
      const kwh = toKwh(data.last30Days.value, data.last30Days.unit);
      co2 = (kwh * 0.386 / 1000).toFixed(1);
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Update 7-day history
    const histPath = path.join(__dirname, 'public', 'history.json');
    let history = [];
    try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch(e) { history = []; }

    const todayKwh = toKwh(data.todayKWh?.value, data.todayKWh?.unit);
    const existing = history.findIndex(h => h.date === today);
    const entry = { date: today, kwhProduced: parseFloat(todayKwh.toFixed(1)), unit: 'kWh' };
    if (existing >= 0) history[existing] = entry;
    else history.push(entry);
    history = history.slice(-14); // keep 14 days
    fs.writeFileSync(histPath, JSON.stringify(history, null, 2));

    const output = {
      status: 'ok',
      currentKW: data.currentKW || '—',
      capacityFactor: data.capacityFactor || '—',
      todayKWh: data.todayKWh || { value: '—', unit: 'kWh' },
      yesterdayKWh: data.yesterdayKWh || { value: '—', unit: 'MWh' },
      last30Days: data.last30Days || { value: '—', unit: 'GWh' },
      pvSizeAC: data.pvSizeAC,
      pvSizeDC: data.pvSizeDC,
      co2OffsetTons30d: co2,
      scrapedAt: now.toISOString()
    };
    fs.writeFileSync(path.join(__dirname, 'public', 'data.json'), JSON.stringify(output, null, 2));
    console.log('Done. History entries:', history.length);

  } finally {
    await browser.close();
  }
})();
