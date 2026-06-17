import fs from 'fs';
import path from 'path';

test('discord post template rows use non-overlapping grid layout with wrapping', () => {
  const css = fs.readFileSync(path.join(__dirname, 'App.css'), 'utf8');

  expect(css).toMatch(/\.discord-template-row\s*\{[^}]*display:\s*grid;/);
  expect(css).toMatch(/\.discord-template-row\s*\{[^}]*grid-template-columns:[^}]*minmax\(0,\s*1fr\)[^}]*auto;/);
  expect(css).toMatch(/\.discord-category-cell,\s*\.discord-template-title,\s*\.discord-msg\s*\{[^}]*min-width:\s*0;/);
  expect(css).toMatch(/\.discord-template-title\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  expect(css).toMatch(/\.discord-msg\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  expect(css).toMatch(/\.discord-template-row\s+\.discord-copy\s*\{[^}]*justify-self:\s*end;/);
});
