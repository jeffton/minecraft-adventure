import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30_000);
  await page.addInitScript(() => { window.roycraftCaptureRequested = true; });
  await page.goto('http://127.0.0.1:8931/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.roycraftCapture === 'string');
  const frame = await page.evaluate(() => window.roycraftCapture);
  writeFileSync(process.argv[2], Buffer.from(frame.split(',')[1], 'base64'), { mode: 0o644 });
} finally {
  await browser.close();
}
