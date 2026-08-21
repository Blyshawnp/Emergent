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

jest.mock('./utils/supabaseAuth', () => {
  const actual = jest.requireActual('./utils/supabaseAuth');
  return {
    __esModule: true,
    signInWithPassword: jest.fn(),
    resetPasswordForEmail: jest.fn().mockResolvedValue({ ok: true }),
    updateUserAccount: jest.fn().mockResolvedValue({ ok: true }),
    updateUserPassword: jest.fn().mockResolvedValue({ ok: true }),
    signOutAuth: jest.fn().mockResolvedValue({ ok: true }),
    parseRecoveryUrl: actual.parseRecoveryUrl,
  };
});

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

  expect(view.container.textContent).toContain('Email or password is incorrect.');
  expect(view.container.textContent).not.toContain('500');
});

test('Supabase sign-in displays clean network error on connection failure', async () => {
  signInWithPassword.mockRejectedValueOnce(Object.assign(new Error('Network error'), { code: 'network_failure' }));

  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Unable to reach the sign-in service.');
  expect(view.container.textContent).not.toContain('500');
});

test('Supabase sign-in displays clean error on inactive account', async () => {
  mockVerifySamAuth.mockResolvedValueOnce({
    ok: false,
    error_code: 'inactive_account',
    error: 'This SAM account is inactive.',
  });

  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'inactive@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('This SAM account is inactive.');
});

test('Supabase sign-in displays clean error on unlinked account', async () => {
  mockVerifySamAuth.mockResolvedValueOnce({
    ok: false,
    error_code: 'unauthorized_account',
    error: 'This account is not authorized for Smart Alert Manager.',
  });

  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'unlinked@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('This account is not authorized for Smart Alert Manager.');
});

test('Supabase sign-in converts unexpected 500 error to user-safe message', async () => {
  mockVerifySamAuth.mockRejectedValueOnce(new Error('Request failed with status code 500'));

  const view = await renderWizard();
  const [emailInput, passwordInput] = view.container.querySelectorAll('input');

  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
    changeInput(passwordInput, 'correctpassword');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Sign in could not be completed. Please try again.');
  expect(view.container.textContent).not.toContain('Request failed with status code 500');
});

test('Forgot password mode requests recovery link and shows privacy-safe message', async () => {
  const { resetPasswordForEmail } = require('./utils/supabaseAuth');
  resetPasswordForEmail.mockResolvedValueOnce({ ok: true, code: 'RECOVERY_REQUEST_ACCEPTED' });
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
    'shawn@example.com',
    { redirectTo: 'smartalertmanager://reset-password' }
  );
  expect(view.container.textContent).toContain('If an account exists for this email, password reset instructions have been sent.');
});

test('Forgot password mode displays clean network error on offline failure', async () => {
  const { resetPasswordForEmail } = require('./utils/supabaseAuth');
  resetPasswordForEmail.mockRejectedValueOnce(Object.assign(new Error('Network error'), { code: 'RECOVERY_REQUEST_FAILED' }));
  const view = await renderWizard();

  // Click Forgot Password link
  const forgotBtn = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent.includes('Forgot Password?'));
  await act(async () => {
    forgotBtn.click();
    await flushPromises();
  });

  const emailInput = view.container.querySelector('input[type="email"]');
  await act(async () => {
    changeInput(emailInput, 'shawn@example.com');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Unable to reach the sign-in service.');
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

test('Receiving valid recovery deep link switches to Reset Password form and updates password successfully', async () => {
  const { updateUserPassword, signOutAuth } = require('./utils/supabaseAuth');
  let eventCallback = null;
  window.electronAPI.onAppEvent = jest.fn((cb) => {
    eventCallback = cb;
    return () => {};
  });

  const view = await renderWizard();
  expect(view.container.textContent).toContain('SAM AUTHENTICATION');

  // Simulate receiving smartalertmanager:// deep link
  await act(async () => {
    eventCallback('auth:deep-link', {
      url: 'smartalertmanager://reset-password#access_token=valid-recov-token&refresh_token=valid-refresh&type=recovery',
    });
    await flushPromises();
  });

  // Verify Reset Password mode is rendered
  expect(view.container.textContent).toContain('Reset Password');
  const newPassInput = view.container.querySelector('[data-testid="reset-new-password-input"]');
  const confirmPassInput = view.container.querySelector('[data-testid="reset-confirm-password-input"]');
  expect(newPassInput).toBeDefined();
  expect(confirmPassInput).toBeDefined();

  // Test password mismatch
  await act(async () => {
    changeInput(newPassInput, 'newpassword123');
    changeInput(confirmPassInput, 'mismatch123');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Passwords do not match');

  // Fix password confirmation and submit
  updateUserPassword.mockResolvedValueOnce({ ok: true, user: { id: 'user-1' } });
  signOutAuth.mockResolvedValueOnce({ ok: true });

  await act(async () => {
    changeInput(confirmPassInput, 'newpassword123');
  });

  await act(async () => {
    view.container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  expect(updateUserPassword).toHaveBeenCalledWith(
    'https://xyfhikikddcqcmzbdvbj.supabase.co',
    'mock-anon-key',
    'valid-recov-token',
    'newpassword123'
  );
  expect(signOutAuth).toHaveBeenCalledWith(
    'https://xyfhikikddcqcmzbdvbj.supabase.co',
    'mock-anon-key',
    'valid-recov-token'
  );

  // Verifies return to normal Sign In with success message
  expect(view.container.textContent).toContain('Password updated successfully. Please sign in with your new password.');
});

test('Receiving expired recovery deep link displays Link Invalid or Expired with request reset option', async () => {
  let eventCallback = null;
  window.electronAPI.onAppEvent = jest.fn((cb) => {
    eventCallback = cb;
    return () => {};
  });

  const view = await renderWizard();

  // Simulate receiving expired link
  await act(async () => {
    eventCallback('auth:deep-link', {
      url: 'smartalertmanager://reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    });
    await flushPromises();
  });

  expect(view.container.textContent).toContain('Link Invalid or Expired');
  expect(view.container.textContent).toContain('no longer valid');

  const requestNewBtn = view.container.querySelector('[data-testid="request-new-reset-btn"]');
  expect(requestNewBtn).toBeDefined();

  // Click request new button -> moves to forgot password form
  await act(async () => {
    requestNewBtn.click();
    await flushPromises();
  });

  expect(view.container.textContent).toContain('PASSWORD RECOVERY');
  expect(view.container.querySelector('[data-testid="forgot-password-email-input"]')).toBeDefined();
});
