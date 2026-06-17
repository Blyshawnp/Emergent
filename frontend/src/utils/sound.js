const SOUND_FILES = {
  popup: 'ding.mp3',
  warning: 'error.mp3',
  success: 'chimes.mp3',
  setup: 'setup-welcome.mp3',
  notificationApp: 'notification-app.mp3',
  samSuccess: 'success-sam.mp3',
  samError: 'error-sam.mp3',
};

const DEFAULT_VOLUME = 0.26;
const SOUND_VOLUMES = {
  off: 0,
  low: 0.3,
  medium: 0.6,
  high: 1,
};

const WELCOME_FOLDER = 'welcome';
const DEFAULT_WELCOME_FILE = 'welcome-default.mp3';
const DEFAULT_WELCOME_FILE_FEMALE = 'welcome-default-f.mp3';

let soundsEnabled = true;
let soundVolumeLevel = 'medium';
let welcomeVoice = 'male';
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

function normalizeAudioKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function normalizeFirstName(testerName = '') {
  const first = String(testerName || '').trim().split(/\s+/)[0] || '';
  return normalizeAudioKey(first);
}

function getWelcomeAudioKey(options = {}) {
  const displayName = typeof options === 'string' ? '' : options.displayName;
  const testerName = typeof options === 'string' ? options : options.testerName;
  const displayKey = normalizeAudioKey(displayName || '');
  return displayKey || normalizeFirstName(testerName || '');
}

function getDefaultWelcomeUrl() {
  return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/${DEFAULT_WELCOME_FILE}`);
}

function getDefaultFemaleWelcomeUrl() {
  return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/${DEFAULT_WELCOME_FILE_FEMALE}`);
}

function welcomeFileUrl(fileName) {
  return buildAssetUrl(`assets/sounds/${WELCOME_FOLDER}/${fileName}`);
}

function getWelcomeSoundUrls(options = {}) {
  if (typeof options === 'string') {
    options = { testerName: options, setupComplete: true };
  }

  const setupComplete = options.setupComplete !== false;
  const selectedVoice = String(options.welcomeVoice || welcomeVoice || 'male').toLowerCase() === 'female' ? 'female' : 'male';
  const audioKey = getWelcomeAudioKey(options);

  if (!setupComplete) {
    return [getDefaultWelcomeUrl()];
  }

  if (selectedVoice === 'female') {
    return [
      audioKey ? welcomeFileUrl(`welcome-${audioKey}-f.mp3`) : '',
      getDefaultFemaleWelcomeUrl(),
      audioKey ? welcomeFileUrl(`welcome-${audioKey}.mp3`) : '',
      getDefaultWelcomeUrl(),
    ].filter(Boolean);
  }

  return [
    audioKey ? welcomeFileUrl(`welcome-${audioKey}.mp3`) : '',
    getDefaultWelcomeUrl(),
  ].filter(Boolean);
}

function getSoundUrl(type, testerName = '') {
  if (type === 'welcome') {
    return getWelcomeSoundUrls(testerName)[0] || getDefaultWelcomeUrl();
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

function normalizeVolumeLevel(level, enabled = true) {
  if (enabled === false) return 'off';
  const normalized = String(level || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SOUND_VOLUMES, normalized)) {
    return normalized;
  }
  return 'medium';
}

function getVolumeForType(_type) {
  return SOUND_VOLUMES[soundVolumeLevel] ?? DEFAULT_VOLUME;
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
  const volume = getVolumeForType(type);
  if (volume <= 0) return false;

  try {
    const audio = getOrCreateAudio(url);
    if (!audio) return false;

    await ensureLoaded(audio, url);
    audio.volume = volume;
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
    getDefaultFemaleWelcomeUrl(),
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
  soundVolumeLevel = enabled === false ? 'off' : 'medium';
}

export function setSoundSettings(settings = {}) {
  if (typeof settings === 'string') {
    soundVolumeLevel = normalizeVolumeLevel(settings);
  } else {
    soundVolumeLevel = normalizeVolumeLevel(settings.sound_volume, settings.enable_sounds);
    welcomeVoice = String(settings.welcome_voice || 'male').trim().toLowerCase() === 'female' ? 'female' : 'male';
  }
  soundsEnabled = soundVolumeLevel !== 'off';
}

export function unlockSounds() {
  if (soundsUnlocked) return;
  soundsUnlocked = true;
  warmCoreSounds();
}

export async function playSound(type, testerName = '') {
  if (!soundsEnabled) return false;

  if (!soundsUnlocked) {
    unlockSounds();
  }

  if (type === 'welcome') {
    const urls = getWelcomeSoundUrls(testerName);
    const tried = new Set();
    for (const url of urls) {
      if (!url || tried.has(url)) continue;
      tried.add(url);
      const played = await safePlayUrl(url, 'welcome');
      if (played) return true;
    }
    return false;
  }

  const url = getSoundUrl(type, testerName);
  return safePlayUrl(url, type);
}

export const welcomeAudioInternals = {
  normalizeAudioKey,
  getWelcomeAudioKey,
  getWelcomeSoundUrls,
};
