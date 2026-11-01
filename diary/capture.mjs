import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30_000);
  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').waitFor();
  await page.waitForFunction(() => window.roycraftReady === true);
  await page.screenshot({ path: process.argv[2], type: 'webp', quality: 85 });
} finally {
  await browser.close();
}
