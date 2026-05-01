const NOTIFICATION_TYPES = new Set(['ticker', 'info', 'warning', 'urgent']);

export const DEFAULT_NOTIFICATION_GROUPS = {
  tickerMessages: [],
  banners: [],
  popups: [],
};

const TICKER_SPEED_PRESETS = {
  slow: 56,
  normal: 42,
  fast: 28,
};

const CSV_COLUMNS = [
  'Enabled',
  'ID',
  'Type',
  'Title',
  'Message',
  'ShowPopup',
  'ShowBanner',
  'Persistent',
  'StartDate',
  'StartTime',
  'EndDate',
  'EndTime',
  'ActionText',
  'ActionURL',
  'CreatedAt',
  'UpdatedAt',
];

const DEFAULT_TIME_ZONE = 'America/New_York';

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.some((value) => String(value || '').trim() !== ''));
}

export function normalizeBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildFallbackId(record) {
  const seed = [
    slugify(record.ID),
    slugify(record.Title),
    slugify(record.StartDate),
    slugify(record.EndDate),
    slugify(record.Message).slice(0, 40),
  ].filter(Boolean).join('-');

  return seed || `notification-${Date.now()}`;
}

export function normalizeDate(value, { endOfDay = false } = {}) {
  const input = normalizeText(value);
  if (!input) return null;

  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let parsed;

  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    parsed = new Date(Number(year), Number(month) - 1, Number(day));
  } else {
    parsed = new Date(input);
  }

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }

  return parsed;
}

function normalizeTime(value) {
  const input = normalizeText(value);
  if (!input) return null;

  const normalized = input.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const match12 = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (match12) {
    let hours = Number(match12[1]) % 12;
    const minutes = Number(match12[2]);
    const seconds = Number(match12[3] || 0);
    if (minutes > 59 || seconds > 59) return null;
    if (match12[4] === 'PM') hours += 12;
    return { hours, minutes, seconds };
  }

  const match24 = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    const seconds = Number(match24[3] || 0);
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    return { hours, minutes, seconds };
  }

  return null;
}

function getEasternParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getEasternOffsetMinutes(date) {
  const parts = getEasternParts(date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUtc - date.getTime()) / 60000;
}

function buildEasternDate(dateValue, timeValue, defaultTime) {
  const date = normalizeDate(dateValue);
  if (!date) return null;

  const time = normalizeTime(timeValue) || defaultTime;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const utcGuess = new Date(Date.UTC(year, month, day, time.hours, time.minutes, time.seconds || 0, 0));
  const offsetMinutes = getEasternOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - (offsetMinutes * 60000));
}

function isActiveWindow(startDate, endDate, now = new Date()) {
  const current = new Date(now);

  if (startDate && current < startDate) return false;
  if (endDate && current > endDate) return false;
  return true;
}

function normalizeRow(record, index) {
  const enabled = normalizeBoolean(record.Enabled);
  if (!enabled) return null;

  const type = normalizeText(record.Type).toLowerCase();
  if (!NOTIFICATION_TYPES.has(type)) return null;

  const message = normalizeText(record.Message);
  if (!message) return null;

  const startDefaultTime = record.StartTime === null
    ? { hours: 0, minutes: 0, seconds: 0 }
    : { hours: 0, minutes: 0, seconds: 0 };
  const endDefaultTime = record.EndTime === null
    ? { hours: 23, minutes: 59, seconds: 59 }
    : { hours: 0, minutes: 0, seconds: 0 };
  const startDate = normalizeText(record.StartDate)
    ? buildEasternDate(record.StartDate, record.StartTime, startDefaultTime)
    : null;
  const endDate = normalizeText(record.EndDate)
    ? buildEasternDate(record.EndDate, record.EndTime, endDefaultTime)
    : null;

  if (normalizeText(record.EndDate) && !endDate) {
    return null;
  }

  if (startDate && endDate && startDate > endDate) {
    return null;
  }

  if (!isActiveWindow(startDate, endDate)) {
    return null;
  }

  const actionURL = normalizeText(record.ActionURL);
  const actionText = actionURL ? (normalizeText(record.ActionText) || 'Open') : '';
  const showPopup = normalizeBoolean(record.ShowPopup);
  const showBanner = normalizeBoolean(record.ShowBanner);
  const isTicker = type === 'ticker';

  if (!showPopup && !showBanner && !isTicker) {
    return null;
  }

  return {
    id: normalizeText(record.ID) || buildFallbackId(record),
    type,
    title: normalizeText(record.Title),
    message,
    showPopup,
    showBanner,
    persistent: normalizeBoolean(record.Persistent),
    startDate,
    endDate,
    startTime: normalizeText(record.StartTime),
    endTime: normalizeText(record.EndTime),
    actionText,
    actionURL,
    createdAt: normalizeText(record.CreatedAt),
    updatedAt: normalizeText(record.UpdatedAt),
    sourceRow: index + 2,
  };
}

export function parseNotificationsCsv(csvText) {
  const parsedRows = parseCsv(String(csvText || ''));
  if (!parsedRows.length) {
    return [];
  }

  const headers = parsedRows[0].map(normalizeHeader);
  const rows = parsedRows.slice(1);

  return rows
    .map((values) => {
      const record = {};
      CSV_COLUMNS.forEach((columnName) => {
        const headerIndex = headers.indexOf(normalizeHeader(columnName));
        record[columnName] = headerIndex >= 0 ? values[headerIndex] ?? '' : null;
      });
      return record;
    })
    .map(normalizeRow)
    .filter(Boolean);
}

export function groupNotifications(items) {
  return items.reduce((groups, item) => {
    if (item.type === 'ticker') {
      groups.tickerMessages.push(item);
    }

    if (item.showBanner) {
      groups.banners.push(item);
    }

    if (item.showPopup) {
      groups.popups.push(item);
    }

    return groups;
  }, {
    tickerMessages: [],
    banners: [],
    popups: [],
  });
}

export async function fetchNotificationsCsv(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'text/csv,text/plain,*/*',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Notification sheet request failed with status ${response.status}.`);
  }

  return response.text();
}

export async function loadNotificationsFromSheet(url, fetchImpl = fetch) {
  const trimmedUrl = normalizeText(url);
  if (!trimmedUrl) {
    return { ok: true, groups: DEFAULT_NOTIFICATION_GROUPS };
  }

  try {
    const csvText = await fetchNotificationsCsv(trimmedUrl, fetchImpl);
    const items = parseNotificationsCsv(csvText);
    return { ok: true, groups: groupNotifications(items) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to load notifications.',
      groups: DEFAULT_NOTIFICATION_GROUPS,
    };
  }
}

export function resolveTickerDurationSeconds(globalSpeed) {
  return TICKER_SPEED_PRESETS[normalizeText(globalSpeed).toLowerCase()] || TICKER_SPEED_PRESETS.normal;
}
