// Export a comparison as Markdown, CSV, JSON or PDF.
//
// Everything is generated locally from the diff model — the PDF via the same
// bundled, offline copy of jsPDF the popup uses. Nothing is uploaded.

function diffFilename(diff, ext) {
  const slug = (url) => {
    try {
      const u = new URL(url);
      return (u.host + u.pathname).replace(/[^a-z0-9.-]+/gi, '_').replace(/_+$/, '');
    } catch (e) {
      return 'page';
    }
  };
  return `scorly-compare-${slug(diff.a.url)}-vs-${slug(diff.b.url)}`.slice(0, 120) + '.' + ext;
}

function diffDownload(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const DIFF_STATUS_TEXT = {
  changed: 'changed',
  'a-only': 'A only',
  'b-only': 'B only',
  same: 'identical',
  improved: 'improved',
  regressed: 'regressed',
};

function seqItemText(item) {
  if (item === null || item === undefined) return '';
  if (item.level !== undefined) return `H${item.level} ${item.text}`;
  if (item.tag !== undefined) return `<${item.tag}> ${item.text}`;
  if (item.line !== undefined) return item.line;
  return String(item);
}

function numText(value, unit) {
  if (value === null || value === undefined) return '';
  return String(value) + (unit || '');
}

// Flattens one diff row into plain {field, status, a, b} lines, so the CSV
// and PDF writers don't each need to know about every row kind.
function diffRowLines(row) {
  if (row.kind === 'check') {
    return [{
      kind: 'check',
      field: `${row.label} (${row.category})`,
      status: row.direction === 'better' ? 'improved' : 'regressed',
      a: row.a,
      b: row.b,
    }];
  }
  if (row.kind === 'set') {
    return row.items.map((item) => ({
      field: `${row.label} › ${item.key}`,
      status: item.status,
      a: item.a,
      b: item.b,
    }));
  }
  if (row.kind === 'seq') {
    return row.ops.filter((op) => op.type !== 'eq').map((op) => {
      const text = seqItemText(op.type === 'ins' ? op.b : op.a);
      return {
        field: row.label,
        status: op.type === 'ins' ? 'b-only' : 'a-only',
        a: op.type === 'ins' ? '' : text,
        b: op.type === 'ins' ? text : '',
      };
    });
  }
  if (row.kind === 'num') {
    return [{ field: row.label, status: row.status, a: numText(row.a, row.unit), b: numText(row.b, row.unit) }];
  }
  return [{ field: row.label, status: row.status, a: row.a, b: row.b }];
}

function changedSections(diff) {
  return diff.sections
    .map((section) => ({ section, rows: section.rows.filter((r) => r.status !== 'same') }))
    .filter((entry) => entry.rows.length);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function diffToMarkdown(diff) {
  const lines = [];
  lines.push('# Scorly comparison');
  lines.push('');
  lines.push(`- **A** — ${diff.a.url} (captured ${diff.a.capturedAt})`);
  lines.push(`- **B** — ${diff.b.url} (captured ${diff.b.capturedAt})`);
  lines.push('');
  lines.push(`**Overall score:** A ${diff.scores.overall.a} → B ${diff.scores.overall.b} (${diff.scores.overall.delta >= 0 ? '+' : ''}${diff.scores.overall.delta})`);
  lines.push('');
  lines.push('| Category | A | B | Δ |');
  lines.push('| --- | --- | --- | --- |');
  diff.scores.categories.forEach((c) => {
    lines.push(`| ${c.label}${c.unreliable ? ' \\*' : ''} | ${c.a} | ${c.b} | ${c.delta >= 0 ? '+' : ''}${c.delta} |`);
  });
  lines.push('');
  if (!diff.scores.perfComparable) {
    lines.push('\\* One side was captured in a background tab, which records no paint timings, ' +
      'so the Performance score and the overall score are not like-for-like.');
    lines.push('');
  }

  changedSections(diff).forEach(({ section, rows }) => {
    lines.push(`## ${section.label} (${section.changed})`);
    lines.push('');
    rows.forEach((row) => {
      if (row.kind === 'check') {
        lines.push(`- **${row.label}** (${row.category}): ${row.a} → ${row.b}`);
        return;
      }
      if (row.kind === 'num') {
        lines.push(`- **${row.label}**: ${numText(row.a, row.unit) || '—'} → ${numText(row.b, row.unit) || '—'}`);
        return;
      }
      if (row.kind === 'set') {
        lines.push(`- **${row.label}** (${row.countA} → ${row.countB})`);
        row.items.forEach((item) => {
          const val = item.status === 'changed' ? `${item.a} → ${item.b}` : (item.a || item.b || '');
          lines.push(`  - [${DIFF_STATUS_TEXT[item.status]}] \`${item.key}\` ${val}`.trimEnd());
        });
        return;
      }
      if (row.kind === 'seq') {
        lines.push(`- **${row.label}** (${row.changedCount} changed)`);
        lines.push('');
        lines.push('```diff');
        row.ops.forEach((op) => {
          if (op.type === 'eq') return;
          lines.push((op.type === 'ins' ? '+ ' : '- ') + seqItemText(op.type === 'ins' ? op.b : op.a));
        });
        lines.push('```');
        lines.push('');
        return;
      }
      lines.push(`- **${row.label}**`);
      lines.push(`  - A: ${row.a === null ? '_not present_' : row.a}`);
      lines.push(`  - B: ${row.b === null ? '_not present_' : row.b}`);
    });
    lines.push('');
  });

  return lines.join('\n');
}

function exportDiffMarkdown(diff) {
  diffDownload(diffFilename(diff, 'md'), diffToMarkdown(diff), 'text/markdown');
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function diffCsvEscape(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function diffToCsv(diff) {
  const rows = [];
  rows.push(['Section', 'Field', 'Status', 'A', 'B']);
  rows.push(['', 'A URL', '', diff.a.url, '']);
  rows.push(['', 'B URL', '', '', diff.b.url]);
  rows.push(['Scores', 'Overall', diff.scores.overall.delta === 0 ? 'same' : 'changed',
    diff.scores.overall.a, diff.scores.overall.b]);
  diff.scores.categories.forEach((c) => {
    rows.push(['Scores', c.label + (c.unreliable ? ' (not comparable)' : ''),
      c.delta === 0 ? 'same' : 'changed', c.a, c.b]);
  });

  changedSections(diff).forEach(({ section, rows: sectionRows }) => {
    sectionRows.forEach((row) => {
      diffRowLines(row).forEach((line) => {
        rows.push([section.label, line.field, DIFF_STATUS_TEXT[line.status] || line.status, line.a, line.b]);
      });
    });
  });

  return rows.map((r) => r.map(diffCsvEscape).join(',')).join('\r\n');
}

function exportDiffCsv(diff) {
  diffDownload(diffFilename(diff, 'csv'), diffToCsv(diff), 'text/csv');
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function diffToJsonPayload(diff) {
  return {
    generatedAt: new Date().toISOString(),
    a: diff.a,
    b: diff.b,
    scores: diff.scores,
    sections: diff.sections.map((s) => ({
      id: s.id,
      label: s.label,
      changed: s.changed,
      rows: s.rows.filter((r) => r.status !== 'same').map((r) => {
        const out = { label: r.label, kind: r.kind, status: r.status };
        if (r.kind === 'set') out.items = r.items;
        else if (r.kind === 'seq') out.ops = r.ops.filter((o) => o.type !== 'eq');
        else { out.a = r.a; out.b = r.b; if (r.delta !== undefined) out.delta = r.delta; }
        return out;
      }),
    })),
  };
}

function exportDiffJson(diff) {
  diffDownload(diffFilename(diff, 'json'), JSON.stringify(diffToJsonPayload(diff), null, 2), 'application/json');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

// Builds the document and hands it back, so it can be rendered and inspected
// without going through the browser's download flow.
function diffPdfDoc(diff) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const contentWidth = pageWidth - marginX * 2;
  const COL_A = marginX + 190;
  const COL_B = marginX + 190 + (contentWidth - 190) / 2;
  let y = 50;

  const INK = [30, 30, 40];
  const MUTED = [110, 110, 122];
  const ADDED = [22, 120, 60];
  const REMOVED = [185, 35, 35];
  const WARN = [180, 110, 10];
  const ACCENT = [79, 70, 229];

  function ensureSpace(h) {
    if (y + h > pageHeight - 44) { doc.addPage(); y = 50; }
  }

  function text(str, x, size, style, color) {
    doc.setFont('helvetica', style || 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(str, x, y);
  }

  function heading(str, size) {
    ensureSpace(size + 16);
    y += 6;
    text(str, marginX, size, 'bold', INK);
    y += size * 0.45 + 6;
    doc.setDrawColor(225, 226, 232);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 14;
  }

  // splitTextToSize measures against whatever font is currently set, so the
  // size has to be applied before the split or the wrap is computed for the
  // wrong size and the text overruns its column.
  function wrap(str, width, size) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    return doc.splitTextToSize(str || '—', width);
  }

  // Wrapped text in a fixed-width column; returns the height it used.
  function column(str, x, width, size, color) {
    const lines = wrap(str, width, size);
    doc.setTextColor(color[0], color[1], color[2]);
    lines.forEach((line, i) => doc.text(line, x, y + i * (size + 2)));
    return lines.length * (size + 2);
  }

  // ---- Header ----
  text('Scorly comparison', marginX, 20, 'bold', INK);
  y += 26;
  text('A  ' + diff.a.url, marginX, 10, 'normal', ACCENT);
  y += 14;
  text('B  ' + diff.b.url, marginX, 10, 'normal', MUTED);
  y += 18;

  const delta = diff.scores.overall.delta;
  const bannerColor = delta === 0 ? [100, 100, 115] : delta > 0 ? ADDED : REMOVED;
  ensureSpace(46);
  doc.setFillColor(bannerColor[0], bannerColor[1], bannerColor[2]);
  doc.roundedRect(marginX, y, contentWidth, 38, 6, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(255, 255, 255);
  // jsPDF's built-in Helvetica is WinAnsi-encoded, which has no arrow glyph.
  doc.text(`Overall  ${diff.scores.overall.a}  ->  ${diff.scores.overall.b}`
    + (delta === 0 ? '   (no change)' : `   (${delta > 0 ? '+' : ''}${delta})`), marginX + 14, y + 24);
  y += 52;

  text(`${diff.totalChanged} difference${diff.totalChanged === 1 ? '' : 's'} across `
    + `${diff.sections.filter((s) => s.changed).length} sections`, marginX, 10, 'normal', MUTED);
  y += 16;

  // ---- Category scores ----
  heading('Scores', 13);
  [{ label: 'Overall', a: diff.scores.overall.a, b: diff.scores.overall.b, delta, bold: true }]
    .concat(diff.scores.categories).forEach((c) => {
      ensureSpace(16);
      const weight = c.bold ? 'bold' : 'normal';
      text(c.label + (c.unreliable ? ' *' : ''), marginX, 10, weight, INK);
      text(String(c.a), COL_A, 10, weight, MUTED);
      text(String(c.b), COL_B, 10, weight, MUTED);
      const d = c.delta;
      text(d === 0 ? '—' : `${d > 0 ? '+' : ''}${d}`, pageWidth - marginX - 30, 10, 'bold',
        c.unreliable || d === 0 ? MUTED : d > 0 ? ADDED : REMOVED);
      y += 16;
    });
  if (!diff.scores.perfComparable) {
    y += 4;
    y += column('* One side was captured in a background tab, which records no paint timings, so the '
      + 'Performance score and the overall score are not like-for-like.', marginX, contentWidth, 8, MUTED);
  }
  y += 6;

  // ---- Sections ----
  changedSections(diff).forEach(({ section, rows }) => {
    heading(`${section.label} — ${section.changed} change${section.changed === 1 ? '' : 's'}`, 12);

    rows.forEach((row) => {
      diffRowLines(row).forEach((line) => {
        const aText = line.a === null || line.a === undefined || line.a === '' ? '—' : String(line.a);
        const bText = line.b === null || line.b === undefined || line.b === '' ? '—' : String(line.b);
        const colWidth = (contentWidth - 196) / 2 - 10;

        // A scoring verdict reads by its own severity; everything else reads
        // as a removal on the A side and an addition on the B side.
        const verdict = (v) => (v === 'pass' ? ADDED : v === 'warn' ? WARN : REMOVED);
        const aColor = line.kind === 'check' ? verdict(line.a) : (line.status === 'b-only' ? MUTED : REMOVED);
        const bColor = line.kind === 'check' ? verdict(line.b) : (line.status === 'a-only' ? MUTED : ADDED);

        const fieldLines = wrap(line.field, 176, 9);
        const valueLines = Math.max(
          wrap(aText, colWidth, 9).length,
          wrap(bText, colWidth, 9).length
        );
        const height = Math.max(fieldLines.length * 11 + 11, valueLines * 11) + 7;
        ensureSpace(height);

        const top = y;
        column(line.field, marginX, 176, 9, INK);
        y = top + fieldLines.length * 11;
        text((DIFF_STATUS_TEXT[line.status] || line.status).toUpperCase(), marginX, 7, 'bold', MUTED);

        y = top;
        column(aText, COL_A, colWidth, 9, aColor);
        column(bText, COL_B, colWidth, 9, bColor);

        y = top + height;
        doc.setDrawColor(238, 239, 244);
        doc.line(marginX, y - 6, pageWidth - marginX, y - 6);
      });
    });
  });

  return doc;
}

function exportDiffPdf(diff) {
  diffPdfDoc(diff).save(diffFilename(diff, 'pdf'));
}
