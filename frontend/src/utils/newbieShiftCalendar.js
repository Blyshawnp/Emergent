import { parseScheduledDateTime } from './certificationWorkflow';

export const NEWBIE_SHIFT_DURATION_MINUTES = 30;

const ZONES = [
  { zone: 'America/New_York', label: 'EST (Eastern)', match: /eastern|est|edt|new_york/i },
  { zone: 'America/Chicago', label: 'CST (Central)', match: /central|cst|cdt|chicago/i },
  { zone: 'America/Denver', label: 'MST (Mountain)', match: /mountain|mst|mdt|denver/i },
  { zone: 'America/Los_Angeles', label: 'PST (Pacific)', match: /pacific|pst|pdt|los_angeles/i },
];

// Both persistence and Calendar consume this appointment, never browser-local dates.
export function buildNewbieShiftAppointment(date, time, timezone = 'EST (Eastern)', durationMinutes = NEWBIE_SHIFT_DURATION_MINUTES) {
  const zone = ZONES.find((entry) => entry.match.test(timezone));
  if (!zone || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const scheduledAt = parseScheduledDateTime(date, time, zone.label);
  if (!scheduledAt) return null;
  const start = new Date(scheduledAt);
  if (!Number.isFinite(start.getTime())) return null;

  // Reject impossible dates and spring-forward times instead of silently moving the appointment.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone.zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(start).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const wallTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
  if (wallTime !== scheduledAt.slice(0, 19)) return null;
  return {
    scheduledAt,
    timeZone: zone.zone,
    startUtc: start.toISOString(),
    endUtc: new Date(start.getTime() + durationMinutes * 60000).toISOString(),
  };
}

export function buildNewbieShiftCalendarUrl(appointment, title, details) {
  if (!appointment) return null;
  const calendarTime = (iso) => iso.replace(/[-:]/g, '').replace('.000', '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${calendarTime(appointment.startUtc)}/${calendarTime(appointment.endUtc)}`,
    ctz: appointment.timeZone,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
