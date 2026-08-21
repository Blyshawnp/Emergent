const assert = require('node:assert/strict');
const test = require('node:test');

test('promptForQuitConfirmation dispatches app:confirm-quit and handles No/Yes responses', async () => {
  let isHandlingCloseConfirmation = false;
  let quitConfirmationResolver = null;
  const events = [];
  const calls = [];

  function sendAppEvent(type, payload) {
    events.push({ type, payload });
  }

  const mockRequestQuit = async (reason) => {
    calls.push(['requestApplicationQuit', reason]);
    return true;
  };

  async function promptForQuitConfirmation(isNotificationManagerMode = true, hasUnsavedChanges = false) {
    if (isHandlingCloseConfirmation) {
      return false;
    }
    isHandlingCloseConfirmation = true;
    try {
      const confirmed = await new Promise((resolve) => {
        quitConfirmationResolver = resolve;
        sendAppEvent('app:confirm-quit', {
          isNotificationManagerMode,
          hasUnsavedChanges,
        });
      });

      if (!confirmed) {
        return false;
      }

      await mockRequestQuit('confirmed-quit');
      return true;
    } finally {
      quitConfirmationResolver = null;
      isHandlingCloseConfirmation = false;
    }
  }

  function respondToQuit(confirmed) {
    if (quitConfirmationResolver) {
      quitConfirmationResolver(Boolean(confirmed));
    }
  }

  // 1. User clicks No (false)
  const promptPromiseNo = promptForQuitConfirmation(true, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'app:confirm-quit');
  assert.equal(events[0].payload.isNotificationManagerMode, true);

  respondToQuit(false);
  const resNo = await promptPromiseNo;
  assert.equal(resNo, false);
  assert.equal(calls.length, 0); // Did not request application quit

  // 2. User clicks Yes (true)
  const promptPromiseYes = promptForQuitConfirmation(true, false);
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'app:confirm-quit');

  respondToQuit(true);
  const resYes = await promptPromiseYes;
  assert.equal(resYes, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'requestApplicationQuit');
  assert.equal(calls[0][1], 'confirmed-quit');
});

test('promptForQuitConfirmation protects against re-entrant calls', async () => {
  let isHandlingCloseConfirmation = false;
  let quitConfirmationResolver = null;

  async function prompt() {
    if (isHandlingCloseConfirmation) {
      return false;
    }
    isHandlingCloseConfirmation = true;
    try {
      const confirmed = await new Promise((resolve) => {
        quitConfirmationResolver = resolve;
      });
      return Boolean(confirmed);
    } finally {
      quitConfirmationResolver = null;
      isHandlingCloseConfirmation = false;
    }
  }

  const p1 = prompt();
  const p2 = prompt(); // duplicate while first is open

  assert.equal(await p2, false); // rejected immediately by guard

  quitConfirmationResolver(false);
  assert.equal(await p1, false);
});

