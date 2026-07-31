const assert = require('node:assert/strict');
const test = require('node:test');

const { createApplicationQuitController } = require('../src/applicationQuit');

function fixture(overrides = {}) {
  const calls = [];
  const app = {
    isQuitting: false,
    exit: (code) => calls.push(['exit', code]),
  };
  const controller = createApplicationQuitController({
    app,
    cleanupTimeoutMs: 10,
    cleanupOwnedProcesses: async (reason) => calls.push(['cleanup', reason]),
    forceCleanupOwnedProcessesSync: (reason) => calls.push(['force', reason]),
    stopRuntimeActivity: () => calls.push(['stop-runtime']),
    closeApplicationWindows: () => calls.push(['close-windows']),
    logger: {
      warn: (message) => calls.push(['warn', message]),
      error: (message) => calls.push(['error', message]),
    },
    ...overrides,
  });
  return { app, calls, controller };
}

test('confirmed exit runs one authoritative intentional quit sequence', async () => {
  const { app, calls, controller } = fixture();
  const first = controller.requestApplicationQuit('confirmed-quit');
  const duplicate = controller.requestApplicationQuit('duplicate');
  assert.strictEqual(first, duplicate);
  await first;
  assert.equal(app.isQuitting, true);
  assert.equal(controller.isIntentionalQuit(), true);
  assert.deepEqual(calls, [
    ['stop-runtime'],
    ['cleanup', 'confirmed-quit'],
    ['close-windows'],
    ['exit', 0],
  ]);
});

test('cleanup timeout uses the exact-owned synchronous fallback and still exits', async () => {
  const { calls, controller } = fixture({ cleanupOwnedProcesses: () => new Promise(() => {}) });
  await controller.requestApplicationQuit('timeout-test');
  assert.equal(calls.some(([name]) => name === 'force'), true);
  assert.deepEqual(calls.slice(-2), [['close-windows'], ['exit', 0]]);
});

test('before-quit is intercepted only until bounded cleanup completes', async () => {
  const { calls, controller } = fixture();
  let prevented = 0;
  controller.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  await controller.requestApplicationQuit('duplicate');
  assert.equal(prevented, 1);
  controller.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(calls.filter(([name]) => name === 'cleanup').length, 1);
});

test('forced-cleanup or auxiliary-window errors cannot strand Electron', async () => {
  const { calls, controller } = fixture({
    cleanupOwnedProcesses: async () => { throw new Error('cleanup failed'); },
    forceCleanupOwnedProcessesSync: () => { throw new Error('fallback failed'); },
    closeApplicationWindows: () => { throw new Error('window close failed'); },
  });
  await controller.requestApplicationQuit('failure-test');
  assert.equal(calls.some(([name]) => name === 'error'), true);
  assert.deepEqual(calls.slice(-1), [['exit', 0]]);
});
