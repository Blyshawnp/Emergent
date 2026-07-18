import { normalizeDiscordMessageWhitespace } from './discordContent';

test('normalizes newline styles and collapses repeated blank lines without joining content', () => {
  const input = 'Heading\r\n\r\n\r\n- **First**\r\n\r\n\r\nhttps://example.test/path\r\n';
  expect(normalizeDiscordMessageWhitespace(input)).toBe(
    'Heading\n\n- **First**\n\nhttps://example.test/path'
  );
});

test('preserves a single intentional blank line and markdown-leading whitespace', () => {
  expect(normalizeDiscordMessageWhitespace('Line one\n\n  - nested bullet\nLine two')).toBe(
    'Line one\n\n  - nested bullet\nLine two'
  );
});
