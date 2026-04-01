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
  if (cachedData) {
    res.json(cachedData);
  } else {
    res.json({ status: 'loading', message: 'Fetching data, please wait...' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastScrape, hasCachedData: !!cachedData, data: cachedData });
});

async function scrapeDashboard() {
  if (isScraping) return;
  isScraping = true;
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

    console.log('Navigating to login page...');
    await page.goto('https://apps.alsoenergy.com/Account/Login', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Step 1: Fill email
    console.log('Waiting for email field...');
    await page.waitForSelector('input[type="email"], input[name="email"], input[name="username"]', { timeout: 30000 });
    await page.fill('input[type="email"], input[name="email"], input[name="username"]', process.env.POWERTRACK_USER || '');
    console.log('Email filled, clicking Continue...');

    // Click Continue to reveal password field
    await page.click('button[type="submit"], input[type="submit"], button[name="action"]');

    // Step 2: Wait for visible password field to appear
    console.log('Waiting for password field...');
    await page.waitForSelector('input[type="password"]:visible', { timeout: 30000 });
    await page.fill('input[type="password"]:visible', process.env.POWERTRACK_PASS || '');
    console.log('Password filled, submitting...');

    // Submit login
    await page.click('button[type="submit"], input[type="submit"], button[name="action"]');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 });
    console.log('Logged in! URL:', page.url());

    // Navigate to CLN/ASG8 dashboard
    console.log('Navigating to CLN dashboard...');
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    await page.waitForTimeout(6000);
    console.log('Dashboard loaded, scraping...');

    const data = await page.evaluate(() => {
      const pageText = document.body.innerText;
      const pvProductionMatch = pageText.match(/PV Production[:\s]+([\d,\.]+)\s*kW\s*AC/i);
      const capacityFactorMatch = pageText.match(/PV Capacity Factor[:\s]+([\d]+)%/i);
      const todayMatch = pageText.match(/Today\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const yesterdayMatch = pageText.match(/Yesterday\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const last30Match = pageText.match(/Last 30d?\s+([\d,\.]+)\s*(kWh|[\s]?MWh|GWh)/i);
      const pvSizeMatch = pageText.match(/([\d,\.]+)\s*kW\s*\(AC\)\s*\/\s*([\d,\.]+)\s*kW\s*\(DC\)/i);
      return {
        currentKW: pvProductionMatch ? pvProductionMatch[1] : null,
        capacityFactor: capacityFactorMatch ? capacityFactorMatch[1] : null,
        todayKWh: todayMatch ? { value: todayMatch[1], unit: todayMatch[2] } : null,
        yesterdayKWh: yesterdayMatch ? { value: yesterdayMatch[1], unit: yesterdayMatch[2] } : null,
        last30Days: last30Match ? { value: last30Match[1], unit: last30Match[2] } : null,
        pvSizeAC: pvSizeMatch ? pvSizeMatch[1] : '4,975',
        pvSizeDC: pvSizeMatch ? pvSizeMatch[2] : '6,499',
        rawText: pageText.substring(0, 3000)
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
      scrapedAt: new Date().toISOString(),
      debug: data.rawText
    };

    lastScrape = new Date().toISOString();
    console.log('Scrape successful at', lastScrape);

  } catch (err) {
    console.error('Scrape failed:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
    isScraping = false;
  }
}

scrapeDashboard();
setInterval(scrapeDashboard, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`CLN Dashboard server running on port ${PORT}`);
});