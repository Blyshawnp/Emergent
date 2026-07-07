import { welcomeAudioInternals } from './sound';

const { getSoundUrl, getWelcomeAudioKey, getWelcomeSoundUrls, normalizeAudioKey } = welcomeAudioInternals;

test('normalizes welcome audio keys from display name or tester first name', () => {
  expect(normalizeAudioKey(' Debbie! ')).toBe('debbie');
  expect(getWelcomeAudioKey({ testerName: 'Shawn Bly', displayName: '' })).toBe('shawn');
  expect(getWelcomeAudioKey({ testerName: 'Debra Smith', displayName: 'Debbie' })).toBe('debbie');
});

test('uses default welcome audio while setup is incomplete', () => {
  expect(getWelcomeSoundUrls({ setupComplete: false })).toEqual([
    './assets/sounds/welcome/welcome-default.mp3',
  ]);
});

test('orders male and female welcome audio fallbacks correctly', () => {
  expect(getWelcomeSoundUrls({
    testerName: 'Debra Smith',
    displayName: 'Debbie',
    welcomeVoice: 'male',
    setupComplete: true,
  })).toEqual([
    './assets/sounds/welcome/welcome-debbie.mp3',
    './assets/sounds/welcome/welcome-default.mp3',
  ]);

  expect(getWelcomeSoundUrls({
    testerName: 'Debra Smith',
    displayName: 'Debbie',
    welcomeVoice: 'female',
    setupComplete: true,
  })).toEqual([
    './assets/sounds/welcome/welcome-debbie-f.mp3',
    './assets/sounds/welcome/welcome-default-f.mp3',
    './assets/sounds/welcome/welcome-debbie.mp3',
    './assets/sounds/welcome/welcome-default.mp3',
  ]);
});

test('standard warning sound uses the SAM error asset', () => {
  expect(getSoundUrl('warning')).toBe('./assets/sounds/error-sam.mp3');
  expect(getSoundUrl('samError')).toBe('./assets/sounds/error-sam.mp3');
});
