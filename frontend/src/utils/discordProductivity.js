export const DISCORD_PRODUCTIVITY_DEFAULTS = {
  enableShortcuts: true,
  enableCommandPalette: true,
  automaticCopy: true,
  showCopyToast: true,
  openAutomatically: false,
  globalShortcuts: {
    openPosts: 'Ctrl+D',
    openScreenshots: 'Ctrl+Shift+D',
    openCommandPalette: 'Ctrl+Shift+P',
    focusSearch: 'Ctrl+F',
    showFavorites: 'Ctrl+Shift+F',
    close: 'Esc',
  },
  categoryShortcuts: {},
  favoriteShortcuts: {},
};

export const DISCORD_CATEGORY_SHORTCUTS = [
  { key: 'calls', label: 'Calls', shortcut: 'Alt+1', match: /call/i },
  { key: 'supervisor-transfer', label: 'Supervisor Transfer', shortcut: 'Alt+2', match: /supervisor|sup transfer|sup/i },
  { key: 'vpn', label: 'VPN', shortcut: 'Alt+3', match: /vpn|proxy/i },
  { key: 'headsets', label: 'Headsets', shortcut: 'Alt+4', match: /headset|audio device|usb/i },
  { key: 'discord-audio', label: 'Discord Audio', shortcut: 'Alt+5', match: /discord.*audio|audio.*discord|mic|microphone/i },
  { key: 'screen-share', label: 'Screen Share', shortcut: 'Alt+6', match: /screen share|screenshare|share screen/i },
  { key: 'technical-issues', label: 'Technical Issues', shortcut: 'Alt+7', match: /technical|tech issue|internet|script|system/i },
  { key: 'favorites', label: 'Favorites', shortcut: 'Alt+8', match: /favorite/i },
];

export const DISCORD_GLOBAL_SHORTCUTS = [
  { key: 'openPosts', label: 'Open Discord Posts', defaultShortcut: 'Ctrl+D' },
  { key: 'openScreenshots', label: 'Open Screenshot Library', defaultShortcut: 'Ctrl+Shift+D' },
  { key: 'openCommandPalette', label: 'Open Command Palette', defaultShortcut: 'Ctrl+Shift+P' },
  { key: 'focusSearch', label: 'Focus Search', defaultShortcut: 'Ctrl+F' },
  { key: 'showFavorites', label: 'Show Favorites', defaultShortcut: 'Ctrl+Shift+F' },
  { key: 'close', label: 'Close', defaultShortcut: 'Esc' },
];

export const DISCORD_FAVORITE_SHORTCUT_DEFAULTS = [
  { key: 'wrongHeadset', label: 'Wrong Headset', defaultShortcut: 'Ctrl+1', match: /wrong headset|headset/i },
  { key: 'vpnFailed', label: 'VPN Failed', defaultShortcut: 'Ctrl+2', match: /vpn.*fail|fail.*vpn/i },
  { key: 'changeDte', label: 'Change DTE', defaultShortcut: 'Ctrl+3', match: /change dte|dte/i },
  { key: 'supervisorFailed', label: 'Supervisor Failed', defaultShortcut: 'Ctrl+4', match: /supervisor.*fail|sup.*fail|transfer.*fail/i },
  { key: 'technicalIssue', label: 'Technical Issue', defaultShortcut: 'Ctrl+5', match: /technical issue|tech issue/i },
];

export function normalizeDiscordProductivitySettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const favoriteShortcuts = source.favoriteShortcuts || source.favorite_shortcuts || {};
  return {
    ...DISCORD_PRODUCTIVITY_DEFAULTS,
    enableShortcuts: source.enableShortcuts ?? source.enable_shortcuts ?? DISCORD_PRODUCTIVITY_DEFAULTS.enableShortcuts,
    enableCommandPalette: source.enableCommandPalette ?? source.enable_command_palette ?? DISCORD_PRODUCTIVITY_DEFAULTS.enableCommandPalette,
    automaticCopy: source.automaticCopy ?? source.automatic_copy ?? DISCORD_PRODUCTIVITY_DEFAULTS.automaticCopy,
    showCopyToast: source.showCopyToast ?? source.show_copy_toast ?? DISCORD_PRODUCTIVITY_DEFAULTS.showCopyToast,
    openAutomatically: source.openAutomatically ?? source.open_automatically ?? DISCORD_PRODUCTIVITY_DEFAULTS.openAutomatically,
    globalShortcuts: normalizeShortcutMap({
      ...DISCORD_PRODUCTIVITY_DEFAULTS.globalShortcuts,
      ...(source.globalShortcuts || source.global_shortcuts || {}),
    }),
    categoryShortcuts: normalizeShortcutMap({
      ...Object.fromEntries(DISCORD_CATEGORY_SHORTCUTS.map((item) => [item.key, item.shortcut])),
      ...(source.categoryShortcuts || source.category_shortcuts || {}),
    }),
    favoriteShortcuts: Object.fromEntries(
      Object.entries(favoriteShortcuts).map(([key, shortcut]) => [String(key), normalizeShortcut(shortcut)]).filter(([, shortcut]) => shortcut)
    ),
  };
}

export function normalizeShortcutMap(map) {
  return Object.fromEntries(
    Object.entries(map || {})
      .map(([key, shortcut]) => [String(key), normalizeShortcut(shortcut)])
      .filter(([, shortcut]) => shortcut)
  );
}

export function normalizeShortcut(shortcut) {
  return String(shortcut || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'control') return 'Ctrl';
      if (lower === 'cmd' || lower === 'command' || lower === 'meta') return 'Meta';
      if (lower === 'ctrl') return 'Ctrl';
      if (lower === 'shift') return 'Shift';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'escape') return 'Esc';
      if (part.length === 1) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}

export function shortcutFromEvent(event) {
  const key = event?.key === ' ' ? 'Space' : String(event?.key || '');
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(key.length === 1 ? key.toUpperCase() : key === 'Escape' ? 'Esc' : key);
  return normalizeShortcut(parts.join('+'));
}

export function shortcutMatchesEvent(shortcut, event) {
  const expected = normalizeShortcut(shortcut);
  return Boolean(expected && shortcutFromEvent(event) === expected);
}

export function discordProductivityKey(item) {
  return `${String(item?.category || '').trim()} ${String(item?.title || '').trim()}`.toLowerCase();
}

export function getDiscordCategoryMeta(category, title = '') {
  const haystack = discordProductivityKey({ category, title });
  return DISCORD_CATEGORY_SHORTCUTS.find((item) => item.key !== 'favorites' && item.match.test(haystack)) || {
    key: 'general',
    label: String(category || 'Uncategorized'),
    shortcut: '',
  };
}

export function getDefaultFavoriteShortcut(template) {
  const haystack = discordProductivityKey(template);
  const match = DISCORD_FAVORITE_SHORTCUT_DEFAULTS.find((item) => item.match.test(haystack));
  return match?.defaultShortcut || '';
}

export function getDiscordSearchAliases(template) {
  const meta = getDiscordCategoryMeta(template?.category, template?.title);
  const aliases = [meta.label, meta.key.replace(/-/g, ' ')];
  const title = String(template?.title || '').toLowerCase();
  if (/headset/.test(title)) aliases.push('head', 'headset', 'wrong headset');
  if (/supervisor|sup|transfer/.test(title)) aliases.push('transfer', 'supervisor transfer', 'sup transfer');
  if (/vpn|proxy/.test(title)) aliases.push('vpn', 'manual verification');
  if (/audio|mic|microphone|discord/.test(title)) aliases.push('audio', 'discord audio');
  if (/screen|share/.test(title)) aliases.push('screen share', 'screenshare');
  if (/technical|tech|internet|script/.test(title)) aliases.push('tech', 'technical issue');
  return Array.from(new Set(aliases.filter(Boolean))).join(' ');
}

export function getDiscordCommandSearchText(template) {
  return [
    template?.title,
    template?.category,
    template?.message,
    getDiscordSearchAliases(template),
  ].join(' ').toLowerCase();
}

export function findShortcutConflict(assignments, shortcut, ownerKey) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  return (assignments || []).find((item) => item.key !== ownerKey && normalizeShortcut(item.shortcut) === normalized) || null;
}
