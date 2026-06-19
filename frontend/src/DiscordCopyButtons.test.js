import fs from 'fs';
import path from 'path';

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

test('fail and warning Discord copy actions use descriptive purple Discord post buttons', () => {
  const basics = read('pages/BasicsPage.jsx');
  const newbie = read('pages/NewbieShiftPage.jsx');
  const supTransfer = read('pages/SupTransferPage.jsx');
  const css = read('App.css');

  expect(basics).toContain("buttonLabel: 'Discord Post: VPN Fail'");
  expect(basics).toContain("buttonLabel: 'Discord Post: Headset Fail'");
  expect(basics).toContain("cls: 'discord-copy discord-post-copy-btn'");
  expect(basics).not.toContain('<b>${helperText}</b>');

  expect(newbie).toContain('Discord Post: Out of Time (Needs Sup)');
  expect(newbie).toContain('discord-copy discord-post-copy-btn');
  expect(newbie).not.toContain('Copy Out of Time (Needs Sup) Discord post</span>');

  expect(supTransfer).toContain('Discord Post: Failed 1st Sup Transfer');
  expect(supTransfer).toContain('discord-copy discord-post-copy-btn');
  expect(supTransfer).not.toContain('Copy Failed 1st Sup Transfer Discord post</span>');

  expect(css).toMatch(/\.discord-post-copy-btn\s*\{[^}]*#5865f2/);
});
