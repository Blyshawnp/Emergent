export function getBackendUrl() {
  const electronUrl = (() => {
    try {
      return (window.electronAPI?.getBackendUrl?.() || '').trim();
    } catch (_error) {
      return '';
    }
  })();
  if (electronUrl) return electronUrl.replace(/\/+$/, '');

  const configuredUrl = (process.env.REACT_APP_BACKEND_URL || '').trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, '');

  try {
    if (String(window.location?.hash || '').includes('notification-manager')) {
      return 'http://127.0.0.1:8601';
    }
  } catch (_error) {
    // Fall through to the main app backend port.
  }

  return 'http://127.0.0.1:8600';
}

export function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  const backend = getBackendUrl();
  const cleanPath = value.replace(/^\/+/, '');
  if (/\.(png|jpe?g|gif|webp)$/i.test(cleanPath)) {
    const parts = cleanPath.split('/');
    const filename = parts[parts.length - 1];
    return `${backend}/api/screenshot-assets/${filename}`;
  }
  return `${backend}/${cleanPath}`;
}

export function findScreenshotByTitle(screenshots, titlePattern) {
  const items = Array.isArray(screenshots) ? screenshots : [];
  const pattern = titlePattern instanceof RegExp ? titlePattern : new RegExp(String(titlePattern || ''), 'i');
  return items.find((item) => pattern.test(String(item?.title || item?.label || item?.name || ''))) || null;
}
