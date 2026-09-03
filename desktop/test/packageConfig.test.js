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

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveDataProviderConfig,
  resolveDataRuntimeEnv,
} = require('../src/dataConfig');

test('packaged SAM resolves data_provider = supabase from runtime_config.json when no developer env vars are present', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-config-test-'));
  const configPath = path.join(tmpDir, 'runtime_config.json');
  fs.writeFileSync(configPath, JSON.stringify({ data_provider: 'supabase' }), 'utf8');

  // No environment variables supplied
  const cleanEnv = {};
  const provider = resolveDataProviderConfig(configPath, cleanEnv);
  assert.equal(provider, 'supabase');

  const runtimeEnv = resolveDataRuntimeEnv(configPath, cleanEnv);
  assert.equal(runtimeEnv.MTS_DATA_PROVIDER, 'supabase');
  assert.equal(runtimeEnv.MTS_SHADOW_COMPARE, 'false');
  assert.equal(runtimeEnv.MTS_DUAL_WRITE_ENABLED, 'false');
  assert.equal(runtimeEnv.MTS_DUAL_WRITE_DOMAINS, '[]');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('explicit environment override still wins when intentionally supplied', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-config-test-'));
  const configPath = path.join(tmpDir, 'runtime_config.json');
  fs.writeFileSync(configPath, JSON.stringify({ data_provider: 'supabase' }), 'utf8');

  // Explicit override to sheets for rollback/dev
  const overrideEnv = { MTS_DATA_PROVIDER: 'sheets' };
  const provider = resolveDataProviderConfig(configPath, overrideEnv);
  assert.equal(provider, 'sheets');

  const runtimeEnv = resolveDataRuntimeEnv(configPath, overrideEnv);
  assert.equal(runtimeEnv.MTS_DATA_PROVIDER, 'sheets');
  assert.equal(runtimeEnv.MTS_SHADOW_COMPARE, 'true');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('falls back to safe default sheets when runtime config is absent or empty', () => {
  const missingPath = path.join(os.tmpdir(), 'nonexistent-runtime-config.json');
  const provider = resolveDataProviderConfig(missingPath, {});
  assert.equal(provider, 'sheets');

  const runtimeEnv = resolveDataRuntimeEnv(missingPath, {});
  assert.equal(runtimeEnv.MTS_DATA_PROVIDER, 'sheets');
  assert.equal(runtimeEnv.MTS_SHADOW_COMPARE, 'true');
});
