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
    console.log('Safety timeout hit, resetting scraper');
    isScraping = false;
  }, 3 * 60 * 1000);

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

    // Start from the AlsoEnergy login page exactly like a real user
    console.log('Going to AlsoEnergy login page...');
    await page.goto('https://home.alsoenergy.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Click the "login to PowerTrack" button
    console.log('Clicking Login to PowerTrack...');
    await page.waitForSelector('a:has-text("PowerTrack"), button:has-text("PowerTrack")', { timeout: 15000 });
    await page.click('a:has-text("PowerTrack"), button:has-text("PowerTrack")');

    // Now on stem.com email page
    console.log('Waiting for email field...');
    await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 30000 });
    await page.fill('input[name="username"], input[type="email"]', process.env.POWERTRACK_USER || '');
    console.log('Email filled, clicking Continue...');
    await page.click('button:has-text("Continue"), input[type="submit"]');

    // Now on password page - click the Continue button explicitly
    console.log('Waiting for password page...');
    await page.waitForURL('**/login/password**', { timeout: 30000 });
    await page.waitForTimeout(1000);

    console.log('Filling password...');
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.fill(process.env.POWERTRACK_PASS || '');

    // Click the Continue button explicitly (not Enter)
    console.log('Clicking Continue...');
    await page.click('button:has-text("Continue"), button[type="submit"]');

    // Wait to land on alsoenergy.com
    console.log('Waiting to land on PowerTrack...');
    await page.waitForURL('**/powertrack/**', { timeout: 60000 });
    console.log('Logged in! URL:', page.url());

    // Navigate to CLN dashboard
    console.log('Navigating to CLN dashboard...');
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for dashboard widgets to render
    console.log('Waiting for dashboard data to load...');
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

    console.log('Scraped data:', JSON.stringify(data, null, 2));

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
