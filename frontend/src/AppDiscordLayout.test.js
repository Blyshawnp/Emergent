import fs from 'fs';
import path from 'path';

test('discord post modal uses search-first two-pane template workflow', () => {
  const css = fs.readFileSync(path.join(__dirname, 'App.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');

  expect(css).toMatch(/\.discord-template-workspace\s*\{[^}]*display:\s*grid;/);
  expect(css).toMatch(/\.discord-template-workspace\s*\{[^}]*grid-template-columns:[^}]*minmax\(280px,\s*42%\)[^}]*minmax\(320px,\s*1fr\)/);
  expect(css).toMatch(/\.discord-template-list-item\s*\{[^}]*transition:[^}]*background-color[^}]*border-color[^}]*box-shadow/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*min-width:\s*88px;/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*background-color[^}]*box-shadow[^}]*opacity[^}]*filter/);
  expect(css).not.toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*transform/);
  expect(css).toMatch(/\.discord-modal-list\s*\{[^}]*scrollbar-gutter:\s*stable;/);
  expect(app).toContain('DISCORD_FAVORITES_KEY');
  expect(app).toContain('DISCORD_RECENT_KEY');
  expect(app).toContain('getSuggestedDiscordKeys');
  expect(app).toContain('searchRef.current?.focus()');
  expect(app).toContain("event.key === 'Enter'");
  expect(app).toContain("event.key === 'Escape'");
  expect(app).toContain('No Discord posts match this search.');
});
