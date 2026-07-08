const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, 'NotificationManagerApp.jsx'), 'utf8');
const appCss = fs.readFileSync(path.join(__dirname, 'notification-manager.css'), 'utf8');
const samPolishCss = fs.readFileSync(path.join(__dirname, 'polish-sam.css'), 'utf8');
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

test('SAM candidate tracking exposes accessible sortable headers and sort menu', () => {
  expect(appSource).toContain('CANDIDATE_SORT_OPTIONS');
  expect(appSource).toContain('aria-sort={ariaSort}');
  expect(appSource).toContain("renderSortableHeader('candidate', 'Candidate')");
  expect(appSource).toContain("renderSortableHeader('attempts', 'Attempts')");
  expect(appSource).toContain("renderSortableHeader('date', 'Date')");
  expect(appSource).toContain('Date newest first');
  expect(appSource).toContain('Attempts high to low');
  expect(samPolishCss).toContain('.nm-sort-header');
});

test('SAM status modals keep close control and actions centered', () => {
  expect(appCss).toContain('.nm-status-modal > .nm-help-header');
  expect(appCss).toContain('.nm-status-modal > .nm-help-actions');
  expect(appCss).toContain('.nm-modal-close::after');
  expect(appCss).toContain('font-size: 0');
  expect(appCss).toContain('box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.24)');
});

test('SAM settings and help include real controls and streamlined sections', () => {
  expect(appSource).toContain('SAM_SETTINGS_KEY');
  expect(appSource).toContain('SAM sounds');
  expect(appSource).toContain('Success banner duration');
  expect(appSource).toContain('Default candidate filter');
  expect(appSource).toContain('SAM_HELP_SECTIONS');
  expect(appSource).toContain('Check for Updates');
});

test('SAM success and error sound assets are used through the shared sound utility', () => {
  expect(soundSource).toContain("samSuccess: 'success-sam.mp3'");
  expect(soundSource).toContain("samError: 'error-sam.mp3'");
  expect(appSource).toContain("playSound(kind === 'error' ? 'samError' : 'samSuccess')");
});

test('SAM headset startup notice is a non-modal status update', () => {
  expect(appSource).toContain('Headset review queue updated.');
  expect(appSource).toContain('showPendingNotice: true');
  expect(appSource).not.toContain('New headsets are ready to review.');
  expect(appSource).not.toContain('setHeadsetReviewNoticeOpen');
});

test('Electron main locks one instance per app mode while preserving app identities', () => {
  expect(electronMain).toContain('app.requestSingleInstanceLock');
  expect(electronMain).toContain('Mock Testing Suite is already open.');
  expect(electronMain).toContain('Smart Alert Manager is already open.');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite.notificationmanager');
  expect(electronMain).toContain('com.acddirect.mocktestingsuite');
  expect(electronMain).toContain('focusExistingWindow');
  expect((electronMain.match(/function ensureBackendAvailable\s*\(/g) || [])).toHaveLength(1);
});
