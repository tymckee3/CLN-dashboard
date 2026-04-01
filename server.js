const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  res.json({ status: 'ok', lastScrape, hasCachedData: !!cachedData });
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
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    // Go to login page
    await page.goto('https://apps.alsoenergy.com/Account/Login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for any input to appear
    await page.waitForSelector('input', { timeout: 30000 });

    // Take screenshot for debugging
    console.log('Login page loaded, filling credentials...');

    // Try all possible username/email field selectors
    const userField = page.locator('input').first();
    await userField.fill(process.env.POWERTRACK_USER || '');

    const passField = page.locator('input[type="password"]').first();
    await pass
cd ~/Desktop/asg8-dashboard
cat > server.js << 'SERVEREOF'
const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  res.json({ status: 'ok', lastScrape, hasCachedData: !!cachedData });
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
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    // Go to login page
    await page.goto('https://apps.alsoenergy.com/Account/Login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for any input to appear
    await page.waitForSelector('input', { timeout: 30000 });

    // Take screenshot for debugging
    console.log('Login page loaded, filling credentials...');

    // Try all possible username/email field selectors
    const userField = page.locator('input').first();
    await userField.fill(process.env.POWERTRACK_USER || '');

    const passField = page.locator('input[type="password"]').first();
    await passField.fill(process.env.POWERTRACK_PASS || '');

    // Click submit
    await page.locator('button[type="submit"], input[type="submit"]').first().click();

    // Wait for navigation
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Logged in, navigating to dashboard...');

    // Navigate to CLN dashboard
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForTimeout(5000);
    console.log('Dashboard loaded, scraping...');

    const data = await page.evaluate(() => {
      const pageText = document.body.innerText;
      const pvProductionMatch = pageText.match(/PV Production[:\s]+([\d,\.]+)\s*kW\s*AC/i);
      const capacityFactorMatch = pageText.match(/PV Capacity Factor[:\s]+([\d]+)%/i);
      const todayMatch = pageText.match(/Today\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const yesterdayMatch = pageText.match(/Yesterday\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);
      const last30Match = pageText.match(/Last 30d?\s+([\d,\.]+)\s*(kWh|MWh|GWh)/i);

      return {
        currentKW: pvProductionMatch ? pvProductionMatch[1] : null,
        capacityFactor: capacityFactorMatch ? capacityFactorMatch[1] : null,
        todayKWh: todayMatch ? { value: todayMatch[1], unit: todayMatch[2] } : null,
        yesterdayKWh: yesterdayMatch ? { value: yesterdayMatch[1], unit: yesterdayMatch[2] } : null,
        last30Days: last30Match ? { value: last30Match[1], unit: last30Match[2] } : null,
        rawText: pageText.substring(0, 2000)
      };
    });

    console.log('Scraped:', JSON.stringify(data));

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
      co2OffsetTons30d: co2,
      scrapedAt: new Date().toISOString(),
      debug: data.rawText
    };

    lastScrape = new Date().toISOString();
    console.log(`Scrape successful at ${lastScrape}`);

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
  console.log(`CLN Dashboard server running on port ${PORT}`);
});
