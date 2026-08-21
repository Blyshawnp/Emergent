const test = require('node:test');
const assert = require('node:assert/strict');

function extractDeepLinkUrl(argvList = []) {
  if (!Array.isArray(argvList)) return null;
  for (const arg of argvList) {
    if (typeof arg === 'string') {
      const trimmed = arg.trim();
      if (/^(smartalertmanager|sam):\/\//i.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

function validateAndSanitizeDeepLink(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length > 4096) {
    return null;
  }
  const validPattern = /^(smartalertmanager|sam):\/\/reset-password(\/?|\?.*|#.*)?$/i;
  if (!validPattern.test(trimmed)) {
    return null;
  }
  return trimmed;
}

test('extractDeepLinkUrl extracts smartalertmanager and sam deep link from command line arguments', () => {
  const argv1 = ['C:\\Program Files\\SAM\\Smart Alert Manager.exe', '--some-flag', 'smartalertmanager://reset-password#access_token=123'];
  assert.equal(extractDeepLinkUrl(argv1), 'smartalertmanager://reset-password#access_token=123');

  const argv2 = ['electron.exe', '.', 'sam://reset-password?code=456'];
  assert.equal(extractDeepLinkUrl(argv2), 'sam://reset-password?code=456');

  const argv3 = ['electron.exe', '.', '--port', '8601'];
  assert.equal(extractDeepLinkUrl(argv3), null);

  assert.equal(extractDeepLinkUrl(null), null);
  assert.equal(extractDeepLinkUrl([]), null);
});

test('validateAndSanitizeDeepLink accepts valid recovery links and rejects dangerous or arbitrary URIs', () => {
  // Valid smartalertmanager links
  assert.equal(
    validateAndSanitizeDeepLink('smartalertmanager://reset-password#access_token=abc&refresh_token=xyz&type=recovery'),
    'smartalertmanager://reset-password#access_token=abc&refresh_token=xyz&type=recovery'
  );
  assert.equal(
    validateAndSanitizeDeepLink('smartalertmanager://reset-password?code=12345'),
    'smartalertmanager://reset-password?code=12345'
  );
  assert.equal(
    validateAndSanitizeDeepLink('smartalertmanager://reset-password#error=access_denied&error_code=otp_expired'),
    'smartalertmanager://reset-password#error=access_denied&error_code=otp_expired'
  );

  // Valid sam alias links
  assert.equal(
    validateAndSanitizeDeepLink('sam://reset-password#access_token=abc'),
    'sam://reset-password#access_token=abc'
  );

  // Reject unrecognized paths
  assert.equal(validateAndSanitizeDeepLink('smartalertmanager://execute-command?cmd=calc'), null);
  assert.equal(validateAndSanitizeDeepLink('smartalertmanager://settings'), null);
  assert.equal(validateAndSanitizeDeepLink('sam://admin/delete'), null);

  // Reject wrong protocols
  assert.equal(validateAndSanitizeDeepLink('https://evil.com/reset-password'), null);
  assert.equal(validateAndSanitizeDeepLink('javascript:alert(1)'), null);
  assert.equal(validateAndSanitizeDeepLink('file:///C:/Windows/System32/cmd.exe'), null);

  // Reject oversized strings
  const hugeUrl = 'smartalertmanager://reset-password#' + 'a'.repeat(5000);
  assert.equal(validateAndSanitizeDeepLink(hugeUrl), null);

  // Reject null/empty/invalid types
  assert.equal(validateAndSanitizeDeepLink(''), null);
  assert.equal(validateAndSanitizeDeepLink(null), null);
  assert.equal(validateAndSanitizeDeepLink(123), null);
});
