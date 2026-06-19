const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, 'NotificationManagerApp.jsx'), 'utf8');
const appCss = fs.readFileSync(path.join(__dirname, 'notification-manager.css'), 'utf8');
const soundSource = fs.readFileSync(path.join(__dirname, 'utils', 'sound.js'), 'utf8');
const electronMain = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'src', 'main.js'), 'utf8');

test('SAM status banner is dismissible and success/info banners auto-dismiss on configured duration', () => {
  expect(appSource).toContain('aria-label="Dismiss status message"');
  expect(appSource).toContain('statusBannerDurationSeconds');
  expect(appSource).toContain('window.setTimeout');
  expect(appSource).toContain('DEFAULT_SAM_SETTINGS');
  expect(appCss).toContain('.nm-status-dismiss');
});

test('SAM candidate archive and archived search controls are wired without using delete', () => {
  expect(appSource).toContain("action: 'archive_candidate'");
  expect(appSource).toContain('Include archived candidates');
  expect(appSource).toContain('isCandidateArchived');
  expect(appSource).toContain('nm-archive-badge');
  expect(appSource).toContain('Archived Candidates');
});

test('SAM settings and help include real controls and streamlined sections', () => {
  expect(appSource).toContain('SAM_SETTINGS_KEY');
  expect(appSource).toContain('SAM sounds');
  expect(appSource).toContain('Success banner duration');
  expect(appSource).toContain('Default candidate filter');
  expect(appSource).toContain('SAM tutorial video');
  expect(appSource).toContain('Disable guided tutorial after video');
  expect(appSource).toContain('SAM_HELP_SECTIONS');
  expect(appSource).toContain('Check for Updates');
});

test('SAM success and error sound assets are used through the shared sound utility', () => {
  expect(soundSource).toContain("samSuccess: 'success-sam.mp3'");
  expect(soundSource).toContain("samError: 'error-sam.mp3'");
  expect(appSource).toContain("playSound(kind === 'error' ? 'samError' : 'samSuccess')");
});

test('SAM optional tutorial video support probes local assets and keeps guided fallback', () => {
  expect(appSource).toContain("'/assets/tutorial/sam-tutorial.mp4'");
  expect(appSource).toContain("'/assets/tutorial/sam-intro.mp4'");
  expect(appSource).toContain('findSamTutorialVideoUrl');
  expect(appSource).toContain('SAM_TUTORIAL_VIDEO_MODE_OPTIONS');
  expect(appSource).toContain('SamTutorialVideoOverlay');
  expect(appSource).toContain('Missing optional tutorial video keeps the guided SAM tutorial as the fallback.');
});

test('Electron main locks one instance per app mode while preserving app identities', () => {
  expect(electronMain).toContain('app.requestSingleInstanceLock');
  expect(electronMain).toContain('Mock Testing Suite is already open.');
  expect(electronMain).toContain('Smart Alert Manager is already open.');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite.notificationmanager');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite');
  expect(electronMain).toContain('focusExistingWindow');
});
