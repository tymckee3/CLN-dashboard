const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

let cachedData = null;
let lastScrape = null;
let isScraping = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/data', (req, res) => {
  res.json(cachedData || { status: 'loading' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScrape, hasCachedData: !!cachedData });
});

async function scrapeDashboard() {
  if (isScraping) return;
  isScraping = true;

  const safetyTimer = setTimeout(() => {
    console.log('Safety timeout, resetting scraper');
    isScraping = false;
  }, 4 * 60 * 1000);

  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // Go directly to the AlsoEnergy login URL
    console.log('Going to login URL...');
    await page.goto('https://apps.alsoenergy.com/Account/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    console.log('URL:', page.url());

    // Step 1: Fill email
    await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
    await page.fill('input[name="username"], input[type="email"]', process.env.POWERTRACK_USER || '');
    console.log('Email filled, clicking Continue...');
    await page.click('button:has-text("Continue")');

    // Step 2: Wait for password page
    await page.waitForURL('**/login/password**', { timeout: 15000 });
    console.log('Password page loaded...');
    await page.waitForTimeout(1000);

    // Step 3: Fill password and click Continue
    const pwd = page.locator('input[type="password"]').first();
    await pwd.waitFor({ state: 'visible', timeout: 10000 });
    await pwd.fill(process.env.POWERTRACK_PASS || '');
    console.log('Password filled, clicking Continue...');
    await page.click('button:has-text("Continue")');

    // Step 4: Wait up to 45 seconds for redirect to alsoenergy.com
    // (test showed it takes ~22 seconds to redirect)
    console.log('Waiting for redirect to PowerTrack...');
    let loggedIn = false;
    for (let i = 0; i < 23; i++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      console.log(`[${(i+1)*2}s] ${url.substring(0, 70)}`);
      if (url.includes('alsoenergy.com/powertrack')) {
        console.log('Logged in successfully!');
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      throw new Error('Login redirect timed out — still on: ' + page.url());
    }

    // Step 5: Navigate to CLN dashboard
    console.log('Navigating to CLN dashboard...');
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for widgets to render
    console.log('Waiting for dashboard widgets...');
    await page.waitForTimeout(8000);
    console.log('Scraping...');

    const data = await page.evaluate(() => {
      const pageText = document.body.innerText;
      const pvProductionMatch = pageText.match(/PV Production[:\s]+([\d,\.]+)\s*kW\s*AC/i);
      const capacityFactorMatch = pageText.match(/PV Capacity Factor[:\s]+([\d]+)%/i);
      const todayMatch = pageText.match(/Today\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const yesterdayMatch = pageText.match(/Yesterday\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const last30Match = pageText.match(/Last 30d?\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const pvSizeMatch = pageText.match(/([\d,\.]+)\s*kW\s*\(AC\)\s*\/\s*([\d,\.]+)\s*kW\s*\(DC\)/i);
      return {
        currentKW: pvProductionMatch ? pvProductionMatch[1] : null,
        capacityFactor: capacityFactorMatch ? capacityFactorMatch[1] : null,
        todayKWh: todayMatch ? { value: todayMatch[1], unit: todayMatch[2] } : null,
        yesterdayKWh: yesterdayMatch ? { value: yesterdayMatch[1], unit: yesterdayMatch[2] } : null,
        last30Days: last30Match ? { value: last30Match[1], unit: last30Match[2] } : null,
        pvSizeAC: pvSizeMatch ? pvSizeMatch[1] : '4,975',
        pvSizeDC: pvSizeMatch ? pvSizeMatch[2] : '6,499',
        rawText: pageText.substring(0, 2000)
      };
    });

    console.log('Scraped:', JSON.stringify(data, null, 2));

    let co2 = null;
    if (data.last30Days) {
      const val = parseFloat(data.last30Days.value.replace(',', ''));
      const kwh = data.last30Days.unit === 'GWh' ? val * 1000000 :
                  data.last30Days.unit === 'MWh' ? val * 1000 : val;
      co2 = (kwh * 0.386 / 1000).toFixed(1);
    }

    cachedData = {
      status: 'ok',
      currentKW: data.currentKW || '—',
      capacityFactor: data.capacityFactor || '—',
      todayKWh: data.todayKWh || { value: '—', unit: 'kWh' },
      yesterdayKWh: data.yesterdayKWh || { value: '—', unit: 'MWh' },
      last30Days: data.last30Days || { value: '—', unit: 'GWh' },
      pvSizeAC: data.pvSizeAC || '4,975',
      pvSizeDC: data.pvSizeDC || '6,499',
      co2OffsetTons30d: co2,
      scrapedAt: new Date().toISOString()
    };

    lastScrape = new Date().toISOString();
    console.log('Scrape successful!');

  } catch (err) {
    console.error('Scrape failed:', err.message);
  } finally {
    clearTimeout(safetyTimer);
    await browser.close();
    isScraping = false;
  }
}

scrapeDashboard();
setInterval(scrapeDashboard, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`CLN Dashboard running on port ${PORT}`);
});
