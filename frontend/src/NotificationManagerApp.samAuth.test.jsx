import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SamSetupWizard } from './NotificationManagerApp';
import { signInWithPassword } from './utils/supabaseAuth';

const mockGetSamAuthConfig = jest.fn();
const mockVerifySamAuth = jest.fn();
const mockCompleteSamAuthSetup = jest.fn();
const mockGetSamUserManagementList = jest.fn();
const mockSetSamUserActive = jest.fn();

jest.mock('./api', () => ({
  __esModule: true,
  default: {
    getSamAuthConfig: (...args) => mockGetSamAuthConfig(...args),
    verifySamAuth: (...args) => mockVerifySamAuth(...args),
    completeSamAuthSetup: (...args) => mockCompleteSamAuthSetup(...args),
    getSamUserManagementList: (...args) => mockGetSamUserManagementList(...args),
    setSamUserActive: (...args) => mockSetSamUserActive(...args),
    completeSamSetup: jest.fn(),
  },
}));

jest.mock('./utils/supabaseAuth', () => ({
  __esModule: true,
  signInWithPassword: jest.fn(),
  resetPasswordForEmail: jest.fn().mockResolvedValue({ ok: true }),
  updateUserAccount: jest.fn().mockResolvedValue({ ok: true }),
  signOutAuth: jest.fn().mockResolvedValue({ ok: true }),
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function changeInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function renderWizard(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SamSetupWizard status={{ initialMode: 'supabase' }} {...props} />);
    await flushPromises();
  });
  return { container, root };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockGetSamAuthConfig.mockReset();
  mockVerifySamAuth.mockReset();
  mockCompleteSamAuthSetup.mockReset();
  mockGetSamUserManagementList.mockReset();
  mockSetSamUserActive.mockReset();

  signInWithPassword.mockReset();
  signInWithPassword.mockImplementation(async (url, key, email, password) => {
    if (password === 'wrongpassword') {
      const err = new Error('Invalid login credentials');
      err.status = 400;
      throw err;
    }
    return {
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      user: { id: 'ca4cb01e-0777-435d-8a7c-1f2bcfaed291', email: 'shawn@example.com' },
    };
  });

  mockGetSamAuthConfig.mockResolvedValue({
    ok: true,
    supabase_url: 'https://xyfhikikddcqcmzbdvbj.supabase.co',
    supabase_anon_key: 'mock-anon-key',
  });

  window.electronAPI = {
    getDeviceName: jest.fn(() => 'Desk PC'),
    authSession: {
      save: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      clear: jest.fn().mockResolvedValue(true),
    },
  };
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('Supabase sign-in verifies server-side access and completes setup', async () => {
  const onComplete = jest.fn();
  mockVerifySamAuth.mockResolvedValueOnce({
    ok: true,
    display_name: 'Shawn Bly',
    role: 'administrator',
    is_owner: true,
  });
  mockCompleteSamAuthSetup.mockResolvedValueOnce({ ok: true });

  const view = await renderWizard({ onComplete });
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(mockGetSamAuthConfig).toHaveBeenCalledTimes(1);
  expect(mockVerifySamAuth).toHaveBeenCalledWith('ca4cb01e-0777-435d-8a7c-1f2bcfaed291');
  expect(window.electronAPI.authSession.save).toHaveBeenCalled();
  expect(mockCompleteSamAuthSetup).toHaveBeenCalledWith({
    name: 'Shawn Bly',
    role: 'administrator',
    auth_uid: 'ca4cb01e-0777-435d-8a7c-1f2bcfaed291',
    email: 'shawn@example.com',
  });
  expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
    ok: true,
    name: 'Shawn Bly',
    role: 'administrator',
    isOwner: true,
  }));
});

test('Supabase sign-in fails gracefully on unauthorized account', async () => {
  mockVerifySamAuth.mockResolvedValueOnce({
    ok: false,
    error: 'Your account is not registered for SAM access.',
  });

  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'unauthorized@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Your account is not registered for SAM access.');
  expect(window.electronAPI.authSession.save).not.toHaveBeenCalled();
});

test('Supabase sign-in fails gracefully on invalid credentials', async () => {
  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
    changeInput(passwordInput, 'wrongpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Invalid email or password.');
});

test('Forgot password mode requests recovery link', async () => {
  const { resetPasswordForEmail } = require('./utils/supabaseAuth');
  const view = await renderWizard();

  // Click Forgot Password link
  const forgotBtn = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent.includes('Forgot Password?'));
  expect(forgotBtn).toBeDefined();

  await act(async () => {
    forgotBtn.click();
    await flushPromises();
  });

  expect(view.container.textContent).toContain('PASSWORD RECOVERY');

  const emailInput = view.container.querySelector('input[type="email"]');
  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(resetPasswordForEmail).toHaveBeenCalledWith(
    'https://xyfhikikddcqcmzbdvbj.supabase.co',
    'mock-anon-key',
    'shawn@example.com'
  );
  expect(view.container.textContent).toContain('password reset instructions have been sent');
});

test('Mode switch to legacy PIN setup renders name and pin fields', async () => {
  const view = await renderWizard();

  // Click legacy setup link
  const legacyBtn = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent.includes('Use Legacy PIN Setup'));
  expect(legacyBtn).toBeDefined();

  await act(async () => {
    legacyBtn.click();
    await flushPromises();
  });

  expect(view.container.textContent).toContain('SAM SETUP');
  const inputs = view.container.querySelectorAll('input');
  expect(inputs.length).toBe(2);
  expect(inputs[0].getAttribute('type')).toBe('text');
  expect(inputs[1].getAttribute('type')).toBe('password');
});
