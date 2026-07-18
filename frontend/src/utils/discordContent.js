export function normalizeDiscordMessageWhitespace(value) {
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));

  const normalized = [];
  let previousWasBlank = false;
  lines.forEach((line) => {
    const isBlank = line.trim() === '';
    if (isBlank) {
      if (normalized.length > 0 && !previousWasBlank) normalized.push('');
    } else {
      normalized.push(line);
    }
    previousWasBlank = isBlank;
  });

  while (normalized.length && normalized[normalized.length - 1] === '') normalized.pop();
  return normalized.join('\n');
}
