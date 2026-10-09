#!/usr/bin/env node
/**
 * End-to-end check of the compare feature, driving a real unpacked build in
 * Chrome: capture two variants of the same page, open the compare view, and
 * assert the differences we deliberately planted are all reported.
 *
 * Usage:
 *   npm run build:chrome && node scripts/test-compare.js
 *
 * Writes compare-view screenshots to scripts/output/.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const { serveComparePages } = require('./lib/serve-compare-pages');
const { findExtensionId } = require('./lib/extension-id');

const ROOT = path.join(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'dist', 'chrome');
const OUT_DIR = path.join(__dirname, 'output');

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    failures.push(name);
  }
}

async function main() {
  if (!fs.existsSync(EXT_PATH)) {
    console.error(`Missing ${EXT_PATH} — run \`npm run build:chrome\` first.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const server = await serveComparePages();
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--window-size=1400,1000',
    ],
  });

  try {
    const extId = await findExtensionId(browser);
    const compareUrl = `chrome-extension://${extId}/compare/compare.html`;

    // ---- 1. Popup path: analyze v1 in a visible tab, save it as snapshot A.
    console.log('\n[1] popup capture of the active tab');
    const sitePage = await browser.newPage();
    await sitePage.setViewport({ width: 1200, height: 800 });
    await sitePage.goto(`${base}/v1`, { waitUntil: 'networkidle0', timeout: 20000 });

    const popup = await browser.newPage();
    await popup.setViewport({ width: 500, height: 620 });
    await sitePage.bringToFront();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await sitePage.bringToFront();
    await new Promise((r) => setTimeout(r, 2500));

    const popupState = await popup.evaluate(() => ({
      visible: !document.getElementById('mainContent').classList.contains('hidden'),
      error: document.getElementById('errorText').textContent,
      hasSaveBtn: !!document.getElementById('saveSnapBtn'),
      textBlocks: typeof lastData !== 'undefined' && lastData ? (lastData.textBlocks || []).length : -1,
    }));
    check('popup analyzed the page without error', popupState.visible, popupState.error);
    check('popup shows the compare bar', popupState.hasSaveBtn);

    const popupMd = await popup.evaluate(() => ({
      hasButton: !!document.getElementById('exportMd'),
      buttons: Array.from(document.querySelectorAll('.export-btn')).map((b) => b.textContent.trim()),
      md: toMarkdown(lastData, lastScoreResult),
    }));
    check('popup offers four export formats',
      JSON.stringify(popupMd.buttons) === '["PDF","CSV","JSON","Markdown"]', JSON.stringify(popupMd.buttons));
    check('popup markdown export includes the score table',
      popupMd.md.includes('# Scorly report') && popupMd.md.includes('| Category | Score |'));
    check('popup markdown export lists checks',
      /- \[[ x]\] \*\*/.test(popupMd.md), popupMd.md.split('\n').slice(-4).join(' | '));

    await popup.evaluate(() => document.getElementById('saveSnapBtn').click());
    await new Promise((r) => setTimeout(r, 1200));
    const savedCount = await popup.evaluate(() => document.getElementById('snapCount').textContent);
    check('"Save snapshot" stored a snapshot', /1 saved/.test(savedCount), `count read "${savedCount}"`);
    await popup.screenshot({ path: path.join(OUT_DIR, 'compare-popup-bar.png') });
    await popup.close();

    // ---- 2. Compare page: capture v2 into slot B via a background tab.
    console.log('\n[2] compare view, background capture of the second URL');
    const cmp = await browser.newPage();
    await cmp.setViewport({ width: 1400, height: 1000 });
    await cmp.goto(compareUrl, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));

    const options = await cmp.evaluate(() =>
      Array.from(document.querySelectorAll('#slotSelectA option')).map((o) => o.textContent));
    check('saved snapshot is offered in the picker', options.some((t) => /127\.0\.0\.1/.test(t)),
      JSON.stringify(options));

    // Select the popup-saved snapshot as A.
    await cmp.evaluate(() => {
      const select = document.getElementById('slotSelectA');
      select.selectedIndex = 1;
      select.dispatchEvent(new Event('change'));
    });
    await new Promise((r) => setTimeout(r, 600));

    await cmp.screenshot({ path: path.join(OUT_DIR, 'compare-setup.png'), fullPage: true });

    // Capture v2 as B through the background-tab path. With both sides now
    // filled, the view should go straight to the diff on its own.
    await cmp.evaluate((url) => {
      const form = document.querySelector('.slot-form[data-capture="b"]');
      form.querySelector('.slot-url').value = url;
      form.dispatchEvent(new Event('submit'));
    }, `${base}/v2`);
    await cmp.waitForFunction(
      () => !document.getElementById('diffPane').classList.contains('hidden'),
      { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 900));

    check('capturing the second side goes straight to the diff', true);
    const sideB = await cmp.evaluate(() => ({
      url: document.getElementById('sideUrlB').textContent,
      meta: document.getElementById('sideMetaB').textContent,
    }));
    check('background capture filled side B', /v2/.test(sideB.url), sideB.url);
    check('background capture is labelled as such', /background/.test(sideB.meta), sideB.meta);

    // ---- 3. Diff contents.
    console.log('\n[3] diff output');

    const diff = await cmp.evaluate(() => {
      const model = state.diff;
      const find = (sectionId, label) => {
        const section = model.sections.find((s) => s.id === sectionId);
        return section && section.rows.find((r) => r.label === label);
      };
      return {
        total: model.totalChanged,
        sections: model.sections.map((s) => ({ id: s.id, changed: s.changed })),
        title: find('meta', 'Title'),
        desc: find('meta', 'Meta description'),
        ogTitle: find('social', 'og:title'),
        ogSiteName: model.sections.find((s) => s.id === 'social').rows.find((r) => r.label === 'og:site_name'),
        outline: find('headings', 'Outline'),
        copy: find('text', 'Copy blocks'),
        alt: find('images', 'Alt text'),
        internal: find('links', 'Internal links'),
        jsonld: find('schema', 'JSON-LD'),
        perfUnreliable: model.sections.find((s) => s.id === 'perf').unreliable,
        checkCategories: model.sections.find((s) => s.id === 'checks').rows.map((r) => r.category),
        visibleSections: Array.from(document.querySelectorAll('#sectionHost .sec')).map((s) => s.id),
        insSpans: document.querySelectorAll('.inline-diff .ins').length,
        delSpans: document.querySelectorAll('.inline-diff .del').length,
        seqIns: document.querySelectorAll('.seq-line.ins').length,
        seqDel: document.querySelectorAll('.seq-line.del').length,
      };
    });

    check('diff found differences', diff.total > 0, `total=${diff.total}`);
    check('title reported as changed', diff.title && diff.title.status === 'changed', JSON.stringify(diff.title && diff.title.status));
    check('title carries a word-level diff', !!(diff.title && diff.title.ops && diff.title.ops.length));
    check('one-word description edit is isolated',
      diff.desc && diff.desc.ops && diff.desc.ops.filter((o) => o.type !== 'eq').length <= 4,
      diff.desc && JSON.stringify(diff.desc.ops.filter((o) => o.type !== 'eq')));
    check('og:title reported as changed', diff.ogTitle && diff.ogTitle.status === 'changed');
    check('og:site_name present only on B', diff.ogSiteName && diff.ogSiteName.status === 'b-only',
      diff.ogSiteName && diff.ogSiteName.status);
    check('added H2 shows as a single insertion',
      diff.outline && diff.outline.ops.filter((o) => o.type === 'ins').length === 1 &&
      diff.outline.ops.filter((o) => o.type === 'del').length === 0,
      diff.outline && JSON.stringify(diff.outline.ops.filter((o) => o.type !== 'eq')));
    check('body copy edits detected', diff.copy && diff.copy.changedCount > 0, `changed=${diff.copy && diff.copy.changedCount}`);
    check('alt-text change detected', diff.alt && diff.alt.items.length > 0, JSON.stringify(diff.alt && diff.alt.items));
    check('new internal link detected',
      diff.internal && diff.internal.items.some((i) => i.status === 'b-only' && /enterprise/.test(i.key)),
      JSON.stringify(diff.internal && diff.internal.items));
    check('JSON-LD field change detected', diff.jsonld && diff.jsonld.changedCount > 0);
    check('perf marked not comparable after a background capture', diff.perfUnreliable === true);
    check('no false perf regressions in changed checks',
      !diff.checkCategories.includes('Performance'), JSON.stringify(diff.checkCategories));
    check('inline word diff rendered', diff.insSpans > 0 && diff.delSpans > 0,
      `ins=${diff.insSpans} del=${diff.delSpans}`);
    check('sequence diff rendered', diff.seqIns > 0, `ins lines=${diff.seqIns}`);

    await cmp.screenshot({ path: path.join(OUT_DIR, 'compare-diff.png'), fullPage: true });

    // ---- 4. Controls.
    console.log('\n[4] controls');
    const beforeSwap = await cmp.evaluate(() => document.getElementById('sideUrlA').textContent);
    await cmp.evaluate(() => document.getElementById('swapBtn').click());
    await new Promise((r) => setTimeout(r, 600));
    const afterSwap = await cmp.evaluate(() => document.getElementById('sideUrlA').textContent);
    check('swap exchanges the two sides', beforeSwap !== afterSwap, `${beforeSwap} vs ${afterSwap}`);
    await cmp.evaluate(() => document.getElementById('swapBtn').click());
    await new Promise((r) => setTimeout(r, 600));

    const rowsWithFilterOff = await cmp.evaluate(() => {
      document.getElementById('diffOnly').checked = false;
      document.getElementById('diffOnly').dispatchEvent(new Event('change'));
      return document.querySelectorAll('#sectionHost .row, #sectionHost .check-row').length;
    });
    await new Promise((r) => setTimeout(r, 400));
    const rowsWithFilterOn = await cmp.evaluate(() => {
      document.getElementById('diffOnly').checked = true;
      document.getElementById('diffOnly').dispatchEvent(new Event('change'));
      return document.querySelectorAll('#sectionHost .row, #sectionHost .check-row').length;
    });
    check('"only differences" hides identical rows', rowsWithFilterOn < rowsWithFilterOff,
      `${rowsWithFilterOn} of ${rowsWithFilterOff} rows`);

    await cmp.evaluate(() => {
      const input = document.getElementById('filterInput');
      input.value = 'og:';
      input.dispatchEvent(new Event('input'));
    });
    await new Promise((r) => setTimeout(r, 400));
    const filtered = await cmp.evaluate(() =>
      Array.from(document.querySelectorAll('#sectionHost .row-label')).map((n) => n.textContent));
    check('text filter narrows to matching fields',
      filtered.length > 0 && filtered.every((l) => /og:/i.test(l)), JSON.stringify(filtered));
    await cmp.evaluate(() => {
      const input = document.getElementById('filterInput');
      input.value = '';
      input.dispatchEvent(new Event('input'));
    });

    // ---- Export menu ----
    console.log('\n[5] export menu');
    const menuClosed = await cmp.evaluate(() =>
      document.getElementById('exportPop').classList.contains('hidden'));
    check('export menu starts closed', menuClosed);

    const menuItems = await cmp.evaluate(() => {
      document.getElementById('exportBtn').click();
      return {
        open: !document.getElementById('exportPop').classList.contains('hidden'),
        items: Array.from(document.querySelectorAll('#exportPop button[data-export]'))
          .map((b) => [b.dataset.export, b.textContent.trim()]),
      };
    });
    check('export button opens the menu', menuItems.open);
    check('menu offers PDF, CSV, JSON and Markdown',
      JSON.stringify(menuItems.items.map((i) => i[0])) === '["pdf","csv","json","md"]',
      JSON.stringify(menuItems.items));
    check('menu items are labelled',
      JSON.stringify(menuItems.items.map((i) => i[1])) === '["PDF","CSV","JSON","Markdown"]',
      JSON.stringify(menuItems.items.map((i) => i[1])));

    const closedByOutside = await cmp.evaluate(() => {
      document.body.click();
      return document.getElementById('exportPop').classList.contains('hidden');
    });
    check('clicking outside closes the menu', closedByOutside);

    const exporters = await cmp.evaluate(() => ({
      pdf: typeof exportDiffPdf, csv: typeof exportDiffCsv,
      json: typeof exportDiffJson, md: typeof exportDiffMarkdown,
      jspdf: typeof window.jspdf,
    }));
    check('all four exporters are loaded',
      Object.values(exporters).every((t) => t === 'function' || t === 'object'), JSON.stringify(exporters));

    const md = await cmp.evaluate(() => diffToMarkdown(state.diff));
    check('markdown export mentions the title change', /Title/.test(md) && md.includes('# Scorly comparison'));
    check('markdown export includes a diff block', md.includes('```diff'));
    fs.writeFileSync(path.join(OUT_DIR, 'compare-export.md'), md);

    const csv = await cmp.evaluate(() => diffToCsv(state.diff));
    check('csv export has a header row', csv.startsWith('Section,Field,Status,A,B'));
    check('csv export lists the changed title',
      csv.split('\r\n').some((line) => line.startsWith('Meta,Title,changed,')), csv.split('\r\n')[6]);
    fs.writeFileSync(path.join(OUT_DIR, 'compare-export.csv'), csv);

    // jsPDF throws on a malformed document, so rendering one cleanly to a
    // non-trivial byte count is a real check.
    const pdf = await cmp.evaluate(() => {
      const doc = diffPdfDoc(state.diff);
      return {
        bytes: doc.output('arraybuffer').byteLength,
        pages: doc.internal.getNumberOfPages(),
      };
    });
    check('pdf export builds a document', pdf.bytes > 5000, `${pdf.bytes} bytes`);
    check('pdf export paginates long diffs', pdf.pages >= 2, `${pdf.pages} page(s)`);

    // ---- 6. Snapshot management.
    console.log('\n[6] snapshot management');
    await cmp.evaluate(() => document.getElementById('backBtn').click());
    await new Promise((r) => setTimeout(r, 600));
    const listed = await cmp.evaluate(() => document.querySelectorAll('#snapList li').length);
    check('both snapshots are listed for management', listed === 2, `${listed} listed`);

    await cmp.evaluate(() => {
      window.confirm = () => true;
      document.getElementById('clearAllBtn').click();
    });
    await new Promise((r) => setTimeout(r, 800));
    const afterClear = await cmp.evaluate(() => document.querySelector('#snapList li').className);
    check('"delete all" empties local storage', afterClear === 'snap-empty', afterClear);

    const storageLeft = await cmp.evaluate(() => chrome.storage.local.get(null).then((all) => JSON.stringify(all)));
    check('nothing left behind in extension storage', storageLeft === '{}', storageLeft);

  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('All compare checks passed.');
  console.log(`Screenshots in ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
