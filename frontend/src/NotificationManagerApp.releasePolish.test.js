const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, 'NotificationManagerApp.jsx'), 'utf8');
const mtsAppSource = fs.readFileSync(path.join(__dirname, 'App.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
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

test('SAM candidate tracking sanitizes quota errors and throttles duplicate refreshes', () => {
  expect(appSource).toContain('SAM_CANDIDATE_TRACKING_TEMPORARY_MESSAGE');
  expect(appSource).toContain('Google Sheets is currently receiving too many requests or could not be reached.');
  expect(appSource).toContain('candidateTrackingRequestRef');
  expect(appSource).toContain('candidateTrackingBackoffUntilRef');
  expect(appSource).toContain('SAM_CANDIDATE_TRACKING_BACKOFF_MS');
  expect(appSource).toContain('SAM_CANDIDATE_TRACKING_STARTUP_RETRY_DELAY_MS');
  expect(appSource).toContain('SAM_CANDIDATE_TRACKING_STARTUP_RETRY_LIMIT');
  expect(appSource).toContain('startup: true');
  expect(appSource).toContain('window.setTimeout(resolve, SAM_CANDIDATE_TRACKING_STARTUP_RETRY_DELAY_MS)');
  expect(appSource).toContain('candidateTrackingCacheRef');
  expect(appSource).not.toContain('const requiredSetup = Object.entries(setup)');
  expect(appSource).not.toContain('<pre>{requiredSetup}</pre>');
  expect(appSource).not.toContain('HTTP 429\\nRATE_LIMIT_EXCEEDED');
  expect(appSource).not.toContain('[object Object]');
});

test('SAM pending request inbox, bell, and denial safeguards are wired', () => {
  expect(appSource).toContain('SAM_PENDING_REQUESTS_BACKOFF_MS');
  expect(appSource).toContain('pendingRequestsRequestRef');
  expect(appSource).toContain('getSharedAdminPendingRequests');
  expect(appSource).toContain('updateSharedAdminPendingRequest');
  expect(appSource).toContain('Pending Requests');
  expect(appSource).toContain('aria-label={`Pending request summary: ${unresolvedRequestCount} unresolved actionable requests`}');
  expect(appSource).toContain('Newbie Shift Requests');
  expect(appSource).toContain('Reschedule Requests');
  expect(appSource).toContain('Candidate Deletion Requests');
  expect(appSource).toContain('Headset Reviews');
  expect(appSource).toContain('A denial reason is required.');
  expect(appSource).toContain('Remind Me in 30 Minutes');
  expect(appSource).toContain('There is a Newbie Shift request to reschedule awaiting approval.');
  expect(appSource).toContain('Single session request');
  expect(samPolishCss).toContain('.nm-request-bell-badge');
  expect(samPolishCss).toContain('.nm-request-status.is-approved');
  expect(samPolishCss).toContain('.nm-request-status.is-denied');
});

test('SAM operations layout uses pending requests instead of duplicate candidate tracking metric card', () => {
  expect(appSource).toContain('<div className="nm-metric-label">Pending Requests</div>');
  expect(appSource).not.toContain('<div className="nm-metric-label">Candidate Tracking</div>');
  expect(appSource).toContain('<Plus size={16} aria-hidden="true" /> Add Notification');
});

test('SAM candidate actions use compact row menus with View Details first', () => {
  const actionsStart = appSource.indexOf('const renderCandidateActions = (row, rowKey)');
  const actionsBlock = appSource.slice(actionsStart, appSource.indexOf('const renderCandidateDetails', actionsStart));
  expect(actionsBlock.indexOf('View Details')).toBeGreaterThan(-1);
  expect(actionsBlock.indexOf('View Details')).toBeLessThan(actionsBlock.indexOf('Update Status'));
  expect(actionsBlock).toContain('More Actions');
  expect(actionsBlock).toContain('role="menu"');
  expect(actionsBlock).toContain("role=\"menuitem\"");
  expect(samPolishCss).toContain('.nm-action-menu');
  expect(samPolishCss).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(samPolishCss).toContain('.nm-candidate-table .nm-row-actions .nm-view-details-btn');
});

test('SAM notification IDs are generated once for new and duplicated drafts', () => {
  expect(appSource).toContain('createNotificationId');
  const addStart = appSource.indexOf('const handleAdd = () =>');
  const addBlock = appSource.slice(addStart, appSource.indexOf('const handleDuplicate', addStart));
  expect(addBlock).toContain('ID: createNotificationId()');

  const duplicateStart = appSource.indexOf('const handleDuplicate = (index = selectedIndex)');
  const duplicateBlock = appSource.slice(duplicateStart, appSource.indexOf('const handleDeleteIndex', duplicateStart));
  expect(duplicateBlock).toContain('ID: createNotificationId()');
  expect(duplicateBlock).not.toContain("ID: ''");
  expect(appSource).toContain('if (sheetState.isSaving) return;');
  expect(appSource).not.toContain('<label htmlFor="nm-id">Notification ID</label>');
  expect(appSource).not.toContain('Current ID');
  expect(appSource).not.toContain('Sheet ID');
});

test('SAM notification header has one help control and one destructive exit control', () => {
  expect(appSource).toContain('className="nm-btn nm-ops-exit"');
  expect(samPolishCss).toContain('.nm-ops-exit');
  expect(samPolishCss).toContain('background: #7f1d1d');
  expect((appSource.match(/aria-label="Help and settings"/g) || [])).toHaveLength(1);
  expect((appSource.match(/aria-label="Exit Smart Alert Manager"/g) || [])).toHaveLength(1);
  expect(appSource).not.toContain('<span className="nm-ops-quick-label">Selection</span>');
});

test('SAM notification rows keep edit and duplicate actions at row level', () => {
  const notificationsStart = appSource.indexOf('id="sam-notifications"');
  const cardActionsStart = appSource.indexOf('<div className="nm-note-card-actions">', notificationsStart);
  const cardActionsBlock = appSource.slice(cardActionsStart, appSource.indexOf('</div>', cardActionsStart));
  expect(cardActionsBlock).toContain('openEditor(index)');
  expect(cardActionsBlock).toContain('handleDuplicate(index)');
  expect(cardActionsBlock).toContain('handleToggleEnabled(index)');
  expect(cardActionsBlock).toContain('handleDeleteIndex(index)');
});

test('SAM operations cards and tabs have compact identity states', () => {
  expect(appSource).toContain('Sync Status');
  expect(appSource).toContain('Add Notification</div>');
  expect(appSource).toContain('Pending Requests</div>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">Data</span>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">Workflow</span>');
  expect(appSource).toContain('<span className="nm-ops-quick-label">System</span>');
  expect(appSource).toContain('<Plus size={15} aria-hidden="true" /> Add Notification');
  expect(appSource).toContain('<Inbox size={15} aria-hidden="true" /> Pending Requests');
  expect(samPolishCss).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  expect(samPolishCss).toContain('width: 246px');
  expect(appSource).toContain("tone: 'notifications'");
  expect(appSource).toContain("tone: 'pending'");
  expect(appSource).toContain("is-${item.tone || 'default'}");
  expect(samPolishCss).toContain('.nm-ops-tab.is-notifications');
  expect(samPolishCss).toContain('.nm-ops-tab.is-preview');
  expect(samPolishCss).toContain('.nm-ops-tab.is-headsets');
  expect(samPolishCss).toContain('.nm-ops-tab.is-candidates');
  expect(samPolishCss).toContain('.nm-ops-tab.is-pending');
});

test('SAM candidate table truncates long text accessibly', () => {
  expect(appSource).toContain('title={row.candidate_name ||');
  expect(appSource).toContain('title={results}');
  expect(appSource).toContain('title={notes}');
  expect(appSource).toContain('tabIndex={0}');
  expect(samPolishCss).toContain('-webkit-line-clamp: 2');
  expect(samPolishCss).toContain('overflow: visible;');
});

test('SAM candidate row preview expansion is distinct from View Details', () => {
  expect(appSource).toContain('expandedRowPreviews');
  expect(appSource).toContain('toggleRowPreview');
  expect(appSource).toContain('Show More');
  expect(appSource).toContain('Show Less');
  expect(appSource).toContain('is-preview-expanded');
  expect(appSource).toContain('nm-results-preview');
  expect(appSource).toContain('nm-row-preview-toggle');

  const previewToggleStart = appSource.indexOf('className="nm-row-preview-toggle"');
  const previewToggleBlock = appSource.slice(previewToggleStart, appSource.indexOf('</button>', previewToggleStart));
  expect(previewToggleBlock).toContain('toggleRowPreview(rowKey)');
  expect(previewToggleBlock).not.toContain('setDetailKey');

  const viewDetailsStart = appSource.indexOf('nm-view-details-btn');
  const viewDetailsBlock = appSource.slice(viewDetailsStart, appSource.indexOf('</button>', viewDetailsStart));
  expect(viewDetailsBlock).toContain('setDetailKey(rowKey)');
  expect(viewDetailsBlock).not.toContain('toggleRowPreview');

  expect(samPolishCss).toContain('.nm-candidate-table tr.is-preview-expanded .nm-results-preview');
  expect(samPolishCss).toContain('.nm-row-preview-toggle');
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

test('SAM auto-refresh effect is declared after its callback dependencies initialize', () => {
  const loadSheetDeclaration = appSource.indexOf('const loadSheetItems = useCallback');
  const loadCandidateDeclaration = appSource.indexOf('const loadCandidateTracking = useCallback');
  const autoRefreshEffect = appSource.indexOf('}, SAM_AUTO_REFRESH_INTERVAL_MS);');

  expect(loadSheetDeclaration).toBeGreaterThan(-1);
  expect(loadCandidateDeclaration).toBeGreaterThan(-1);
  expect(autoRefreshEffect).toBeGreaterThan(loadSheetDeclaration);
  expect(autoRefreshEffect).toBeGreaterThan(loadCandidateDeclaration);
});

test('exit confirmation actions render safe action before exit action', () => {
  const samExitStart = appSource.indexOf('<h2 className="sam-exit-title">Exit Smart Alert Manager</h2>');
  const samExitBlock = appSource.slice(samExitStart, appSource.indexOf('</section>', samExitStart));
  expect(samExitBlock.indexOf('Cancel')).toBeLessThan(samExitBlock.indexOf('Exit App'));
  expect(appSource).toContain("if (event.key === 'Escape')");
  expect(appSource).toContain('resolveExitConfirm(false)');

  const mtsExitStart = mtsAppSource.indexOf("title: 'Exit App'");
  const mtsExitBlock = mtsAppSource.slice(mtsExitStart, mtsAppSource.indexOf('respondToQuitConfirmation', mtsExitStart));
  expect(mtsExitBlock.indexOf("label: 'No'")).toBeLessThan(mtsExitBlock.indexOf("label: 'Yes'"));

  expect(electronMain).toContain("buttons: ['No', 'Yes']");
  expect(electronMain).toContain('defaultId: 0');
  expect(electronMain).toContain('cancelId: 0');
  expect(electronMain).toContain('confirmed = response === 1');
  expect(electronMain).not.toContain("buttons: ['Yes', 'No']");
});

test('SAM error boundary keeps internal runtime errors out of user-facing copy', () => {
  expect(indexSource).toContain('console.error("[APP] Renderer crashed:"');
  expect(indexSource).toContain('{appName} could not finish loading this section. Reload {appName} to try again.');
  expect(indexSource).toContain('<AppErrorBoundary appName="SAM">');
  expect(indexSource).not.toContain('<span>{this.state.message');
});
