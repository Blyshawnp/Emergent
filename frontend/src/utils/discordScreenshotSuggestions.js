export const DISCORD_SCREENSHOT_LIMIT = 3;

const BUILT_IN_SCREENSHOT_SUGGESTIONS = {
  welcome: ['/Discord-Instructions.png'],
  'no candidate': [],
  'fail session': [],
  'fail final attempt': [],
  'passed all': ['/welcome-new-agent.png'],
  'sup launch dte 1': ['/DTE-Taskbar.png'],
  'sup launch dte 2': ['/DTE-allow.png'],
  'sup launch dte 3': ['/DTE-permission.png'],
  'sup launch dte 4': ['/DTE-profile.png'],
  'change dte status': ['/DTE-ready.png'],
  'dte status': ['/DTE-ready.png'],
  'transfer instructions 1': ['/click-transfer.png'],
  'transfer instructions 2': ['/queue.png', '/transfer.png'],
  disposition: ['/script-disposition.png', '/DTE-disposition.png'],
  'disposition post': ['/script-disposition.png', '/DTE-disposition.png'],
  'usb fail': ['/usb.png'],
  'wrong headset': ['/usb.png'],
};

export function normalizeDiscordSuggestionTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/#/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeSuggestedScreenshotList(value) {
  const rawList = Array.isArray(value)
    ? value
    : String(value || '')
      .split('|');
  return rawList
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, DISCORD_SCREENSHOT_LIMIT);
}

export function getExplicitSuggestedScreenshots(item = {}) {
  if (!item || typeof item !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(item, 'suggestedScreenshots')) {
    return normalizeSuggestedScreenshotList(item.suggestedScreenshots);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'suggested_screenshots')) {
    return normalizeSuggestedScreenshotList(item.suggested_screenshots);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'SuggestedScreenshots')) {
    return normalizeSuggestedScreenshotList(item.SuggestedScreenshots);
  }
  const fieldValues = [
    item.suggestedScreenshot1 ?? item.SuggestedScreenshot1,
    item.suggestedScreenshot2 ?? item.SuggestedScreenshot2,
    item.suggestedScreenshot3 ?? item.SuggestedScreenshot3,
  ];
  if (fieldValues.some((value) => value !== undefined)) {
    return normalizeSuggestedScreenshotList(fieldValues);
  }
  return null;
}

export function getBuiltInDiscordScreenshotSuggestions(title) {
  const normalizedTitle = normalizeDiscordSuggestionTitle(title);
  return [...(BUILT_IN_SCREENSHOT_SUGGESTIONS[normalizedTitle] || [])];
}

export function getDiscordPostSuggestedScreenshotPaths(item = {}) {
  const explicit = getExplicitSuggestedScreenshots(item);
  if (explicit !== null) return explicit;
  return getBuiltInDiscordScreenshotSuggestions(item.title || item.Title || item.trigger || item.Trigger || '');
}

function normalizeScreenshotPath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(https?:|data:|blob:)/i.test(text)) return text.toLowerCase();
  return `/${text.replace(/^\/+/, '')}`.toLowerCase();
}

function titleFromPath(path) {
  const filename = String(path || '').split('/').pop() || 'Screenshot';
  return filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

export function resolveDiscordSuggestedScreenshots(template = {}, screenshots = []) {
  const paths = getDiscordPostSuggestedScreenshotPaths(template);
  return paths.map((path) => {
    const normalizedPath = normalizeScreenshotPath(path);
    const match = screenshots.find((screenshot) => normalizeScreenshotPath(screenshot.imageUrl || screenshot.image_url) === normalizedPath);
    if (match) return match;
    return {
      title: titleFromPath(path),
      imageUrl: path,
      category: 'Suggested',
    };
  });
}
