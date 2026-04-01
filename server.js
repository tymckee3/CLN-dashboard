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

    console.log('Going to dashboard URL...');
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    if (currentUrl.includes('login') || currentUrl.includes('auth0') || currentUrl.includes('Account') || currentUrl.includes('stem.com')) {
      console.log('Redirected to login, authenticating...');

      // Step 1: Fill email
      await page.waitForSelector('input[type="email"], input[name="email"], input[name="username"]', { timeout: 30000 });
      await page.fill('input[type="email"], input[name="email"], input[name="username"]', process.env.POWERTRACK_USER || '');
      console.log('Email filled, clicking Continue...');
      await page.click('button[type="submit"], input[type="submit"]');

      // Step 2: Wait for visible password field
      await page.waitForSelector('input[type="password"]:not([aria-hidden="true"])', { timeout: 30000 });
      console.log('Password field visible...');
      await page.fill('input[type="password"]:not([aria-hidden="true"])', process.env.POWERTRACK_PASS || '');
      console.log('Password filled, submitting...');
      await page.click('button[type="submit"], input[type="submit"]');

      // Wait up to 90 seconds for redirect away from auth pages
      console.log('Waiting for login redirect...');
      let waited = 0;
      let loggedIn = false;
      while (waited < 90000) {
        await page.waitForTimeout(2000);
        waited += 2000;
        const url = page.url();
        console.log(`Checking URL (${waited/1000}s):`, url.substring(0, 60));
        if (!url.includes('auth0') && !url.includes('login') && !url.includes('Account') && !url.includes('stem.com')) {
          console.log('Login complete! URL:', url);
          loggedIn = true;
          break;
        }
      }

      if (!loggedIn) {
        throw new Error('Login redirect timed out after 90 seconds');
      }

      // Navigate to dashboard after login
      console.log('Navigating to dashboard after login...');
      await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    // Verify we're on the right page
    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);
    if (finalUrl.includes('login') || finalUrl.includes('auth0') || finalUrl.includes('stem.com')) {
      throw new Error('Still on login page after auth attempt: ' + finalUrl);
    }

    // Wait for dashboard widgets to load
    await page.waitForTimeout(8000);
    console.log('Dashboard loaded, scraping...');

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
        rawText: pageText.substring(0, 500)
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
      scrapedAt: new Date().toISOString(),
      debug: data.rawText
    };

    lastScrape = new Date().toISOString();
    console.log('Scrape successful!');

  } catch (err) {
    console.error('Scrape failed:', err.message);
  } finally {
    await browser.close();
    isScraping = false;
  }
}

scrapeDashboard();
setInterval(scrapeDashboard, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`CLN Dashboard running on port ${PORT}`);
});
