#!/usr/bin/env node
/**
 * Capture marketing-grade screenshots of the compare view (dark theme) by
 * driving a real unpacked build against two deliberately-different variants
 * of the same page.
 *
 * Usage:
 *   npm run build:chrome && node scripts/capture-compare.js
 *
 * Writes scripts/output/compare-shot-*.png, which compose-slides.js then
 * composites into the wide store screenshots.
 *
 * Unlike the popup captures (a fixed 500x600 window), the compare view is a
 * full tab, so each shot is a clip around the region worth showing. The clips
 * are kept close to the width they're displayed at in the slide, so the text
 * in them stays readable at 1280x800.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { serveComparePages, LIVE_HOST } = require('./lib/serve-compare-pages');
const { findExtensionId } = require('./lib/extension-id');

const ROOT = path.join(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(__dirname, 'output');

const SHOT_WIDTH = 900;
const LOCAL_PORT = 3000;
const SHOT_HEIGHT = 600;

// Clips a SHOT_WIDTH x SHOT_HEIGHT region starting at `selector`, or at the
// very top of the page when `selector` is null (which includes the toolbar).
//
// The page is scrolled to the top first: captureBeyondViewport renders the
// whole document, and the view's sticky toolbar and jump nav then sit at
// their static positions. Clipping against a scrolled page instead leaves
// them pasted over whatever the clip starts at.
async function clipTo(page, file, selector) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 200));

  const y = selector === null ? 0 : await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    return node.getBoundingClientRect().y + window.scrollY - 14;
  }, selector);
  if (y === null) throw new Error(`No element matching ${selector}`);

  const outPath = path.join(OUT_DIR, file);
  await page.screenshot({
    path: outPath,
    captureBeyondViewport: true,
    clip: { x: 0, y: Math.max(0, y), width: SHOT_WIDTH, height: SHOT_HEIGHT },
  });
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

async function main() {
  if (!fs.existsSync(EXT_PATH)) {
    console.error(`Missing ${EXT_PATH} — run \`npm run build:chrome\` first.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = await serveComparePages({ port: LOCAL_PORT, tls: true });
  const port = server.address().port;
  const localUrl = `http://localhost:${port}/pricing`;
  const liveUrl = `https://${LIVE_HOST}/pricing`;

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      // Point Chrome at the demo server as a proxy, so the "live" side can
      // show a clean hostname with no port while never leaving the machine.
      // Loopback is bypassed by default, so the localhost side stays direct.
      `--proxy-server=http://127.0.0.1:${port}`,
      // The demo's live side uses a throwaway self-signed cert.
      '--ignore-certificate-errors',
      '--window-size=1200,1000',
    ],
  });

  try {
    const extId = await findExtensionId(browser);

    // Both sides are captured from a visible tab, via the popup, so the
    // screenshots show a straight like-for-like comparison with no
    // background-capture caveat on the performance numbers.
    const sitePage = await browser.newPage();
    await sitePage.setViewport({ width: 1100, height: 800 });

    const popup = await browser.newPage();
    await popup.setViewport({ width: 500, height: 600 });
    await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

    for (const url of [liveUrl, localUrl]) {
      await sitePage.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      await sitePage.bringToFront();
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
      await sitePage.bringToFront();
      await new Promise((r) => setTimeout(r, 2500));
      await popup.evaluate(() => document.getElementById('saveSnapBtn').click());
      await new Promise((r) => setTimeout(r, 1000));
    }
    await popup.close();

    const cmp = await browser.newPage();
    // Viewport == clip width, so the full content column lands in the shot.
    await cmp.setViewport({ width: SHOT_WIDTH, height: 1000, deviceScaleFactor: 2 });
    await cmp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await cmp.evaluateOnNewDocument(() => localStorage.setItem('scorly-theme', 'dark'));
    await cmp.goto(`chrome-extension://${extId}/compare/compare.html`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));

    await clipTo(cmp, 'compare-shot-setup.png', '.setup-h');

    // A = the localhost build (saved last), B = the live site.
    await cmp.evaluate((local, live) => {
      const pick = (id, match) => {
        const select = document.getElementById(id);
        const option = Array.from(select.options).find((o) => o.textContent.includes(match));
        select.value = option.value;
        select.dispatchEvent(new Event('change'));
      };
      pick('slotSelectA', local);
      pick('slotSelectB', live);
    }, 'localhost', LIVE_HOST);
    await cmp.waitForFunction(
      () => !document.getElementById('diffPane').classList.contains('hidden'),
      { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. Headline shot: toolbar, the two side cards, and the score table.
    await clipTo(cmp, 'compare-shot-scores.png', null);

    // 2. Wording shot: the Meta and Open Graph sections, where the word-level
    //    diffs of title, description and og: tags are visible.
    await cmp.evaluate(() => {
      document.querySelectorAll('#sectionHost .sec').forEach((s) => {
        s.open = ['sec-meta', 'sec-social'].includes(s.id);
      });
    });
    await new Promise((r) => setTimeout(r, 500));
    await clipTo(cmp, 'compare-shot-wording.png', '#sec-meta');

    // 3. Copy shot: the heading outline and body-text sequence diffs.
    await cmp.evaluate(() => {
      document.querySelectorAll('#sectionHost .sec').forEach((s) => {
        s.open = ['sec-headings', 'sec-text'].includes(s.id);
      });
    });
    await new Promise((r) => setTimeout(r, 500));
    await clipTo(cmp, 'compare-shot-copy.png', '#sec-headings');

  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
