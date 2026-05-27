function firstPresent(record, paths) {
  for (const path of paths) {
    const parts = String(path).split('.');
    let value = record;
    for (const part of parts) {
      if (value === null || value === undefined) break;
      value = value[part];
    }
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on', 'checked'].includes(text)) return true;
  if (['false', 'no', 'n', '0', 'off', 'unchecked'].includes(text)) return false;
  return null;
}

function cleanText(value) {
  return String(value || '').trim();
}

function isMissingText(value) {
  const text = cleanText(value).toLowerCase();
  return !text || ['n/a', 'na', 'none', 'unknown'].includes(text);
}

export function candidateNameOf(record) {
  return cleanText(firstPresent(record, ['candidate_name', 'candidate', 'candidateName', 'basics.candidate_name']));
}

export function sessionDateOf(record) {
  return cleanText(firstPresent(record, ['completed_at', 'created_at', 'displayDate', 'timestamp_iso', 'timestamp', 'last_session_date']));
}

export function sessionIdOf(record) {
  return cleanText(firstPresent(record, ['session_id', 'history_id', 'latest_session_id', 'original_session_id']));
}

export function buildBasicsFromRecord(record) {
  const basics = {
    candidate_name: candidateNameOf(record),
    final_attempt: normalizeBool(firstPresent(record, ['final_attempt', 'basics.final_attempt'])),
    headset_usb: normalizeBool(firstPresent(record, ['headset_usb', 'usb_headset', 'is_usb_headset', 'basics.headset_usb', 'basics.usb_headset'])),
    noise_cancel: normalizeBool(firstPresent(record, ['noise_cancel', 'noise_cancelling_mic', 'noise_canceling_mic', 'has_noise_cancel', 'basics.noise_cancel', 'basics.noise_cancelling_mic'])),
    headset_brand: cleanText(firstPresent(record, ['headset_brand', 'headset_model', 'headset', 'brand_model', 'headsetBrand', 'basics.headset_brand', 'basics.headset_model'])),
    vpn_on: normalizeBool(firstPresent(record, ['vpn_on', 'has_vpn', 'vpn', 'basics.vpn_on', 'basics.has_vpn'])),
    vpn_off: normalizeBool(firstPresent(record, ['vpn_off', 'vpn_can_turn_off', 'can_turn_off_vpn', 'basics.vpn_off', 'basics.vpn_can_turn_off'])),
    chrome_default: normalizeBool(firstPresent(record, ['chrome_default', 'default_browser', 'browser_default', 'basics.chrome_default', 'basics.default_browser'])),
    extensions_disabled: normalizeBool(firstPresent(record, ['extensions_disabled', 'extensions_off', 'browser_extensions_disabled', 'basics.extensions_disabled', 'basics.extensions_off'])),
    popups_allowed: normalizeBool(firstPresent(record, ['popups_allowed', 'pop_ups_allowed', 'popups', 'basics.popups_allowed'])),
    skills: firstPresent(record, ['skills', 'basics.skills']) || [],
  };
  const hasHeadset = !isMissingText(basics.headset_brand);
  const boolCount = ['headset_usb', 'noise_cancel', 'vpn_on', 'vpn_off', 'chrome_default', 'extensions_disabled', 'popups_allowed']
    .filter((key) => basics[key] !== null).length;
  return {
    ...basics,
    usable: Boolean(hasHeadset || boolCount >= 2),
    complete: Boolean(hasHeadset && basics.headset_usb !== null && basics.noise_cancel !== null),
    source: cleanText(record?._basics_source) || cleanText(record?.session_id || record?.history_id) || 'record',
  };
}

export function sameCandidate(record, candidateName) {
  return candidateNameOf(record).toLowerCase() === cleanText(candidateName).toLowerCase();
}

export function findBestBasicsRecord(records, candidateName, preferredRecord = null) {
  const candidates = [
    preferredRecord,
    ...(records || []),
  ].filter(Boolean)
    .filter((record) => sameCandidate(record, candidateName))
    .map((record) => ({ record, basics: buildBasicsFromRecord(record) }))
    .filter((item) => item.basics.usable)
    .sort((left, right) => {
      const leftPreferred = left.record === preferredRecord ? 1 : 0;
      const rightPreferred = right.record === preferredRecord ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      return sessionDateOf(right.record).localeCompare(sessionDateOf(left.record));
    });
  return candidates[0] || null;
}

export function mergeBasicsIntoSession(session, basics) {
  if (!basics) return session;
  const next = { ...session };
  if (basics.candidate_name && !next.candidate_name) next.candidate_name = basics.candidate_name;
  if (basics.final_attempt !== null) next.final_attempt = basics.final_attempt;
  if (basics.headset_usb !== null) next.headset_usb = basics.headset_usb;
  if (basics.noise_cancel !== null) next.noise_cancel = basics.noise_cancel;
  if (!isMissingText(basics.headset_brand)) next.headset_brand = basics.headset_brand;
  if (basics.vpn_on !== null) next.vpn_on = basics.vpn_on;
  if (basics.vpn_off !== null) next.vpn_off = basics.vpn_off;
  if (basics.chrome_default !== null) next.chrome_default = basics.chrome_default;
  if (basics.extensions_disabled !== null) next.extensions_disabled = basics.extensions_disabled;
  if (basics.popups_allowed !== null) next.popups_allowed = basics.popups_allowed;
  if (basics.skills && basics.skills.length) next.skills = basics.skills;
  return next;
}
