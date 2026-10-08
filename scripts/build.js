#!/usr/bin/env node
/**
 * Build a drag/drop-ready, zipped extension package for Chrome or Firefox.
 *
 * Usage:
 *   node scripts/build.js chrome
 *   node scripts/build.js firefox
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BROWSER = process.argv[2];
if (BROWSER !== 'chrome' && BROWSER !== 'firefox') {
  console.error('Usage: node scripts/build.js <chrome|firefox>');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const DIST_ROOT = path.join(ROOT, 'dist');
const OUT_DIR = path.join(DIST_ROOT, BROWSER);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ZIP_NAME = `scorly-${BROWSER}-v${manifest.version}.zip`;
const ZIP_PATH = path.join(DIST_ROOT, ZIP_NAME);

// Files/dirs copied verbatim into the package root.
const INCLUDE = ['manifest.json', 'icons', 'popup'];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Clean previous output for this browser.
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.rmSync(ZIP_PATH, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const item of INCLUDE) {
  copyRecursive(path.join(ROOT, item), path.join(OUT_DIR, item));
}

// Firefox requires a stable add-on id; Chrome ignores browser_specific_settings
// entirely, so a single manifest.json works for both stores unmodified.

execSync(`zip -r -X "${ZIP_PATH}" . -x '.DS_Store' -x '__MACOSX/*'`, {
  cwd: OUT_DIR,
  stdio: 'inherit',
});

console.log(`\n[build:${BROWSER}] ready → ${path.relative(ROOT, ZIP_PATH)}`);
console.log(`[build:${BROWSER}] unpacked copy → ${path.relative(ROOT, OUT_DIR)}/`);
