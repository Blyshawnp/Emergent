import { TUTORIAL_COPY } from './TutorialPreviewOverlay';

test('tutorial guidance includes synced settings and workflow updates', () => {
  expect(TUTORIAL_COPY.settingsPage).toContain('welcome voice');
  expect(TUTORIAL_COPY.settingsPage).toContain('sound volume');
  expect(TUTORIAL_COPY.settingsPage).toContain('ticker speed');
  expect(TUTORIAL_COPY.settingsPage).toContain('payment options');
  expect(TUTORIAL_COPY.settingsPage).toContain('3 Credit Card and 3 EFT defaults');
  expect(TUTORIAL_COPY.settingsPage).toContain('Discord posts and screenshots');
  expect(TUTORIAL_COPY.callsSetup).toContain('each new call starts on Default');
  expect(TUTORIAL_COPY.callsScoring).toContain('helper text');
  expect(TUTORIAL_COPY.reviewFill).toContain('Final Readiness Judgment');
  expect(TUTORIAL_COPY.reviewFill).toContain('regenerate');
  expect(TUTORIAL_COPY.helpPage).toContain('Discord categories');
  expect(TUTORIAL_COPY.helpPage).toContain('optional local tutorial video');
});
