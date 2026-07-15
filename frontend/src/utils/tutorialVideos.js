export const TUTORIAL_VIDEO_HEADERS = [
  'Category',
  'VideoKey',
  'Title',
  'Description',
  'YouTubeURL',
  'Duration',
  'HelpTopicKey',
  'SortOrder',
  'Active',
  'Audience',
  'Notes',
];

export const MTS_TUTORIAL_CATEGORIES = [
  'Quick Start',
  'Getting Started',
  'Candidate Lookup',
  'Approved Headsets',
  'Mock Calls',
  'Supervisor Transfers',
  'Smart Resume',
  'Technical Issues',
  'Newbie Shifts',
  'Rescheduling',
  'Review and Form Fill',
  'History',
  'Discord Posts',
  'Settings',
  'Help and Shortcuts',
  'Troubleshooting',
];

export const SAM_TUTORIAL_CATEGORIES = [
  'Quick Start',
  'Dashboard',
  'Notifications',
  'Live Preview',
  'Candidate Search',
  'Candidate Tracking',
  'Pending Supervisor Transfers',
  'Pending Requests',
  'Headset Review',
  'Reports',
  'Updates',
  'Settings',
  'Help',
  'Troubleshooting',
];

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function extractYouTubeVideoId(value) {
  const text = String(value || '').trim();
  if (!text || /[<>]/.test(text)) return '';
  if (YOUTUBE_ID_RE.test(text)) return text;

  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    return '';
  }
  if (parsed.protocol !== 'https:' || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return '';

  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  let candidate = '';
  if (host === 'youtu.be') {
    candidate = segments[0] || '';
  } else if (parsed.pathname === '/watch') {
    candidate = parsed.searchParams.get('v') || '';
  } else if (['embed', 'shorts', 'live'].includes(segments[0])) {
    candidate = segments[1] || '';
  }
  return YOUTUBE_ID_RE.test(candidate) ? candidate : '';
}

export function buildYouTubeEmbedUrl(value) {
  const id = extractYouTubeVideoId(value);
  return id ? `https://www.youtube-nocookie.com/embed/${id}?rel=0` : '';
}

export function buildYouTubeWatchUrl(value) {
  const id = extractYouTubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : '';
}

function readField(row, name) {
  if (!row || typeof row !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const target = name.toLowerCase();
  const key = Object.keys(row).find((candidate) => String(candidate).trim().toLowerCase() === target);
  return key ? row[key] : '';
}

export function sheetBoolean(value) {
  if (value === true) return true;
  return ['true', '1', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeTutorialVideoRow(row, app = 'mts') {
  const videoKey = String(readField(row, 'VideoKey') || '').trim();
  const title = String(readField(row, 'Title') || '').trim();
  if (!videoKey || !title) return null;

  const rawUrl = String(readField(row, 'YouTubeURL') || '').trim();
  const videoId = rawUrl ? extractYouTubeVideoId(rawUrl) : '';
  if (rawUrl && !videoId) return null;

  const categories = app === 'sam' ? SAM_TUTORIAL_CATEGORIES : MTS_TUTORIAL_CATEGORIES;
  const requestedCategory = String(readField(row, 'Category') || '').trim();
  const category = categories.includes(requestedCategory) ? requestedCategory : 'Other Tutorials';
  const parsedSortOrder = Number.parseInt(String(readField(row, 'SortOrder') || '').trim(), 10);

  return {
    app: app === 'sam' ? 'sam' : 'mts',
    category,
    videoKey,
    title,
    description: String(readField(row, 'Description') || '').trim(),
    youtubeUrl: rawUrl,
    videoId,
    duration: String(readField(row, 'Duration') || '').trim(),
    helpTopicKey: String(readField(row, 'HelpTopicKey') || '').trim(),
    sortOrder: Number.isFinite(parsedSortOrder) ? parsedSortOrder : 9999,
    active: sheetBoolean(readField(row, 'Active')),
    audience: String(readField(row, 'Audience') || '').trim(),
  };
}

export function normalizeTutorialVideos(rows, app = 'mts', { activeOnly = true } = {}) {
  const categories = app === 'sam' ? SAM_TUTORIAL_CATEGORIES : MTS_TUTORIAL_CATEGORIES;
  const categoryOrder = new Map([...categories, 'Other Tutorials'].map((category, index) => [category, index]));
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeTutorialVideoRow(row, app))
    .filter((row) => row && (!activeOnly || row.active))
    .sort((left, right) => (
      (categoryOrder.get(left.category) ?? 999) - (categoryOrder.get(right.category) ?? 999)
      || left.sortOrder - right.sortOrder
      || left.title.localeCompare(right.title)
      || left.videoKey.localeCompare(right.videoKey)
    ));
}

export function groupTutorialVideos(rows) {
  return rows.reduce((groups, row) => {
    if (!groups[row.category]) groups[row.category] = [];
    groups[row.category].push(row);
    return groups;
  }, {});
}
