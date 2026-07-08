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

test('discord productivity settings expose shortcut recorder and save field', () => {
  const settings = fs.readFileSync(path.join(__dirname, 'pages', 'SettingsPage.jsx'), 'utf8');
  expect(settings).toContain('Discord Productivity');
  expect(settings).toContain('Press new shortcut...');
  expect(settings).toContain('This shortcut is already assigned to:');
  expect(settings).toContain('Restore Default');
  expect(settings).toContain('Global Shortcuts');
  expect(settings).toContain('Category Shortcuts');
  expect(settings).toContain('Favorite Shortcuts');
  expect(settings).toContain('settings-discord-tab-productivity');
  expect(settings).toContain('discord_productivity');
  expect(settings).toContain('favoriteShortcuts');
  expect(settings).toContain('Suggested Screenshots');
  expect(settings).toContain('settings-discord-suggested');
});
