import displayLabels from './summaryDisplayLabels.json';

function normalizeLabelKey(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/[/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const normalizedDisplayLabels = Object.entries(displayLabels).reduce((acc, [key, label]) => {
  acc[normalizeLabelKey(key)] = label;
  return acc;
}, {});

export function displaySummaryLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const exact = displayLabels[raw];
  if (exact) return exact;
  const normalized = normalizeLabelKey(raw);
  if (normalizedDisplayLabels[normalized]) return normalizedDisplayLabels[normalized];
  const text = raw
    .replace(/_/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
  const preserved = new Set(['ACD', 'DTE', 'VPN', 'USB', 'NC/NS', 'EFT']);
  const sentence = text
    .split(' ')
    .map((part) => {
      const upper = part.toUpperCase();
      if (preserved.has(upper)) return upper;
      if (part === '/') return '/';
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(' ');
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

export function splitSummaryParentChild(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.includes('_')) return { parent: raw, child: '' };
  const [parent, ...rest] = raw.split('_');
  return { parent, child: rest.join('_') };
}
