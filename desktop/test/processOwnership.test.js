const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createOwnedProcessRegistry } = require('../src/processOwnership');

function createMockChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
  };
  child.exitNow = (code = 0) => {
    child.exitCode = code;
    child.emit('exit', code, null);
  };
  return child;
}

async function run() {
  const forced = [];
  const logs = [];
  const logger = {
    log: (message) => logs.push(['log', message]),
    warn: (message) => logs.push(['warn', message]),
  };
  const registry = createOwnedProcessRegistry({
    owner: 'mts',
    gracefulTimeoutMs: 5,
    logger,
    terminatePidTree: async (pid) => {
      forced.push(pid);
    },
    terminatePidTreeSync: (pid) => {
      forced.push(`sync:${pid}`);
    },
  });

  const mtsBackend = createMockChild(1111);
  const samBackend = createMockChild(2222);

  registry.registerOwnedProcess({
    id: 'mts-backend',
    name: 'backend',
    role: 'fastapi-backend',
    owner: 'mts',
    childProcess: mtsBackend,
  });
  registry.registerOwnedProcess({
    id: 'sam-backend',
    name: 'backend',
    role: 'fastapi-backend',
    processOwner: 'sam',
    childProcess: samBackend,
  });

  assert.strictEqual(registry.isOwnedProcessRunning('mts-backend'), true);
  assert.strictEqual(registry.isOwnedProcessRunning('sam-backend'), true);

  const firstCleanup = registry.stopOwnedProcess('mts-backend', 'test-cleanup');
  const duplicateCleanup = registry.stopOwnedProcess('mts-backend', 'duplicate-cleanup');
  assert.strictEqual(mtsBackend.killCalls, 1);

  await Promise.all([firstCleanup, duplicateCleanup]);
  assert.strictEqual(mtsBackend.killCalls, 1);
  assert.deepStrictEqual(forced, [1111]);
  assert.strictEqual(registry.isOwnedProcessRunning('sam-backend'), true);
  assert.strictEqual(samBackend.killCalls, 0);

  samBackend.exitNow(0);
  const alreadyExited = await registry.stopOwnedProcess('sam-backend', 'already-exited');
  assert.strictEqual(alreadyExited.skipped, true);
  assert.deepStrictEqual(forced, [1111]);

  registry.registerOwnedProcess({
    id: 'listener-only',
    name: 'backend-listener',
    role: 'fastapi-backend-listener',
    pid: 4444,
  });
  const listenerCleanup = await registry.stopOwnedProcess('listener-only', 'listener-cleanup');
  assert.strictEqual(listenerCleanup.forced, true);
  assert.strictEqual(listenerCleanup.pidOnly, true);
  assert.deepStrictEqual(forced, [1111, 4444]);

  const syncChild = createMockChild(3333);
  registry.registerOwnedProcess({
    id: 'sync-backend',
    name: 'backend',
    role: 'fastapi-backend',
    childProcess: syncChild,
  });
  registry.forceStopAllOwnedProcessesSync('mts', 'emergency-test');
  assert.deepStrictEqual(forced, [1111, 4444, 'sync:3333']);

  assert.strictEqual(logs.some(([, message]) => /backend\.exe|node\.exe|python\.exe|electron\.exe/i.test(message)), false);

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /QUIT_CONFIRMATION_TIMEOUT_MS\s*=\s*4000/);
  assert.match(mainSource, /Renderer did not acknowledge quit confirmation; using native fallback dialog\./);
  assert.match(mainSource, /buttons:\s*\['No', 'Yes'\]/);
  assert.doesNotMatch(mainSource, /taskkill\s+\/IM/i);
  assert.doesNotMatch(mainSource, /wmic/i);
}

run().then(() => {
  console.log('processOwnership tests passed');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
