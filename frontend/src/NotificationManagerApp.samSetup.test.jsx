import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SamSetupWizard, getSamSetupErrorMessage } from './NotificationManagerApp';

const mockCompleteSamSetup = jest.fn();

jest.mock('./api', () => ({
  __esModule: true,
  default: {
    completeSamSetup: (...args) => mockCompleteSamSetup(...args),
  },
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function changeInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderWizard(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SamSetupWizard status={{}} {...props} />);
    await flushPromises();
  });
  return { container, root };
}

async function fillAndSubmit(container, name = 'Admin Example', pin = '1234') {
  const [nameInput, pinInput] = container.querySelectorAll('input');
  await act(async () => {
    changeInput(nameInput, name);
    changeInput(pinInput, pin);
  });
  await act(async () => {
    container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  return { nameInput, pinInput };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockCompleteSamSetup.mockReset();
  window.electronAPI = { getDeviceName: jest.fn(() => 'Desk PC') };
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('setup error mapping never displays raw backend or exception text', () => {
  expect(getSamSetupErrorMessage({ errorCode: 'setup_invalid_pin', error: 'PIN mismatch for private admin' }))
    .toBe('The administrator name or PIN was not recognized.');
  expect(getSamSetupErrorMessage({ error: "'NoneType' object has no attribute 'spreadsheets'" }))
    .toBe('SAM could not verify your assigned access. Please try again or contact support.');
});

test('invalid PIN keeps both fields populated and allows a successful retry', async () => {
  const onComplete = jest.fn();
  mockCompleteSamSetup
    .mockResolvedValueOnce({ ok: false, errorCode: 'setup_invalid_pin', error: 'raw detail' })
    .mockResolvedValueOnce({ ok: true, name: 'Admin Example', role: 'owner' });
  const view = await renderWizard({ onComplete });

  const fields = await fillAndSubmit(view.container);
  expect(view.container.textContent).toContain('The administrator name or PIN was not recognized.');
  expect(view.container.textContent).not.toContain('raw detail');
  expect(fields.nameInput.value).toBe('Admin Example');
  expect(fields.pinInput.value).toBe('1234');

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  expect(onComplete).toHaveBeenCalledWith({ ok: true, name: 'Admin Example', role: 'owner' });
  expect(mockCompleteSamSetup).toHaveBeenCalledTimes(2);
});

test('double submission while verification is pending invokes setup once', async () => {
  let resolveSetup;
  mockCompleteSamSetup.mockImplementation(() => new Promise((resolve) => { resolveSetup = resolve; }));
  const view = await renderWizard();
  const [nameInput, pinInput] = view.container.querySelectorAll('input');
  await act(async () => {
    changeInput(nameInput, 'Admin Example');
    changeInput(pinInput, '1234');
  });

  await act(async () => {
    const form = view.container.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  expect(mockCompleteSamSetup).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveSetup({ ok: true, name: 'Admin Example', role: 'owner' });
    await flushPromises();
  });
});
