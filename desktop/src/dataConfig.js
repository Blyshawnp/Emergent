const fs = require('fs');

function resolveDataProviderConfig(runtimeConfigPath, env = process.env, defaultProvider = 'sheets') {
  if (env && env.MTS_DATA_PROVIDER && String(env.MTS_DATA_PROVIDER).trim()) {
    return String(env.MTS_DATA_PROVIDER).trim().toLowerCase();
  }
  if (runtimeConfigPath && fs.existsSync(runtimeConfigPath)) {
    try {
      const raw = fs.readFileSync(runtimeConfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data_provider && String(parsed.data_provider).trim()) {
        return String(parsed.data_provider).trim().toLowerCase();
      }
    } catch (_) {}
  }
  return defaultProvider;
}

function resolveDataRuntimeEnv(runtimeConfigPath, env = process.env) {
  const provider = resolveDataProviderConfig(runtimeConfigPath, env, 'sheets');
  const result = {
    MTS_DATA_PROVIDER: provider,
  };
  if (env && env.MTS_SHADOW_COMPARE !== undefined) {
    result.MTS_SHADOW_COMPARE = String(env.MTS_SHADOW_COMPARE);
  } else {
    result.MTS_SHADOW_COMPARE = provider === 'sheets' ? 'true' : 'false';
  }
  if (env && env.MTS_DUAL_WRITE_ENABLED !== undefined) {
    result.MTS_DUAL_WRITE_ENABLED = String(env.MTS_DUAL_WRITE_ENABLED);
  } else {
    result.MTS_DUAL_WRITE_ENABLED = 'false';
  }
  if (env && env.MTS_DUAL_WRITE_DOMAINS !== undefined) {
    result.MTS_DUAL_WRITE_DOMAINS = String(env.MTS_DUAL_WRITE_DOMAINS);
  } else {
    result.MTS_DUAL_WRITE_DOMAINS = '[]';
  }
  return result;
}

module.exports = {
  resolveDataProviderConfig,
  resolveDataRuntimeEnv,
};
