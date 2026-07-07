export function normalizeDiscordKeyList(keys) {
  const seen = new Set();
  return (Array.isArray(keys) ? keys : [])
    .filter(Boolean)
    .map(String)
    .filter((key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function nextDiscordFavoriteKeys(current, templateKey) {
  const key = String(templateKey || '');
  if (!key) return normalizeDiscordKeyList(current);
  const normalized = normalizeDiscordKeyList(current);
  return normalized.includes(key)
    ? normalized.filter((item) => item !== key)
    : [key, ...normalized].slice(0, 12);
}
