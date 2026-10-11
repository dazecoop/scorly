// Page chrome shared by the full-tab views (compare.html, report.html):
// the theme toggle and the Export dropdown. Same localStorage key as the
// popup, so the theme follows the user between all three.

function scorlyInitTheme() {
  const saved = localStorage.getItem('scorly-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('scorly-theme', next);
  });
}

function scorlyCloseExportMenu() {
  document.getElementById('exportPop').classList.add('hidden');
  document.getElementById('exportBtn').setAttribute('aria-expanded', 'false');
}

// onExport(format) is called with the menu item's data-export value
// (pdf / csv / json / md).
function scorlyInitExportMenu(onExport) {
  const btn = document.getElementById('exportBtn');
  const pop = document.getElementById('exportPop');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
    if (open) pop.querySelector('button').focus();
  });

  pop.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-export]');
    if (!item) return;
    scorlyCloseExportMenu();
    onExport(item.dataset.export);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#exportWrap')) scorlyCloseExportMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || pop.classList.contains('hidden')) return;
    scorlyCloseExportMenu();
    btn.focus();
  });
}

// Small preview for an image row. Loads from the analyzed site itself (or
// the inline data URI) — the same request the page already made.
function thumbImg(src) {
  const img = document.createElement('img');
  img.className = 'set-thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.onerror = () => img.classList.add('broken');
  img.src = src;
  return img;
}
