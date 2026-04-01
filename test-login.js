const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // Go directly to the Account login URL
  console.log('1. Going to login URL...');
  await page.goto('https://apps.alsoenergy.com/Account/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  console.log('2. URL:', page.url());

  // Wait for email field
  await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });
  console.log('3. Email field found, filling...');
  await page.fill('input[name="username"], input[type="email"]', 'tyler.mckee@affordable-solar.com');

  // Click Continue
  await page.click('button:has-text("Continue")');
  console.log('4. Clicked Continue, waiting for password page...');

  await page.waitForURL('**/login/password**', { timeout: 15000 });
  console.log('5. On password page:', page.url());
  await page.waitForTimeout(1000);

  // Fill password
  const pwd = page.locator('input[type="password"]').first();
  await pwd.waitFor({ state: 'visible', timeout: 10000 });
  await pwd.fill('TEST_PASSWORD_PLACEHOLDER');
  console.log('6. Password filled, clicking Continue...');

  // Click the Continue button on password page
  await page.click('button:has-text("Continue")');
  console.log('7. Clicked Continue, watching URL...');

  // Watch URL for 30 seconds
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log(`   [${(i+1)*2}s] URL: ${url.substring(0, 80)}`);
    if (url.includes('alsoenergy.com/powertrack')) {
      console.log('SUCCESS! Logged in.');
      break;
    }
  }

  await browser.close();
})();
