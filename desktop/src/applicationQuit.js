const DEFAULT_QUIT_CLEANUP_TIMEOUT_MS = 10000;

function createApplicationQuitController({
  app,
  cleanupOwnedProcesses,
  forceCleanupOwnedProcessesSync,
  stopRuntimeActivity = () => {},
  closeApplicationWindows = () => {},
  cleanupTimeoutMs = DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
  logger = console,
} = {}) {
  let intentionalQuit = false;
  let quitPromise = null;
  let cleanupComplete = false;

  async function runBoundedCleanup(reason) {
    let timeoutId = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => cleanupOwnedProcesses(reason)),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('owned-process cleanup timed out')), cleanupTimeoutMs);
          timeoutId.unref?.();
        }),
      ]);
    } catch (error) {
      logger.warn?.(`[APP] ${error?.message || 'Owned-process cleanup failed'}; using exact-PID synchronous fallback.`);
      try {
        forceCleanupOwnedProcessesSync(`${reason}-fallback`);
      } catch (fallbackError) {
        logger.error?.(`[APP] Exact-PID cleanup fallback failed: ${fallbackError?.message || 'unknown error'}`);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      cleanupComplete = true;
    }
  }

  function requestApplicationQuit(reason = 'requested-quit', exitCode = 0) {
    if (quitPromise) {
      return quitPromise;
    }

    intentionalQuit = true;
    app.isQuitting = true;
    stopRuntimeActivity();
    quitPromise = (async () => {
      await runBoundedCleanup(reason);
      try {
        closeApplicationWindows();
      } catch (error) {
        logger.warn?.(`[APP] Failed to close an application window during quit: ${error?.message || 'unknown error'}`);
      }
      app.exit(exitCode);
      return { ok: true, reason, exitCode };
    })();
    return quitPromise;
  }

  function handleBeforeQuit(event) {
    if (cleanupComplete) {
      return;
    }
    event?.preventDefault?.();
    void requestApplicationQuit('before-quit');
  }

  return {
    requestApplicationQuit,
    handleBeforeQuit,
    isIntentionalQuit: () => intentionalQuit,
    isCleanupComplete: () => cleanupComplete,
  };
}

module.exports = {
  DEFAULT_QUIT_CLEANUP_TIMEOUT_MS,
  createApplicationQuitController,
};
