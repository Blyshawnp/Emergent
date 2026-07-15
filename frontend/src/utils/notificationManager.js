export const NOTIFICATION_MANAGER_STORAGE_KEY = 'sam-notification-manager-draft';

export const PENDING_REQUEST_SUPPRESSION_STORAGE_KEY = 'sam:pending-request-suppressions:v1';
export const PENDING_REQUEST_SUPPRESSION_MS = 30 * 60 * 1000;
export const MAX_PENDING_REQUEST_SUPPRESSIONS = 250;

const PENDING_REQUEST_SUPPRESSION_TYPES = new Set(['remind', 'dismiss']);

function suppressionEntriesEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

export function normalizePendingRequestSuppressions(value, now = Date.now(), unresolvedRequestIds = null) {
  const entries = Array.isArray(value) ? value : [];
  const unresolvedIds = unresolvedRequestIds === null
    ? null
    : new Set(Array.from(unresolvedRequestIds || []).map((requestId) => String(requestId || '').trim()).filter(Boolean));
  const latestByRequestId = new Map();

  entries.forEach((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const requestId = String(entry.request_id || '').trim();
    const suppressionType = String(entry.suppression_type || '').trim().toLowerCase();
    const expiresAt = Number(entry.expires_at);
    if (!requestId || !PENDING_REQUEST_SUPPRESSION_TYPES.has(suppressionType)) return;
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + PENDING_REQUEST_SUPPRESSION_MS) return;
    if (unresolvedIds && !unresolvedIds.has(requestId)) return;
    const current = latestByRequestId.get(requestId);
    if (!current || expiresAt >= current.expires_at) {
      latestByRequestId.set(requestId, {
        request_id: requestId,
        suppression_type: suppressionType,
        expires_at: expiresAt,
      });
    }
  });

  return Array.from(latestByRequestId.values())
    .sort((left, right) => left.expires_at - right.expires_at || left.request_id.localeCompare(right.request_id))
    .slice(-MAX_PENDING_REQUEST_SUPPRESSIONS);
}

export function savePendingRequestSuppressions(storage, value, now = Date.now()) {
  const normalized = normalizePendingRequestSuppressions(value, now);
  try {
    if (!normalized.length) {
      storage?.removeItem?.(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY);
    } else {
      storage?.setItem?.(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch (_error) {}
  return normalized;
}

export function loadPendingRequestSuppressions(storage, now = Date.now()) {
  let parsed = [];
  let storedValue = null;
  let parseFailed = false;
  try {
    storedValue = storage?.getItem?.(PENDING_REQUEST_SUPPRESSION_STORAGE_KEY);
    parsed = storedValue ? JSON.parse(storedValue) : [];
  } catch (_error) {
    parsed = [];
    parseFailed = true;
  }
  const normalized = normalizePendingRequestSuppressions(parsed, now);
  if (storedValue !== null && (parseFailed || !suppressionEntriesEqual(parsed, normalized))) {
    savePendingRequestSuppressions(storage, normalized, now);
  }
  return normalized;
}

export function suppressPendingRequest(value, requestId, suppressionType, now = Date.now()) {
  const normalizedRequestId = String(requestId || '').trim();
  const normalizedType = String(suppressionType || '').trim().toLowerCase();
  const current = normalizePendingRequestSuppressions(value, now)
    .filter((entry) => entry.request_id !== normalizedRequestId);
  if (!normalizedRequestId || !PENDING_REQUEST_SUPPRESSION_TYPES.has(normalizedType)) return current;
  return normalizePendingRequestSuppressions([
    ...current,
    {
      request_id: normalizedRequestId,
      suppression_type: normalizedType,
      expires_at: now + PENDING_REQUEST_SUPPRESSION_MS,
    },
  ], now);
}

export function getUnresolvedPendingRequests(requests) {
  return (Array.isArray(requests) ? requests : []).filter((request) => (
    String(request?.request_id || '').trim()
    && String(request?.raw_status || request?.status || '').trim().toLowerCase() === 'pending'
  ));
}

export function prunePendingRequestSuppressions(value, requests, now = Date.now()) {
  const unresolvedIds = getUnresolvedPendingRequests(requests).map((request) => request.request_id);
  return normalizePendingRequestSuppressions(value, now, unresolvedIds);
}

export function isPendingRequestSuppressed(value, requestId, now = Date.now()) {
  const normalizedRequestId = String(requestId || '').trim();
  return normalizePendingRequestSuppressions(value, now)
    .some((entry) => entry.request_id === normalizedRequestId && entry.expires_at > now);
}

export function getNearestPendingRequestSuppressionExpiry(value, now = Date.now()) {
  const normalized = normalizePendingRequestSuppressions(value, now);
  return normalized.length ? normalized[0].expires_at : null;
}

export function selectPendingRequestAlert(requests, suppressions, handledRequestIds = [], now = Date.now()) {
  const handledIds = new Set(Array.from(handledRequestIds || []).map((requestId) => String(requestId || '').trim()));
  return getUnresolvedPendingRequests(requests)
    .filter((request) => !handledIds.has(String(request.request_id)) && !isPendingRequestSuppressed(suppressions, request.request_id, now))
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at || left.request_created_at || '');
      const rightTime = Date.parse(right.created_at || right.request_created_at || '');
      const safeLeftTime = Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY;
      const safeRightTime = Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY;
      return safeLeftTime - safeRightTime || String(left.request_id).localeCompare(String(right.request_id));
    })[0] || null;
}

export const NOTIFICATION_TYPES = ['info', 'warning', 'urgent'];

