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

  test('resetPasswordForEmail', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const res = await resetPasswordForEmail(mockUrl, mockKey, 'test@example.com');
    expect(res.ok).toBe(true);
  });

  test('updateUserAccount', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'u-1', email: 'new@example.com' }),
    });

    const res = await updateUserAccount(mockUrl, mockKey, 'at-123', { email: 'new@example.com' });
    expect(res.email).toBe('new@example.com');
  });

  test('signOutAuth handles offline gracefully', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    const res = await signOutAuth(mockUrl, mockKey, 'at-123');
    expect(res.ok).toBe(true);
  });
});
