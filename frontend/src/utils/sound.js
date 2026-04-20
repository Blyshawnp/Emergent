const SOUND_URLS = {
  popup: '/assets/sounds/ding.mp3',
  warning: '/assets/sounds/error.mp3',
  success: '/assets/sounds/chimes.mp3',
  setup: '/assets/sounds/setup-welcome.mp3',
};

const DEFAULT_WELCOME = '/assets/sounds/welcome/welcome-default.mp3';

let soundsEnabled = true;

export function setSoundsEnabled(enabled) {
  soundsEnabled = enabled !== false;
}

function getWelcomeSoundUrl(testerName = '') {
  const firstName = String(testerName || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  if (!firstName) {
    return DEFAULT_WELCOME;
  }

  return `/assets/sounds/welcome/welcome-${firstName}.mp3`;
}

function getSoundUrl(type, testerName = '') {
  if (type === 'welcome') {
    return getWelcomeSoundUrl(testerName);
  }
  return SOUND_URLS[type] ?? '';
}

export function playSound(type, testerName = '') {
  if (!soundsEnabled) return;

  const url = getSoundUrl(type, testerName);
  if (!url) return;

  try {
    const audio = new Audio(url);
    audio.preload = 'auto';

    if (type === 'welcome' && url !== DEFAULT_WELCOME) {
      audio.oncanplaythrough = () => {
        audio.play().catch(() => {});
      };

      audio.onerror = () => {
        try {
          const fallback = new Audio(DEFAULT_WELCOME);
          fallback.preload = 'auto';
          fallback.play().catch(() => {});
        } catch {}
      };

      audio.load();
    } else {
      audio.play().catch(() => {});
    }
  } catch {}
}