export const NOTIFICATION_CSV_COLUMNS = [
  'Enabled',
  'ID',
  'Type',
  'Title',
  'Message',
  'ShowTicker',
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
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time24: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
    timestamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}-04:00`,
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
  const normalized24 = hours === 24 ? 0 : hours;
  const period = normalized24 >= 12 ? 'PM' : 'AM';
  const normalizedHours = normalized24 % 12 || 12;
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
    hourCycle: 'h23',
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
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - date.getTime()) / 60000;
}

function buildEasternDateTime(dateValue, timeValue, defaultToMidnight = false) {
  if (!dateValue) return null;

  const dateMatch = String(dateValue).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const timeText = String(timeValue || '').trim();
  const parsedTime = timeText ? parseTimeForValidation(timeText) : (defaultToMidnight ? { hours: 0, minutes: 0 } : { hours: 0, minutes: 0 });
  if (!parsedTime) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]) - 1;
  const day = Number(dateMatch[3]);
  const utcGuess = new Date(Date.UTC(year, month, day, parsedTime.hours, parsedTime.minutes, 0, 0));
  const offset = getEasternOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offset * 60000);
}

export function getNotificationExpiryDate(item) {
  const normalized = normalizeManagerNotification(item);
  if (!normalized.EndDate) return null;
  return buildEasternDateTime(normalized.EndDate, normalized.EndTime, true);
}

export function isExpiredNotification(item, now = new Date()) {
  const expiresAt = getNotificationExpiryDate(item);
  if (!expiresAt) return false;
  return expiresAt <= now;
}

export function sortManagerItems(items) {
  return [...(items || [])].sort((left, right) => {
    const leftExpired = isExpiredNotification(left);
    const rightExpired = isExpiredNotification(right);
    if (leftExpired !== rightExpired) {
      return leftExpired ? 1 : -1;
    }

    const leftEnabled = normalizeManagerNotification(left).Enabled;
    const rightEnabled = normalizeManagerNotification(right).Enabled;
    if (leftEnabled !== rightEnabled) {
      return leftEnabled ? -1 : 1;
    }

    const leftUpdated = new Date(normalizeManagerNotification(left).UpdatedAt || 0).getTime();
    const rightUpdated = new Date(normalizeManagerNotification(right).UpdatedAt || 0).getTime();
    return rightUpdated - leftUpdated;
  });
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
    ShowTicker: true,
    ShowBanner: false,
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

export function createNotificationId() {
  const cryptoApi = globalThis?.crypto;
  if (cryptoApi?.randomUUID) {
    return `sam-${cryptoApi.randomUUID()}`;
  }

  const randomValues = cryptoApi?.getRandomValues
    ? Array.from(cryptoApi.getRandomValues(new Uint32Array(4)))
    : [];
  const randomSeed = randomValues.length
    ? randomValues.map((value) => value.toString(36)).join('-')
    : Math.random().toString(36).slice(2, 12);
  return `sam-${Date.now().toString(36)}-${randomSeed}`;
}

function normalizeSheetBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return defaultValue;
  const text = String(value).trim().toLowerCase();
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on', 'checked'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off', 'unchecked'].includes(text)) return false;
  return defaultValue;
}

export function normalizeManagerNotification(item = {}) {
  const base = createEmptyNotification();
  const hasStartDate = Object.prototype.hasOwnProperty.call(item, 'StartDate');
  const hasStartTime = Object.prototype.hasOwnProperty.call(item, 'StartTime');
  const normalizedType = String(item.Type || base.Type || 'info').toLowerCase() === 'ticker'
    ? 'info'
    : String(item.Type || base.Type || 'info').toLowerCase();
  return {
    ...base,
    ...item,
    Type: normalizedType,
    Enabled: normalizeSheetBoolean(item.Enabled, false),
    ShowPopup: normalizeSheetBoolean(item.ShowPopup, false),
    ShowTicker: normalizeSheetBoolean(item.ShowTicker, false),
    ShowBanner: normalizeSheetBoolean(item.ShowBanner, false),
    Persistent: normalizeSheetBoolean(item.Persistent, false),
    StartDate: hasStartDate ? String(item.StartDate || '') : base.StartDate,
    StartTime: hasStartTime ? String(item.StartTime || '') : base.StartTime,
    EndDate: item.EndDate || '',
    EndTime: item.EndTime || '',
    UpdatedAt: item.UpdatedAt || item.CreatedAt || base.UpdatedAt,
    CreatedAt: item.CreatedAt || base.CreatedAt,
  };
}

export function ensureNotificationId(item) {
  if (item.ID) return item.ID;
  return createNotificationId();
}

export function validateNotification(item, existingItems = []) {
  const errors = [];
  const normalized = normalizeManagerNotification(item);
  const nextId = ensureNotificationId(normalized);

  if (!NOTIFICATION_TYPES.includes(normalized.Type)) {
    errors.push('Type must be info, warning, or urgent.');
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
        if (column === 'Enabled' || column === 'ShowPopup' || column === 'ShowTicker' || column === 'ShowBanner' || column === 'Persistent') {
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
    Enabled: normalizeSheetBoolean(record.Enabled, false),
    ID: record.ID || '',
    Type: record.Type || 'info',
    Title: record.Title || '',
    Message: record.Message || '',
    ShowPopup: normalizeSheetBoolean(record.ShowPopup, false),
    ShowTicker: normalizeSheetBoolean(record.ShowTicker, false),
    ShowBanner: normalizeSheetBoolean(record.ShowBanner, false),
    Persistent: normalizeSheetBoolean(record.Persistent, false),
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
