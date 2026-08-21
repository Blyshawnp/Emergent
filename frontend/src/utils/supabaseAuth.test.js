import {
  signInWithPassword,
  refreshAuthSession,
  resetPasswordForEmail,
  updateUserAccount,
  signOutAuth,
} from './supabaseAuth';

describe('supabaseAuth REST client', () => {
  const mockUrl = 'https://mock.supabase.co';
  const mockKey = 'mock-anon-key';

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('signInWithPassword success', async () => {
    const mockResponse = {
      access_token: 'at-123',
      refresh_token: 'rt-123',
      user: { id: 'u-123', email: 'test@example.com' },
    };
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await signInWithPassword(mockUrl, mockKey, 'test@example.com', 'secret');
    expect(result.access_token).toBe('at-123');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock.supabase.co/auth/v1/token?grant_type=password',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'apikey': mockKey }),
        body: JSON.stringify({ email: 'test@example.com', password: 'secret' }),
      })
    );
  });

  test('signInWithPassword error handling', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error_description: 'Invalid login credentials' }),
    });

    await expect(signInWithPassword(mockUrl, mockKey, 'test@example.com', 'wrong'))
      .rejects.toThrow('Email or password is incorrect.');
  });

  test('refreshAuthSession success and failure', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-at', refresh_token: 'new-rt' }),
    });

    const res = await refreshAuthSession(mockUrl, mockKey, 'old-rt');
    expect(res.access_token).toBe('new-at');

    global.fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });
    const failed = await refreshAuthSession(mockUrl, mockKey, 'bad-rt');
    expect(failed).toBeNull();
  });

  test('resetPasswordForEmail with custom redirectTo', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const res = await resetPasswordForEmail(mockUrl, mockKey, 'test@example.com', {
      redirectTo: 'smartalertmanager://reset-password',
    });
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock.supabase.co/auth/v1/recover?redirect_to=smartalertmanager%3A%2F%2Freset-password',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'apikey': mockKey }),
        body: JSON.stringify({ email: 'test@example.com' }),
      })
    );
  });

  test('updateUserAccount', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'u-1', email: 'new@example.com' }),
    });

    const res = await updateUserAccount(mockUrl, mockKey, 'at-123', { email: 'new@example.com' });
    expect(res.email).toBe('new@example.com');
  });

  test('updateUserPassword success and validation', async () => {
    const { updateUserPassword } = require('./supabaseAuth');
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'u-1' }),
    });

    const res = await updateUserPassword(mockUrl, mockKey, 'recov-token-123', 'newsecurepass');
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://mock.supabase.co/auth/v1/user',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'apikey': mockKey,
          'Authorization': 'Bearer recov-token-123',
        }),
        body: JSON.stringify({ password: 'newsecurepass' }),
      })
    );

    await expect(updateUserPassword(mockUrl, mockKey, 'recov-token-123', '123'))
      .rejects.toThrow('Password must be at least 6 characters long.');

    await expect(updateUserPassword(mockUrl, mockKey, null, 'newsecurepass'))
      .rejects.toThrow('No active recovery session. Please request a new reset email.');
  });

  test('parseRecoveryUrl handles valid hash and query params for smartalertmanager and sam', () => {
    const { parseRecoveryUrl } = require('./supabaseAuth');

    // smartalertmanager:// with hash fragment
    const url1 = 'smartalertmanager://reset-password#access_token=token-abc&refresh_token=refresh-xyz&type=recovery&expires_in=3600';
    const parsed1 = parseRecoveryUrl(url1);
    expect(parsed1.ok).toBe(true);
    expect(parsed1.accessToken).toBe('token-abc');
    expect(parsed1.refreshToken).toBe('refresh-xyz');
    expect(parsed1.type).toBe('recovery');

    // sam:// with hash fragment
    const url2 = 'sam://reset-password#access_token=token-def&refresh_token=refresh-uvw&type=recovery';
    const parsed2 = parseRecoveryUrl(url2);
    expect(parsed2.ok).toBe(true);
    expect(parsed2.accessToken).toBe('token-def');
    expect(parsed2.refreshToken).toBe('refresh-uvw');

    // PKCE code in query param
    const url3 = 'smartalertmanager://reset-password?code=auth-code-123';
    const parsed3 = parseRecoveryUrl(url3);
    expect(parsed3.ok).toBe(true);
    expect(parsed3.type).toBe('pkce_code');
    expect(parsed3.code).toBe('auth-code-123');

    // Trailing slash with hash fragment
    const url1WithSlash = 'smartalertmanager://reset-password/#access_token=token-abc&refresh_token=refresh-xyz&type=recovery';
    const parsed1Slash = parseRecoveryUrl(url1WithSlash);
    expect(parsed1Slash.ok).toBe(true);
    expect(parsed1Slash.accessToken).toBe('token-abc');

    // Quoted URL from Windows shell
    const urlQuoted = '"smartalertmanager://reset-password/#access_token=token-abc&refresh_token=refresh-xyz&type=recovery"';
    const parsedQuoted = parseRecoveryUrl(urlQuoted);
    expect(parsedQuoted.ok).toBe(true);
    expect(parsedQuoted.accessToken).toBe('token-abc');

    // sam:// with trailing slash and query param
    const url2WithSlash = 'sam://reset-password/?code=auth-code-456';
    const parsed2Slash = parseRecoveryUrl(url2WithSlash);
    expect(parsed2Slash.ok).toBe(true);
    expect(parsed2Slash.code).toBe('auth-code-456');

    // Expired OTP in hash
    const url4 = 'smartalertmanager://reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
    const parsed4 = parseRecoveryUrl(url4);
    expect(parsed4.ok).toBe(false);
    expect(parsed4.isExpired).toBe(true);
    expect(parsed4.message).toContain('no longer valid');

    // Expired OTP with trailing slash
    const url4Slash = 'smartalertmanager://reset-password/#error=access_denied&error_code=otp_expired';
    const parsed4Slash = parseRecoveryUrl(url4Slash);
    expect(parsed4Slash.ok).toBe(false);
    expect(parsed4Slash.isExpired).toBe(true);

    // Expired in query params
    const url5 = 'smartalertmanager://reset-password?error=access_denied&error_description=expired';
    const parsed5 = parseRecoveryUrl(url5);
    expect(parsed5.ok).toBe(false);
    expect(parsed5.isExpired).toBe(true);

    // Invalid scheme / protocol
    const url6 = 'https://evil.com/reset-password#access_token=token-abc';
    const parsed6 = parseRecoveryUrl(url6);
    expect(parsed6.ok).toBe(false);
    expect(parsed6.error).toBe('invalid_protocol');

    // Invalid path
    const url7 = 'smartalertmanager://execute-command?cmd=calc';
    const parsed7 = parseRecoveryUrl(url7);
    expect(parsed7.ok).toBe(false);
    expect(parsed7.error).toBe('invalid_protocol');

    // Empty / null
    expect(parseRecoveryUrl(null).ok).toBe(false);
    expect(parseRecoveryUrl('').ok).toBe(false);
  });

  test('signOutAuth handles offline gracefully', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    const res = await signOutAuth(mockUrl, mockKey, 'at-123');
    expect(res.ok).toBe(true);
  });
});
