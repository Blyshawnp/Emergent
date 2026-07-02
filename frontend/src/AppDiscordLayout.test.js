import fs from 'fs';
import path from 'path';

test('discord post template rows use non-overlapping grid layout with wrapping', () => {
  const css = fs.readFileSync(path.join(__dirname, 'App.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');

  expect(css).toMatch(/\.discord-template-row\s*\{[^}]*display:\s*grid;/);
  expect(css).toMatch(/\.discord-template-row\s*\{[^}]*grid-template-columns:[^}]*minmax\(130px,\s*180px\)[^}]*minmax\(0,\s*1fr\)[^}]*auto;/);
  expect(css).toMatch(/\.discord-template-meta\s*\{[^}]*flex-direction:\s*column;/);
  expect(css).toMatch(/\.discord-template-meta,\s*\.discord-template-title,\s*\.discord-msg\s*\{[^}]*min-width:\s*0;/);
  expect(css).toMatch(/\.discord-template-title\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  expect(css).toMatch(/\.discord-msg\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  expect(css).toMatch(/\.discord-template-row\s+\.discord-copy\s*\{[^}]*justify-self:\s*end;/);
  expect(css).toMatch(/\.discord-row\s*\{[^}]*contain:\s*layout paint;/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*min-width:\s*88px;/);
  expect(css).toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*background-color[^}]*box-shadow[^}]*opacity[^}]*filter/);
  expect(css).not.toMatch(/\.discord-copy\s*\{[^}]*transition:[^}]*transform/);
  expect(css).toMatch(/\.discord-modal-list\s*\{[^}]*scrollbar-gutter:\s*stable;/);
  expect(app).toMatch(/<div className="discord-template-meta">[\s\S]*discord-category-badge[\s\S]*discord-template-title[\s\S]*<\/div>\s*<div className="discord-msg">/);
});
