const { spawn, execFileSync } = require('child_process');

const DEFAULT_GRACEFUL_TIMEOUT_MS = 3000;
const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 7000;

function classifyBackendListenerOwnership({
  mode,
  listenerPids = [],
  owner = null,
  heartbeat = null,
  ownerProcessRunning = false,
  now = Date.now(),
  heartbeatStaleAfterMs = DEFAULT_HEARTBEAT_STALE_AFTER_MS,
} = {}) {
  const normalizedMode = String(mode || '');
  const listeners = Array.from(new Set(
    (listenerPids || []).map((pid) => Number(pid || 0)).filter((pid) => pid > 0)
  ));
  const backendPid = Number(owner?.pid || 0);
  const ownerPid = Number(owner?.ownerPid || 0);
  const ownerMode = String(owner?.ownerMode || '');
  const heartbeatPid = Number(heartbeat?.pid || 0);
  const heartbeatMode = String(heartbeat?.mode || '');
  const heartbeatUpdatedAt = Number(heartbeat?.updatedAt || 0);
  const heartbeatFresh = Boolean(
    heartbeatUpdatedAt > 0
    && now - heartbeatUpdatedAt <= heartbeatStaleAfterMs
    && heartbeatPid === ownerPid
    && heartbeatMode === normalizedMode
  );
  const exactOwnedListener = Boolean(
    listeners.length === 1
    && backendPid > 0
    && ownerPid > 0
    && ownerMode === normalizedMode
    && listeners[0] === backendPid
  );

  if (!exactOwnedListener) {
    return {
      classification: 'unmanaged',
      backendPid: listeners.length === 1 ? listeners[0] : 0,
      ownerPid,
      heartbeatFresh,
    };
  }

  if (ownerProcessRunning && heartbeatFresh) {
    return {
      classification: 'active-owned',
      backendPid,
      ownerPid,
      heartbeatFresh: true,
    };
  }

  return {
    classification: 'stale-owned',
    backendPid,
    ownerPid,
    heartbeatFresh,
  };
}

