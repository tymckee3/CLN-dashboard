const express = require('express');
const { chromium } = require('playwright');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Cached data
let cachedData = null;
let lastScrape = null;
let isScraping = false;

// Serve static files (the dashboard HTML)
app.use(express.static(path.join(__dirname, 'public')));

// CORS headers so the dashboard can call the API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Data endpoint — returns latest scraped data as JSON
app.get('/data', (req, res) => {
  if (cachedData) {
    res.json(cachedData);
  } else {
    res.json({ status: 'loading', message: 'Fetching data, please wait...' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastScrape: lastScrape,
    hasCachedData: !!cachedData
  });
});

// --- Playwright Scraper ---
async function scrapeDashboard() {
  if (isScraping) return;
  isScraping = true;

  console.log(`[${new Date().toISOString()}] Starting scrape...`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    // Go to PowerTrack login
    await page.goto('https://apps.alsoenergy.com/Account/Login', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Log in
    await page.fill('input[name="UserName"], input[type="email"], #UserName', process.env.POWERTRACK_USER);
    await page.fill('input[name="Password"], input[type="password"], #Password', process.env.POWERTRACK_PASS);
    await page.click('input[type="submit"], button[type="submit"], .login-btn');

    // Wait for redirect after login
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });

    // Navigate to ASG 8 dashboard
    await page.goto('https://apps.alsoenergy.com/powertrack/S72296/overview/dashboard', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for the dashboard data to load
    await page.waitForTimeout(4000);

    // Scrape the data points we saw in the screenshot
    const data = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : null;
      };

      const getTextByLabel = (labelText) => {
        const els = document.querySelectorAll('*');
        for (const el of els) {
          if (el.children.length === 0 && el.innerText && el.innerText.trim() === labelText) {
            const parent = el.closest('.card, .panel, .widget, .stat, [class*="card"], [class*="panel"]');
            if (parent) {
              const valueEl = parent.querySelector('[class*="value"], [class*="number"], strong, b, h2, h3');
              if (valueEl) return valueEl.innerText.trim();
            }
          }
        }
        return null;
      };

      // Try to find key metrics - we'll grab page text and parse
      const pageText = document.body.innerText;

      // Current production - look for kW AC pattern near "PV Production"
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
        rawText: pageText.substring(0, 3000) // for debugging
      };
    });

    console.log('Scraped data:', JSON.stringify(data, null, 2));

    // Calculate CO2 offset (0.386 kg CO2 per kWh - EPA average)
    let lifetimeCO2 = null;
    if (data.last30Days) {
      const val = parseFloat(data.last30Days.value.replace(',', ''));
      const kwh = data.last30Days.unit === 'GWh' ? val * 1000000 :
                  data.last30Days.unit === 'MWh' ? val * 1000 : val;
      lifetimeCO2 = (kwh * 0.386 / 1000).toFixed(1); // metric tons
    }

    cachedData = {
      status: 'ok',
      siteName: 'ASG 8',
      location: 'Belen, NM',
      currentKW: data.currentKW || '—',
      capacityFactor: data.capacityFactor || '—',
      todayKWh: data.todayKWh || { value: '—', unit: 'kWh' },
      yesterdayKWh: data.yesterdayKWh || { value: '—', unit: 'MWh' },
      last30Days: data.last30Days || { value: '—', unit: 'GWh' },
      pvSizeAC: data.pvSizeAC || '4,975',
      pvSizeDC: data.pvSizeDC || '6,499',
      co2OffsetTons30d: lifetimeCO2,
      scrapedAt: new Date().toISOString(),
      debug: data.rawText
    };

    lastScrape = new Date().toISOString();
    console.log(`[${lastScrape}] Scrape successful`);

  } catch (err) {
    console.error('Scrape failed:', err.message);
    if (cachedData) {
      cachedData.scrapeError = err.message;
      cachedData.scrapedAt = lastScrape; // keep last good timestamp
    }
  } finally {
    await browser.close();
    isScraping = false;
  }
}

// Scrape on startup, then every 5 minutes
scrapeDashboard();
setInterval(scrapeDashboard, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`ASG 8 Dashboard server running on port ${PORT}`);
});
