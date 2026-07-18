const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateConfigPayload,
} = require('../scripts/validate-apps-script-package');

test('package config validation accepts only the intended role with a non-placeholder credential', () => {
  assert.doesNotThrow(() => validateConfigPayload({
    enabled: true,
    role: 'mts',
    base_url: 'https://script.google.com/macros/s/test-deployment/exec',
    token: 'test-credential-value',
  }, 'mts'));

  assert.throws(() => validateConfigPayload({
    enabled: true,
    role: 'sam',
    base_url: 'https://script.google.com/macros/s/test-deployment/exec',
    token: 'test-credential-value',
  }, 'mts'), /wrong role/);

  assert.throws(() => validateConfigPayload({
    enabled: true,
    role: 'mts',
    base_url: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
    token: 'MTS_TOKEN',
  }, 'mts'), /missing or invalid|placeholder/);
});
