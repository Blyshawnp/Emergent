const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyBackendListenerOwnership,
  createOwnedProcessRegistry,
} = require('../src/processOwnership');

async function testDynamicPortConfiguration() {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

  // Verify preferred port and fallback constants
  assert.match(mainSource, /const PREFERRED_BACKEND_PORT\s*=\s*isNotificationManagerMode \? 8601 : 8600/);
  assert.match(mainSource, /const SAM_FALLBACK_PORT_RANGE\s*=\s*\[8602,\s*8603,\s*8604,\s*8605,\s*8606,\s*8607,\s*8608,\s*8609,\s*8610\]/);
  assert.match(mainSource, /let selectedBackendPort\s*=\s*PREFERRED_BACKEND_PORT/);
  assert.match(mainSource, /let backendPortOccupantClassification\s*=\s*'available'/);

  // Verify IPC backend:getUrl returns selectedBackendPort
  assert.match(mainSource, /ipcMain\.on\('backend:getUrl'/);
  assert.match(mainSource, /selectedBackendPort/);

  // Verify getBackendState includes full port diagnostics
  assert.match(mainSource, /preferredPort:\s*PREFERRED_BACKEND_PORT/);
  assert.match(mainSource, /selectedPort:\s*selectedBackendPort/);
  assert.match(mainSource, /fallbackUsed:\s*selectedBackendPort\s*!==\s*PREFERRED_BACKEND_PORT/);
  assert.match(mainSource, /occupantClassification:\s*backendPortOccupantClassification/);

  // Verify ensureBackendAvailable iterates candidate ports
  assert.match(mainSource, /candidatePorts\s*=\s*isNotificationManagerMode/);
  assert.match(mainSource, /PREFERRED_BACKEND_PORT,\s*\.\.\.SAM_FALLBACK_PORT_RANGE/);

  // Verify packaged spawn passes selectedBackendPort
  assert.match(mainSource, /BACKEND_PORT:\s*String\(selectedBackendPort\)/);

  // Verify MTS isolation: port 8600 is excluded from SAM fallback range
  const fallbackRangeMatch = mainSource.match(/const SAM_FALLBACK_PORT_RANGE\s*=\s*(\[[^\]]+\])/);
  assert.ok(fallbackRangeMatch, 'SAM_FALLBACK_PORT_RANGE must exist');
  const ports = JSON.parse(fallbackRangeMatch[1]);
  assert.strictEqual(ports.includes(8600), false, 'Port 8600 must NOT be in SAM fallback range (MTS isolation)');
  assert.strictEqual(ports[0], 8602, 'Fallback should begin at 8602');
  assert.strictEqual(ports[ports.length - 1], 8610, 'Fallback should end at 8610');
}

async function testOccupantClassificationScenarios() {
  const now = Date.now();

  // Scenario 1: Active owned backend on port
  const activeOwner = { pid: 9000, ownerPid: 8000, ownerMode: 'notification-manager' };
  const activeHeartbeat = { pid: 8000, mode: 'notification-manager', updatedAt: now - 500 };
  const activeResult = classifyBackendListenerOwnership({
    mode: 'notification-manager',
    listenerPids: [9000],
    owner: activeOwner,
    heartbeat: activeHeartbeat,
    ownerProcessRunning: true,
    now,
  });
  assert.strictEqual(activeResult.classification, 'active-owned');

  // Scenario 2: Stale owned backend with dead parent
  const staleOwner = { pid: 9001, ownerPid: 8001, ownerMode: 'notification-manager' };
  const staleHeartbeat = { pid: 8001, mode: 'notification-manager', updatedAt: now - 60000 };
  const staleResult = classifyBackendListenerOwnership({
    mode: 'notification-manager',
    listenerPids: [9001],
    owner: staleOwner,
    heartbeat: staleHeartbeat,
    ownerProcessRunning: false,
    now,
  });
  assert.strictEqual(staleResult.classification, 'stale-owned');

  // Scenario 3: Unmanaged/foreign process on port
  const unmanagedResult = classifyBackendListenerOwnership({
    mode: 'notification-manager',
    listenerPids: [9999],
    owner: null,
    heartbeat: null,
    ownerProcessRunning: false,
    now,
  });
  assert.strictEqual(unmanagedResult.classification, 'unmanaged');

  // Scenario 4: Mode mismatch (e.g. MTS process on SAM port)
  const mismatchResult = classifyBackendListenerOwnership({
    mode: 'notification-manager',
    listenerPids: [7000],
    owner: { pid: 7000, ownerPid: 6000, ownerMode: 'main' },
    heartbeat: { pid: 6000, mode: 'main', updatedAt: now - 500 },
    ownerProcessRunning: true,
    now,
  });
  assert.strictEqual(mismatchResult.classification, 'unmanaged');
}

async function run() {
  await testDynamicPortConfiguration();
  await testOccupantClassificationScenarios();
  console.log('portFallback tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
