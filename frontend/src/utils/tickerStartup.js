import { DEFAULT_NOTIFICATION_GROUPS } from './notifications';

export const TICKER_CACHE_KEY = 'mts:ticker-cache:v1';
export const TICKER_CACHE_VERSION = 1;
export const TICKER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let notificationRefreshInFlight = null;

export function createTickerRequestGuard() {
  let latestSequence = 0;
  return {
    begin: () => {
      latestSequence += 1;
      return latestSequence;
    },
    invalidate: () => {
      latestSequence += 1;
    },
    isLatest: (sequence) => sequence === latestSequence,
  };
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeTickerItem(item, index) {
  if (!item || typeof item !== 'object') return null;
  const message = cleanText(item.message);
  if (!message) return null;

  const endTime = cleanText(item.endTime);
  return {
    id: cleanText(item.id) || `cached-ticker-${index}`,
    type: ['info', 'warning', 'urgent'].includes(cleanText(item.type).toLowerCase())
      ? cleanText(item.type).toLowerCase()
      : 'info',
    title: cleanText(item.title),
    message,
    showTicker: item.showTicker !== false,
    persistent: Boolean(item.persistent),
    endTime,
  };
}

export function normalizeTickerGroups(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tickerMessages)) {
    return null;
  }

  return {
    tickerMessages: payload.tickerMessages
      .map(normalizeTickerItem)
      .filter((item) => item && item.showTicker),
    banners: Array.isArray(payload.banners) ? payload.banners : [],
    popups: Array.isArray(payload.popups) ? payload.popups : [],
  };
}

function isUnexpired(item, now) {
  if (!item.endTime) return true;
  const endTime = Date.parse(item.endTime);
  return Number.isFinite(endTime) && endTime >= now;
}

export function readTickerCache(storage = window.localStorage, now = Date.now()) {
  try {
    const parsed = JSON.parse(storage.getItem(TICKER_CACHE_KEY) || 'null');
    if (
      parsed?.version !== TICKER_CACHE_VERSION
      || !Number.isFinite(parsed?.savedAt)
      || now - parsed.savedAt > TICKER_CACHE_MAX_AGE_MS
      || now < parsed.savedAt
      || !Array.isArray(parsed?.tickerMessages)
    ) {
      return DEFAULT_NOTIFICATION_GROUPS;
    }

    const tickerMessages = parsed.tickerMessages
      .map(normalizeTickerItem)
      .filter((item) => item && item.showTicker && item.type !== 'urgent' && isUnexpired(item, now));

    return { ...DEFAULT_NOTIFICATION_GROUPS, tickerMessages };
  } catch (_error) {
    return DEFAULT_NOTIFICATION_GROUPS;
  }
}

export function writeTickerCache(payload, storage = window.localStorage, now = Date.now()) {
  const groups = normalizeTickerGroups(payload);
  if (!groups || payload?.source !== 'google') return false;

  try {
    storage.setItem(TICKER_CACHE_KEY, JSON.stringify({
      version: TICKER_CACHE_VERSION,
      savedAt: now,
      tickerMessages: groups.tickerMessages,
    }));
    return true;
  } catch (_error) {
    return false;
  }
}

export function refreshTickerNotifications(loadNotifications) {
  if (notificationRefreshInFlight) return notificationRefreshInFlight;

  notificationRefreshInFlight = Promise.resolve()
    .then(loadNotifications)
    .finally(() => {
      notificationRefreshInFlight = null;
    });
  return notificationRefreshInFlight;
}

export function resetTickerRefreshForTests() {
  notificationRefreshInFlight = null;
}