function createOwnedProcessRegistry(options = {}) {
  const owner = options.owner || 'app';
  const logger = options.logger || console;
  const gracefulTimeoutMs = Number.isFinite(options.gracefulTimeoutMs)
    ? options.gracefulTimeoutMs
    : DEFAULT_GRACEFUL_TIMEOUT_MS;
  const terminatePidTree = options.terminatePidTree || defaultTerminatePidTree;
  const terminatePidTreeSync = options.terminatePidTreeSync || defaultTerminatePidTreeSync;
  const records = new Map();

  function log(level, message) {
    const writer = logger[level] || logger.log || (() => {});
    writer.call(logger, `[${owner.toUpperCase()}] ${message}`);
  }

  function registerOwnedProcess({ id, name, role, childProcess, pid, processOwner = owner } = {}) {
    const resolvedPid = Number(pid || childProcess?.pid || 0);
    if (!id) {
      throw new Error('Owned process registration requires an id.');
    }
    if (!resolvedPid) {
      throw new Error(`Owned process ${id} registration requires a pid.`);
    }

    const record = {
      id,
      name: name || id,
      role: role || name || id,
      owner: processOwner,
      childProcess: childProcess || null,
      pid: resolvedPid,
      startedAt: Date.now(),
      shutdownRequested: false,
      cleanupRequested: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      cleanupPromise: null,
    };

    records.set(id, record);

    if (childProcess?.once) {
      childProcess.once('exit', (code, signal) => {
        record.exited = true;
        record.exitCode = code;
        record.exitSignal = signal || null;
        log('log', `${record.name} PID ${record.pid} exited${code === null || code === undefined ? '' : ` with code ${code}`}.`);
      });
    }

    log('log', `Registered owned process: ${record.name} PID ${record.pid}`);
    return record;
  }

  function unregisterOwnedProcess(id) {
    return records.delete(id);
  }

  function getOwnedProcess(id) {
    return records.get(id) || null;
  }

  function listOwnedProcesses(processOwner = owner) {
    return Array.from(records.values()).filter((record) => record.owner === processOwner);
  }

  function isOwnedProcessRunning(id) {
    const record = records.get(id);
    if (!record || record.exited) return false;
    const child = record.childProcess;
    if (!child) return true;
    return child.exitCode === null && child.signalCode === null && !record.exited;
  }

  function waitForExit(record, timeoutMs) {
    if (!record.childProcess?.once || record.exited || !isOwnedProcessRunning(record.id)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.childProcess.removeListener?.('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      record.childProcess.once('exit', onExit);
    });
  }

  async function stopOwnedProcess(id, reason = 'cleanup') {
    const record = records.get(id);
    if (!record) {
      return { ok: true, skipped: true, reason: 'not-registered' };
    }
    if (record.cleanupPromise) {
      return record.cleanupPromise;
    }

    record.cleanupRequested = true;
    record.shutdownRequested = true;
    record.cleanupPromise = (async () => {
      if (record.exited || !isOwnedProcessRunning(id)) {
        unregisterOwnedProcess(id);
        return { ok: true, skipped: true, reason: 'already-exited' };
      }

      log('log', `Beginning cleanup for ${record.name} PID ${record.pid} (${reason})`);

      if (!record.childProcess?.kill) {
        try {
          await terminatePidTree(record.pid);
          record.exited = true;
          log('warn', `${record.name} PID ${record.pid} required exact-PID process-tree termination.`);
          unregisterOwnedProcess(id);
          return { ok: true, forced: true, pidOnly: true };
        } catch (err) {
          log('warn', `Failed to terminate ${record.name} PID ${record.pid}: ${safeErrorMessage(err)}`);
          return { ok: false, error: safeErrorMessage(err) };
        }
      }

      if (record.childProcess?.kill) {
        try {
          record.childProcess.kill();
        } catch (err) {
          log('warn', `Graceful stop request failed for ${record.name} PID ${record.pid}: ${safeErrorMessage(err)}`);
        }
      }

      const exitedGracefully = await waitForExit(record, gracefulTimeoutMs);
      if (exitedGracefully || record.exited || !isOwnedProcessRunning(id)) {
        log('log', `${record.name} PID ${record.pid} exited gracefully.`);
        unregisterOwnedProcess(id);
        return { ok: true, forced: false };
      }

      try {
        await terminatePidTree(record.pid);
        record.exited = true;
        log('warn', `${record.name} PID ${record.pid} required forced process-tree termination.`);
        unregisterOwnedProcess(id);
        return { ok: true, forced: true };
      } catch (err) {
        log('warn', `Failed to force terminate ${record.name} PID ${record.pid}: ${safeErrorMessage(err)}`);
        return { ok: false, error: safeErrorMessage(err) };
      }
    })();

    return record.cleanupPromise;
  }

  async function stopAllOwnedProcesses(processOwner = owner, reason = 'cleanup') {
    const ownedRecords = listOwnedProcesses(processOwner);
    const results = [];
    for (const record of ownedRecords) {
      results.push(await stopOwnedProcess(record.id, reason));
    }
    return results;
  }

  function forceStopAllOwnedProcessesSync(processOwner = owner, reason = 'emergency-cleanup') {
    const results = [];
    for (const record of listOwnedProcesses(processOwner)) {
      if (record.exited || record.cleanupRequested) continue;
      record.cleanupRequested = true;
      try {
        terminatePidTreeSync(record.pid);
        record.exited = true;
        log('warn', `${record.name} PID ${record.pid} force-terminated during ${reason}.`);
        results.push({ id: record.id, pid: record.pid, ok: true });
      } catch (err) {
        log('warn', `Emergency cleanup failed for ${record.name} PID ${record.pid}: ${safeErrorMessage(err)}`);
        results.push({ id: record.id, pid: record.pid, ok: false, error: safeErrorMessage(err) });
      }
    }
    return results;
  }

  return {
    registerOwnedProcess,
    unregisterOwnedProcess,
    getOwnedProcess,
    listOwnedProcesses,
    isOwnedProcessRunning,
    stopOwnedProcess,
    stopAllOwnedProcesses,
    forceStopAllOwnedProcessesSync,
  };
}

function safeErrorMessage(error) {
  return error && error.message ? error.message : String(error || 'Unknown error');
}

function defaultTerminatePidTree(pid) {
  const exactPid = Number(pid || 0);
  if (!exactPid) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const child = spawn('taskkill.exe', ['/PID', String(exactPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`taskkill exited with code ${code}`));
      });
      child.once('error', reject);
    });
  }

  try {
    process.kill(exactPid, 'SIGTERM');
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      return Promise.reject(err);
    }
  }
  return Promise.resolve();
}

function defaultTerminatePidTreeSync(pid) {
  const exactPid = Number(pid || 0);
  if (!exactPid) {
    return;
  }

  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(exactPid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(exactPid, 'SIGTERM');
  } catch (err) {
    if (err?.code !== 'ESRCH') {
      throw err;
    }
  }
}

module.exports = {
  DEFAULT_GRACEFUL_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_STALE_AFTER_MS,
  classifyBackendListenerOwnership,
  createOwnedProcessRegistry,
};
