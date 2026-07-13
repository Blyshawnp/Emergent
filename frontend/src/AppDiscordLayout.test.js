import fs from 'fs';
import path from 'path';
import { nextDiscordFavoriteKeys, normalizeDiscordKeyList } from './utils/discordFavorites';
import {
  findShortcutConflict,
  getDiscordCommandSearchText,
  normalizeDiscordProductivitySettings,
  normalizeShortcut,
  shortcutFromEvent,
} from './utils/discordProductivity';
import {
  getBuiltInDiscordScreenshotSuggestions,
  resolveDiscordSuggestedScreenshots,
} from './utils/discordScreenshotSuggestions';
import { findDiscordTemplateMessage, getActiveDiscordTemplates } from './api';

test('discord post modal uses search-first two-pane template workflow', () => {
  const css = fs.readFileSync(path.join(__dirname, 'App.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');

  expect(css).toMatch(/\.discord-template-workspace\s*\{[^}]*display:\s*grid;/);
  expect(css).toMatch(/\.discord-template-workspace\s*\{[^}]*grid-template-columns:[^}]*minmax\(320px,\s*40%\)[^}]*minmax\(360px,\s*1fr\)/);
  expect(css).toMatch(/\.discord-toolbar\s*\{[^}]*display:\s*grid;/);
  expect(css).toMatch(/\.discord-search-input-wrap\s*\{[^}]*border:[^}]*rgba\(96,\s*165,\s*250/);
  expect(css).toContain('.discord-filter-status');
  expect(css).toMatch(/\.discord-template-list-item\s*\{[^}]*transition:[^}]*background-color[^}]*border-color[^}]*box-shadow/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*min-width:\s*88px;/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*background-color[^}]*box-shadow[^}]*opacity[^}]*filter/);
  expect(css).not.toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*transform/);
  expect(css).toMatch(/\.discord-modal-list\s*\{[^}]*scrollbar-gutter:\s*stable;/);
  expect(css).toContain('.discord-category-badge.badge-vpn');
  expect(css).toContain('.discord-shortcut-help');
  expect(css).toContain('.discord-command-palette');
  expect(app).toContain('DISCORD_FAVORITES_KEY');
  expect(app).toContain('DISCORD_RECENT_KEY');
  expect(app).toContain('DISCORD_CATEGORY_SHORTCUTS');
  expect(app).toContain('Discord Command Palette');
  expect(app).toContain('discord-command-palette-search');
  expect(app).toContain('No recent Discord posts yet.');
  expect(app).toContain('Search is the fastest way to find a post.');
  expect(app).toContain('Showing Recent');
  expect(app).toContain('Showing Favorites');
  expect(app).toContain('getDiscordCommandSearchText');
  expect(app).toContain('getSuggestedDiscordKeys');
  expect(app).toContain('searchRef.current?.focus()');
  expect(app).toContain("event.key === 'Enter'");
  expect(app).toContain("event.key === 'Escape'");
  expect(app).toContain('onDoubleClick');
  expect(app).toContain('✓ Copied to clipboard');
  expect(app).toContain('Discord Productivity Help');
  expect(app).toContain('No Discord posts match this search.');
  expect(app).toContain('Copy Post');
  expect(app).toContain('Screenshot {index + 1}');
  expect(app).toContain('Copy the post and screenshot separately');
});

test('discord templates use remote/default rows unless explicit settings override is enabled', () => {
  const settings = {
    discord_templates: [{ category: 'Local', title: 'Local Trigger', message: 'Local message' }],
  };
  const defaults = {
    discord_templates: [{ category: 'Remote', title: 'Remote Trigger', message: 'Remote message' }],
  };

  expect(getActiveDiscordTemplates(settings, defaults)).toEqual(defaults.discord_templates);
  expect(findDiscordTemplateMessage(settings, defaults, 'Remote Trigger')).toBe('Remote message');

  expect(getActiveDiscordTemplates({ ...settings, discord_override: true }, defaults)).toEqual(settings.discord_templates);
});

