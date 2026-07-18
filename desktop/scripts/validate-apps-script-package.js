const fs = require('fs');
const path = require('path');

const PLACEHOLDER_PATTERN = /DEPLOYMENT_ID|MTS_TOKEN|SAM_TOKEN|PLACEHOLDER|YOUR[_ -]?TOKEN/i;

function validateConfigPayload(payload, expectedRole) {
  const role = String(payload?.role || '').trim().toLowerCase();
  const baseUrl = String(payload?.base_url || '').trim();
  const token = String(payload?.token || '').trim();
  if (payload?.enabled !== true) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API config must be enabled before packaging.`);
  }
  if (role !== expectedRole) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API config has the wrong role.`);
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(baseUrl) || PLACEHOLDER_PATTERN.test(baseUrl)) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API endpoint is missing or invalid.`);
  }
  if (!token || PLACEHOLDER_PATTERN.test(token)) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API credential is missing or still a placeholder.`);
  }
}

function validateRoleConfig(expectedRole) {
  const configPath = path.resolve(
    __dirname,
    '..',
    '..',
    'backend',
    'config',
    `apps-script-api-${expectedRole}.json`,
  );
  if (!fs.existsSync(configPath)) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API config is missing; packaging stopped before creating an incomplete installer.`);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    throw new Error(`${expectedRole.toUpperCase()} Apps Script API config is not valid JSON.`);
  }
  validateConfigPayload(payload, expectedRole);
}

async function beforePack(context) {
  const productName = String(context?.packager?.config?.productName || '');
  const expectedRole = productName === 'Smart Alert Manager' ? 'sam' : 'mts';
  validateRoleConfig(expectedRole);
}

module.exports = beforePack;
module.exports.validateConfigPayload = validateConfigPayload;
module.exports.validateRoleConfig = validateRoleConfig;
