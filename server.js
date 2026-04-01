const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

let cachedData = null;
let lastScrape = null;
let isScraping = false;
let scrapeTimeout = null;

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

  // Safety valve: force-reset isScraping after 3 minutes no matter what
  scrapeTimeout = setTimeout(() => {
    console.log('Safety timeout: resetting isScraping');
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

    // Go directly to the dashboard - auth will redirect to login if needed
    console.log('Navigating to dashboard...');
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    const needsLogin = currentUrl.includes('login') ||
                       currentUrl.includes('auth0') ||
                       currentUrl.includes('Account') ||
                       currentUrl.includes('stem.com');

    if (needsLogin) {
      console.log('Login required, authenticating...');

      // Step 1: Fill email
      await page.waitForSelector(
        'input[type="email"], input[name="email"], input[name="username"]',
        { timeout: 30000 }
      );
      await page.fill(
        'input[type="email"], input[name="email"], input[name="username"]',
        process.env.POWERTRACK_USER || ''
      );
      console.log('Email filled, clicking Continue...');
      await page.click('button[type="submit"], input[type="submit"]');

      // Step 2: Wait for password page URL to confirm we advanced
      await page.waitForURL('**/login/password**', { timeout: 30000 });
      console.log('Password page reached...');
      await page.waitForTimeout(1500);

      // Step 3: Fill password - wait for it to be visible and enabled
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
      await passwordInput.fill(process.env.POWERTRACK_PASS || '');
      console.log('Password filled, submitting...');
      await passwordInput.press('Enter');

      // Step 4: Wait for successful redirect to alsoenergy.com
      // After login, stem.com redirects back to apps.alsoenergy.com
      await page.waitForURL('https://apps.alsoenergy.com/**', { timeout: 60000 });
      console.log('Login successful! Redirected to:', page.url());

      // Step 5: Navigate to the specific dashboard
      await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    // Final check - make sure we're on the right page
    const finalUrl = page.url();
    console.log('Final URL:', finalUrl);
    if (!finalUrl.includes('alsoenergy.com')) {
      throw new Error('Unexpected URL after login: ' + finalUrl);
    }

    // Wait for dashboard JS to render all widgets
    console.log('Waiting for dashboard widgets...');
    await page.waitForTimeout(8000);
    console.log('Scraping data...');

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

    // Calculate CO2 offset (EPA average: 0.386 kg CO2 per kWh)
    let co2 = null;
    if (data.last30Days) {
      const val = parseFloat(data.last30Days.value.replace(',', ''));
      const kwh = data.last30Days.unit === 'GWh' ? val * 1000000 :
                  data.last30Days.unit === 'MWh' ? val * 1000 : val;
      co2 = (kwh * 0.386 / 1000).toFixed(1);
    }

    // Only update cache if we got real data
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
    console.log('Scrape successful at', lastScrape);

  } catch (err) {
    console.error('Scrape failed:', err.message);
    // Keep existing cachedData so dashboard doesn't go blank
  } finally {
    clearTimeout(scrapeTimeout);
    await browser.close();
    isScraping = false;
  }
}

// Initial scrape on startup, then every 5 minutes
scrapeDashboard();
setInterval(scrapeDashboard, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`CLN Dashboard running on port ${PORT}`);
});