test('discord screenshot suggestions use strict title mappings', () => {
  expect(getBuiltInDiscordScreenshotSuggestions('Welcome')).toEqual(['/Discord-Instructions.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('No Candidate')).toEqual([]);
  expect(getBuiltInDiscordScreenshotSuggestions('Fail Session')).toEqual([]);
  expect(getBuiltInDiscordScreenshotSuggestions('Fail Final Attempt')).toEqual([]);
  expect(getBuiltInDiscordScreenshotSuggestions('Passed All')).toEqual(['/welcome-new-agent.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('Transfer Instructions #2')).toEqual(['/queue.png', '/transfer.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('Disposition')).toEqual(['/script-disposition.png', '/DTE-disposition.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('USB Fail')).toEqual(['/usb.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('Wrong Headset')).toEqual(['/usb.png']);
  expect(getBuiltInDiscordScreenshotSuggestions('Welcome to Stars')).toEqual([]);
  expect(resolveDiscordSuggestedScreenshots(
    { title: 'Transfer Instructions #2' },
    [{ title: 'Queue', imageUrl: '/queue.png' }, { title: 'Transfer', imageUrl: '/transfer.png' }],
  ).map((item) => item.imageUrl)).toEqual(['/queue.png', '/transfer.png']);
});

test('discord favorite key helpers toggle by stable key and remove duplicates', () => {
  expect(normalizeDiscordKeyList(['a', 'b', 'a', '', null, 'c'])).toEqual(['a', 'b', 'c']);
  expect(nextDiscordFavoriteKeys([], 'cat::vpn failed')).toEqual(['cat::vpn failed']);
  expect(nextDiscordFavoriteKeys(['cat::vpn failed'], 'cat::vpn failed')).toEqual([]);
  expect(nextDiscordFavoriteKeys(['cat::vpn failed', 'cat::vpn failed', 'cat::wrong headset'], 'cat::vpn failed')).toEqual(['cat::wrong headset']);
  expect(nextDiscordFavoriteKeys(['cat::wrong headset'], 'cat::vpn failed')).toEqual(['cat::vpn failed', 'cat::wrong headset']);
});

test('discord productivity settings normalize shortcut assignments', () => {
  expect(normalizeShortcut('control+shift+8')).toBe('Ctrl+Shift+8');
  expect(normalizeDiscordProductivitySettings({
    enable_shortcuts: false,
    enable_command_palette: false,
    favorite_shortcuts: { 'cat::wrong headset': 'ctrl+1', empty: '' },
  })).toMatchObject({
    enableShortcuts: false,
    enableCommandPalette: false,
    automaticCopy: true,
    globalShortcuts: { openCommandPalette: 'Ctrl+Shift+P' },
    categoryShortcuts: { vpn: 'Alt+3' },
    favoriteShortcuts: { 'cat::wrong headset': 'Ctrl+1' },
  });
  expect(shortcutFromEvent({ key: 'd', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe('Ctrl+Shift+D');
  expect(getDiscordCommandSearchText({ title: 'Wrong Headset', category: 'Headsets', message: '' })).toContain('head');
  expect(getDiscordCommandSearchText({ title: 'Supervisor Transfer Failed', category: 'Supervisor Transfer', message: '' })).toContain('transfer');
  expect(findShortcutConflict([
    { key: 'global:openPosts', label: 'Open Discord Posts', shortcut: 'Ctrl+D' },
    { key: 'favorite:vpn', label: 'VPN Failed', shortcut: 'Ctrl+2' },
  ], 'ctrl+2', 'global:openPosts')).toMatchObject({ label: 'VPN Failed' });
});

test('full registry of Discord shortcuts normalize, match key events, and resolve conflicts correctly', () => {
  const globalDefaults = {
    openPosts: 'Ctrl+D',
    openScreenshots: 'Ctrl+Shift+D',
    openCommandPalette: 'Ctrl+Shift+P',
    focusSearch: 'Ctrl+F',
    showFavorites: 'Ctrl+Shift+F',
    close: 'Esc',
  };
  Object.entries(globalDefaults).forEach(([key, shortcut]) => {
    expect(normalizeShortcut(shortcut)).toBe(shortcut);
  });

  const categoryDefaults = ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8'];
  categoryDefaults.forEach((shortcut) => {
    expect(normalizeShortcut(shortcut)).toBe(shortcut);
  });

  const favoriteDefaults = ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5'];
  favoriteDefaults.forEach((shortcut) => {
    expect(normalizeShortcut(shortcut)).toBe(shortcut);
  });

  expect(shortcutFromEvent({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe('Ctrl+Shift+P');
  expect(shortcutFromEvent({ key: '7', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true })).toBe('Alt+7');
  expect(shortcutFromEvent({ key: '5', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe('Ctrl+5');

  const assignments = [
    { key: 'global:openPosts', shortcut: 'Ctrl+D' },
    { key: 'category:calls', shortcut: 'Alt+1' },
    { key: 'favorite:vpnFailed', shortcut: 'Ctrl+2' },
  ];
  expect(findShortcutConflict(assignments, 'ctrl+d', 'global:openPosts')).toBeNull();
  expect(findShortcutConflict(assignments, 'ctrl+d', 'favorite:vpnFailed')).toMatchObject({ key: 'global:openPosts' });
  expect(findShortcutConflict(assignments, 'alt+1', 'global:openPosts')).toMatchObject({ key: 'category:calls' });
  expect(findShortcutConflict(assignments, 'ctrl+2', 'category:calls')).toMatchObject({ key: 'favorite:vpnFailed' });
});

test('discord productivity settings expose shortcut recorder and save field', () => {
  const settings = fs.readFileSync(path.join(__dirname, 'pages', 'SettingsPage.jsx'), 'utf8');
  expect(settings).toContain('Discord Productivity');
  expect(settings).toContain('Press new shortcut...');
  expect(settings).toContain('This shortcut is already assigned to:');
  expect(settings).toContain('Restore Default');
  expect(settings).toContain('Global Shortcuts');
  expect(settings).toContain('Category Shortcuts');
  expect(settings).toContain('Favorite Shortcuts');
  expect(settings).toContain('Action / Shortcut Editor / Restore Default');
  expect(settings).not.toContain('discord-current-shortcut');
  expect(settings).toContain('settings-discord-tab-productivity');
  expect(settings).toContain('discord_productivity');
  expect(settings).toContain('favoriteShortcuts');
  expect(settings).toContain('Suggested Screenshots');
  expect(settings).toContain('settings-discord-suggested');
});

test('discord global shortcuts open modal states instead of relying on focused modal container', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');
  expect(app).toContain('setDiscordInitialFilter(\'favorites\')');
  expect(app).toContain('setDiscordInitialShortcutKey(shortcutMatch.key)');
  expect(app).toContain("window.addEventListener('keydown', handleKeyDown)");
  expect(app).toContain("shortcutMatchesEvent(productivity.globalShortcuts.openScreenshots, event)");
});

test('discord shortcut handoff does not reference copyTemplate before initialization', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');
  const copyTemplateIndex = app.indexOf('const copyTemplate = useCallback');
  const shortcutHandoffIndex = app.indexOf('if (!initialShortcutKey || !templates.length) return;');
  expect(copyTemplateIndex).toBeGreaterThan(-1);
  expect(shortcutHandoffIndex).toBeGreaterThan(-1);
  expect(copyTemplateIndex).toBeLessThan(shortcutHandoffIndex);
});

test('MTS renderer is wrapped in recoverable error boundary', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  expect(index).toContain('<AppErrorBoundary appName="MTS">');
  expect(index).toContain('{appName} could not finish loading this section. Reload {appName} to try again.');
  expect(index).toContain('console.error("[APP] Renderer crashed:"');
});
