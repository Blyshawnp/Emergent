export function mergeAndOrderFailReasons(items = [], requiredItems = []) {
  const merged = [];
  const seen = new Set();
  let hasOther = false;

  const sourceItems = Array.isArray(items) ? items : [];
  sourceItems.forEach((item) => {
    const label = String(item || '').trim();
    if (!label) return;
    const lower = label.toLowerCase();
    if (lower === 'other') {
      hasOther = true;
      return;
    }
    if (seen.has(lower)) return;
    seen.add(lower);
    merged.push(label);
  });

  const reqItems = Array.isArray(requiredItems) ? requiredItems : [];
  reqItems.forEach((item) => {
    const label = String(item || '').trim();
    if (!label) return;
    const lower = label.toLowerCase();
    if (lower === 'other') {
      hasOther = true;
      return;
    }
    if (seen.has(lower)) return;
    seen.add(lower);
    merged.push(label);
  });

  if (hasOther) {
    merged.push('Other');
  }

  return merged;
}
