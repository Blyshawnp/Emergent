export const NOTIFICATION_MANAGER_STORAGE_KEY = 'mts-notification-manager-draft';

export const NOTIFICATION_TYPES = ['ticker', 'info', 'warning', 'urgent'];

export const NOTIFICATION_CSV_COLUMNS = [
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

const EASTERN_TIME_ZONE = 'America/New_York';

function parseCsvRows(text) {
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

function getEasternParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIME_ZONE,
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
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time24: `${parts.hour}:${parts.minute}`,
    timestamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-04:00`,
  };
}

export function getEasternNowDefaults() {
  const parts = getEasternParts();
  return {
    startDate: parts.date,
    startTime: toTwelveHour(parts.time24),
    createdAt: new Date().toISOString(),
  };
}

export function toTwelveHour(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  const match = input.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return input;
  const hours = Number(match[1]);
  const minutes = match[2];
  const period = hours >= 12 ? 'PM' : 'AM';
  const normalizedHours = hours % 12 || 12;
  return `${normalizedHours}:${minutes} ${period}`;
}

function parseTimeForValidation(value) {
  const input = String(value || '').trim().toUpperCase();
  if (!input) return null;

  const match12 = input.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (match12) {
    let hours = Number(match12[1]) % 12;
    const minutes = Number(match12[2]);
    if (minutes > 59) return null;
    if (match12[3] === 'PM') hours += 12;
    return { hours, minutes };
  }

  const match24 = input.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = Number(match24[1]);
    const minutes = Number(match24[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  return null;
}

function getEasternOffsetMinutes(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIME_ZONE,
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

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - date.getTime()) / 60000;
}

function buildEasternDateTime(dateValue, timeValue, defaultToMidnight = false) {
  if (!dateValue) return null;

  const dateMatch = String(dateValue).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const parsedTime = parseTimeForValidation(timeValue) || (defaultToMidnight ? { hours: 0, minutes: 0 } : { hours: 0, minutes: 0 });
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const utcGuess = new Date(Date.UTC(year, month, day, parsedTime.hours, parsedTime.minutes, 0, 0));
  const offset = getEasternOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offset * 60000);
}

export function createEmptyNotification() {
  const defaults = getEasternNowDefaults();
  return {
    Enabled: true,
    ID: '',
    Type: 'info',
    Title: '',
    Message: '',
    ShowPopup: false,
    ShowBanner: true,
    Persistent: false,
    StartDate: defaults.startDate,
    StartTime: defaults.startTime,
    EndDate: '',
    EndTime: '',
    ActionText: '',
    ActionURL: '',
    CreatedAt: defaults.createdAt,
    UpdatedAt: defaults.createdAt,
  };
}

export function normalizeManagerNotification(item = {}) {
  const base = createEmptyNotification();
  return {
    ...base,
    ...item,
    Enabled: item.Enabled !== false && String(item.Enabled).toLowerCase() !== 'false',
    ShowPopup: item.ShowPopup === true || String(item.ShowPopup).toLowerCase() === 'true',
    ShowBanner: item.ShowBanner === true || String(item.ShowBanner).toLowerCase() === 'true',
    Persistent: item.Persistent === true || String(item.Persistent).toLowerCase() === 'true',
    StartDate: item.StartDate || base.StartDate,
    StartTime: item.StartTime || base.StartTime,
    EndDate: item.EndDate || '',
    EndTime: item.EndTime || '',
    UpdatedAt: item.UpdatedAt || item.CreatedAt || base.UpdatedAt,
    CreatedAt: item.CreatedAt || base.CreatedAt,
  };
}

export function ensureNotificationId(item) {
  if (item.ID) return item.ID;
  const titleSeed = String(item.Title || item.Message || 'notification')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const dateSeed = String(item.StartDate || getEasternNowDefaults().startDate);
  return `${titleSeed || 'notification'}-${dateSeed}`;
}

export function validateNotification(item, existingItems = []) {
  const errors = [];
  const normalized = normalizeManagerNotification(item);
  const nextId = ensureNotificationId(normalized);

  if (!NOTIFICATION_TYPES.includes(normalized.Type)) {
    errors.push('Type must be ticker, info, warning, or urgent.');
  }

  if (!String(normalized.Message || '').trim()) {
    errors.push('Message is required.');
  }

  const duplicate = existingItems.find((entry) => entry !== item && String(entry.ID || '').trim() === nextId);
  if (duplicate) {
    errors.push('ID must be unique.');
  }

  if (normalized.ActionText && !normalized.ActionURL) {
    errors.push('Action URL is required when Action Text is filled.');
  }

  const startsAt = buildEasternDateTime(normalized.StartDate, normalized.StartTime);
  if (normalized.StartDate && !startsAt) {
    errors.push('Starts At must use a valid Eastern date and time.');
  }

  const expiresAt = normalized.EndDate
    ? buildEasternDateTime(normalized.EndDate, normalized.EndTime, true)
    : null;
  if (normalized.EndDate && !expiresAt) {
    errors.push('Expires At must use a valid Eastern date and time.');
  }

  if (startsAt && expiresAt && expiresAt <= startsAt) {
    errors.push('Expires At must be after Starts At.');
  }

  return {
    id: nextId,
    errors,
    startsAt,
    expiresAt,
  };
}

function encodeCsvCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function serializeNotificationsToCsv(items) {
  const header = NOTIFICATION_CSV_COLUMNS.join(',');
  const rows = items.map((item) => (
    NOTIFICATION_CSV_COLUMNS
      .map((column) => {
        if (column === 'ID') {
          return encodeCsvCell(ensureNotificationId(item));
        }
        if (column === 'EndTime' && item.EndDate && !item.EndTime) {
          return encodeCsvCell('12:00 AM');
        }
        const value = item[column];
        if (column === 'Enabled' || column === 'ShowPopup' || column === 'ShowBanner' || column === 'Persistent') {
          return encodeCsvCell(value ? 'TRUE' : 'FALSE');
        }
        return encodeCsvCell(value ?? '');
      })
      .join(',')
  ));

  return [header, ...rows].join('\r\n');
}

export function parseManagerCsv(csvText) {
  const rows = parseCsvRows(String(csvText || ''));
  if (!rows.length) return [];

  const headers = rows[0].map((value) => String(value || '').trim().toLowerCase());
  const records = rows.slice(1).map((values) => {
    const record = {};
    NOTIFICATION_CSV_COLUMNS.forEach((column) => {
      const index = headers.indexOf(column.toLowerCase());
      record[column] = index >= 0 ? values[index] ?? '' : '';
    });
    return record;
  });

  return records.map((record) => normalizeManagerNotification({
    Enabled: String(record.Enabled || '').trim().toUpperCase() !== 'FALSE',
    ID: record.ID || '',
    Type: record.Type || 'info',
    Title: record.Title || '',
    Message: record.Message || '',
    ShowPopup: String(record.ShowPopup || '').trim().toUpperCase() === 'TRUE',
    ShowBanner: String(record.ShowBanner || '').trim().toUpperCase() === 'TRUE',
    Persistent: String(record.Persistent || '').trim().toUpperCase() === 'TRUE',
    StartDate: record.StartDate || '',
    StartTime: record.StartTime || '',
    EndDate: record.EndDate || '',
    EndTime: record.EndTime || '',
    ActionText: record.ActionText || '',
    ActionURL: record.ActionURL || '',
    CreatedAt: record.CreatedAt || new Date().toISOString(),
    UpdatedAt: record.UpdatedAt || new Date().toISOString(),
  }));
}

export function downloadCsv(filename, contents) {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
