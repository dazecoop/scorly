// Snapshot store for page comparison.
//
// A snapshot is one analyzer result plus a label, persisted to
// chrome.storage.local so a page captured now can be diffed against one
// captured minutes or days ago. Nothing here touches the network: the store
// is local to this browser profile and the user empties it whenever they like.

const SCORLY_SNAP_KEY = 'scorly-snapshots';
const SCORLY_SNAP_LIMIT = 8;

const scorlyStorage = (typeof browser !== 'undefined' ? browser : chrome).storage.local;

// Storage quota is 10MB for the whole extension, so a snapshot is trimmed to
// the parts the diff actually reads before it is written.
function scorlySlimSnapshotData(data) {
  const d = JSON.parse(JSON.stringify(data));
  if (d.links) {
    d.links.internalList = (d.links.internalList || []).slice(0, 200);
    d.links.externalList = (d.links.externalList || []).slice(0, 200);
  }
  if (d.images) d.images.list = (d.images.list || []).slice(0, 120);
  if (d.headings) d.headings.list = (d.headings.list || []).slice(0, 300);
  d.textBlocks = (d.textBlocks || []).slice(0, 600);
  return d;
}

// Two snapshots of the same site differ only by path, so the label has to
// carry it — "127.0.0.1" twice in a picker tells you nothing.
function scorlyShortLabel(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return (u.host + path + u.search).slice(0, 70);
  } catch (e) {
    return String(url).slice(0, 70);
  }
}

function scorlyNewSnapshotId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function scorlyLoadSnapshots() {
  const stored = await scorlyStorage.get(SCORLY_SNAP_KEY);
  const list = stored && stored[SCORLY_SNAP_KEY];
  return Array.isArray(list) ? list : [];
}

async function scorlyWriteSnapshots(list) {
  await scorlyStorage.set({ [SCORLY_SNAP_KEY]: list });
}

async function scorlyGetSnapshot(id) {
  const list = await scorlyLoadSnapshots();
  return list.find((s) => s.id === id) || null;
}

// `origin` records how the page was read: 'tab' means it was the visible,
// foreground tab (so paint timings are trustworthy), 'background' means it
// was loaded in an inactive tab, where the browser never paints and LCP/CLS
// are not recorded. The compare view needs this to avoid showing a bogus
// performance regression.
async function scorlySaveSnapshot(data, { label, origin } = {}) {
  const list = await scorlyLoadSnapshots();
  const snapshot = {
    id: scorlyNewSnapshotId(),
    label: label || scorlyShortLabel(data.url),
    url: data.url,
    isLocalhost: !!data.isLocalhost,
    origin: origin || 'tab',
    capturedAt: new Date().toISOString(),
    data: scorlySlimSnapshotData(data),
  };

  let next = [snapshot].concat(list).slice(0, SCORLY_SNAP_LIMIT);
  try {
    await scorlyWriteSnapshots(next);
  } catch (err) {
    // Over quota: drop the oldest entries and retry once rather than losing
    // the capture the user just asked for.
    next = next.slice(0, Math.max(2, Math.floor(next.length / 2)));
    await scorlyWriteSnapshots(next);
  }
  return snapshot;
}

async function scorlyDeleteSnapshot(id) {
  const list = await scorlyLoadSnapshots();
  await scorlyWriteSnapshots(list.filter((s) => s.id !== id));
}

async function scorlyClearSnapshots() {
  await scorlyStorage.remove(SCORLY_SNAP_KEY);
}

function scorlyRelativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!then) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}
