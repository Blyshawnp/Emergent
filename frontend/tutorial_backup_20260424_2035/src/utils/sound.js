const SOUND_FILES = {
  popup: 'ding.mp3',
  warning: 'error.mp3',
  success: 'chimes.mp3',
  setup: 'setup-welcome.mp3',
};

const DEFAULT_VOLUME = 0.26;
const SOUND_VOLUMES = {
  popup: 0.22,
  warning: 0.28,
  success: 0.27,
  setup: 0.28,
  welcome: 0.28,
};

const WELCOME_FOLDER = 'welcome';
const DEFAULT_WELCOME_FILE = 'welcome-default.mp3';

let soundsEnabled = true;
let soundsUnlocked = false;

const audioCache = new Map();
const pendingLoads = new Map();

function getBasePublicUrl() {
  const raw = process.env.PUBLIC_URL || '';
  if (!raw) return '.';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function buildAssetUrl(relativePath) {
  const cleanPath = String(relativePath || '').replace(/^\/+/, '');
  return `${getBasePublicUrl()}/${cleanPath}`;
}

function sanitizeFirstName(testerName = '') {
  return String(testerName || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

function getWelcomeSoundUrl(testerName = '') {
  const firstName = sanitizeFirstName(testerName);
  if (!firstName) {
    return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/${DEFAULT_WELCOME_FILE}`);
  }
  return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/welcome-${firstName}.mp3`);
}

function getDefaultWelcomeUrl() {
  return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/${DEFAULT_WELCOME_FILE}`);
}

function getSoundUrl(type, testerName = '') {
  if (type === 'welcome') {
    return getWelcomeSoundUrl(testerName);
  }

  const file = SOUND_FILES[type];
  if (!file) return '';

  return buildAssetUrl(`assets/sounds/${file}`);
}

function createAudio(url) {
  const audio = new Audio(url);
  audio.preload = 'auto';
  return audio;
}

function getVolumeForType(type) {
  return SOUND_VOLUMES[type] ?? DEFAULT_VOLUME;
}

function getOrCreateAudio(url) {
  if (!url) return null;

  if (!audioCache.has(url)) {
    audioCache.set(url, createAudio(url));
  }

  return audioCache.get(url);
}

function resetAudio(audio) {
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {}
}

async function ensureLoaded(audio, url) {
  if (!audio || !url) return;

  if (audio.readyState >= 2) return;

  if (pendingLoads.has(url)) {
    return pendingLoads.get(url);
  }

  const loadPromise = new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener('canplaythrough', onReady);
      audio.removeEventListener('loadeddata', onReady);
      audio.removeEventListener('error', onDone);
      pendingLoads.delete(url);
      resolve();
    };

    const onReady = () => finish();
    const onDone = () => finish();

    audio.addEventListener('canplaythrough', onReady, { once: true });
    audio.addEventListener('loadeddata', onReady, { once: true });
    audio.addEventListener('error', onDone, { once: true });

    try {
      audio.load();
    } catch {
      finish();
    }

    setTimeout(finish, 1200);
  });

  pendingLoads.set(url, loadPromise);
  return loadPromise;
}

async function safePlayUrl(url, type = '') {
  if (!soundsEnabled || !url) return false;

  try {
    const audio = getOrCreateAudio(url);
    if (!audio) return false;

    await ensureLoaded(audio, url);
    audio.volume = getVolumeForType(type);
    resetAudio(audio);
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

function warmCoreSounds() {
  const urls = [
    ...Object.values(SOUND_FILES).map((file) => buildAssetUrl(`assets/sounds/${file}`)),
    getDefaultWelcomeUrl(),
  ];

  urls.forEach((url) => {
    try {
      const audio = getOrCreateAudio(url);
      if (audio) {
        audio.load();
      }
    } catch {}
  });
}

export function setSoundsEnabled(enabled) {
  soundsEnabled = enabled !== false;
}

export function unlockSounds() {
  if (soundsUnlocked) return;
  soundsUnlocked = true;
  warmCoreSounds();
}

export async function playSound(type, testerName = '') {
  if (!soundsEnabled) return;

  if (!soundsUnlocked) {
    unlockSounds();
  }

  if (type === 'welcome') {
    const customUrl = getWelcomeSoundUrl(testerName);
    const fallbackUrl = getDefaultWelcomeUrl();

    if (customUrl !== fallbackUrl) {
      const playedCustom = await safePlayUrl(customUrl, 'welcome');
      if (playedCustom) return;
    }

    await safePlayUrl(fallbackUrl, 'welcome');
    return;
  }

  const url = getSoundUrl(type, testerName);
  await safePlayUrl(url, type);
}
