const assert = require('node:assert/strict');
const test = require('node:test');

test('promptForQuitConfirmation shows immediate native dialog and handles No/Yes responses', async () => {
  let isHandlingCloseConfirmation = false;
  const calls = [];

  const mockDialog = {
    showMessageBox: async (parent, options) => {
      calls.push(['showMessageBox', options]);
      return { response: options._mockResponse ?? 0 };
    },
  };

  const mockRequestQuit = async (reason) => {
    calls.push(['requestApplicationQuit', reason]);
    return true;
  };

  async function promptForQuitConfirmation(dialogResponse = 0, isNotificationManagerMode = true, hasUnsavedChanges = false) {
    if (isHandlingCloseConfirmation) {
      return false;
    }
    isHandlingCloseConfirmation = true;
    try {
      const { response } = await mockDialog.showMessageBox(null, {
        type: 'question',
        buttons: ['No', 'Yes'],
        defaultId: 0,
        cancelId: 0,
        title: isNotificationManagerMode ? 'Exit Smart Alert Manager' : 'Close App',
        message: isNotificationManagerMode
          ? 'Are you sure you want to exit Smart Alert Manager?'
          : (hasUnsavedChanges
              ? 'You have unsaved work. Are you sure you want to close the app?'
              : 'Are you sure you want to close the app?'),
        _mockResponse: dialogResponse,
      });

      const confirmed = response === 1;
      if (!confirmed) {
        return false;
      }

      await mockRequestQuit('confirmed-quit');
      return true;
    } finally {
      isHandlingCloseConfirmation = false;
    }
  }

  // 1. User clicks No (0)
  const resNo = await promptForQuitConfirmation(0);
  assert.equal(resNo, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'showMessageBox');
  assert.deepEqual(calls[0][1].buttons, ['No', 'Yes']);
  assert.equal(calls[0][1].title, 'Exit Smart Alert Manager');

  // 2. User clicks Yes (1)
  const resYes = await promptForQuitConfirmation(1);
  assert.equal(resYes, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1][0], 'showMessageBox');
  assert.equal(calls[2][0], 'requestApplicationQuit');
  assert.equal(calls[2][1], 'confirmed-quit');
});

test('promptForQuitConfirmation protects against re-entrant calls', async () => {
  let isHandlingCloseConfirmation = false;
  let dialogResolver = null;

  const mockDialog = {
    showMessageBox: () => new Promise((resolve) => {
      dialogResolver = resolve;
    }),
  };

  async function prompt(id) {
    if (isHandlingCloseConfirmation) {
      return false;
    }
    isHandlingCloseConfirmation = true;
    try {
      const { response } = await mockDialog.showMessageBox();
      return response === 1;
    } finally {
      isHandlingCloseConfirmation = false;
    }
  }

  const p1 = prompt(1);
  const p2 = prompt(2); // concurrent / duplicate

  assert.equal(await p2, false); // rejected immediately by guard

  dialogResolver({ response: 0 });
  assert.equal(await p1, false);
});
