/**
 * Supabase Auth client for SAM desktop frontend.
 * Direct lightweight REST implementation using publishable anon key.
 */

export async function signInWithPassword(supabaseUrl, anonKey, email, password) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: String(email || '').trim(),
        password: String(password || ''),
      }),
    });
  } catch (networkErr) {
    const error = new Error('Unable to reach the sign-in service.');
    error.code = 'network_failure';
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const isCred = response.status === 400 || (data.error_code === 'invalid_credentials');
    const message = isCred ? 'Email or password is incorrect.' : (data.error_description || data.msg || data.message || 'Email or password is incorrect.');
    const error = new Error(message);
    error.status = response.status;
    error.code = data.error_code || (isCred ? 'invalid_credentials' : 'auth_error');
    throw error;
  }
  return data;
}

const _inFlightRefreshes = new Map();

export async function refreshAuthSession(supabaseUrl, anonKey, refreshToken) {
  if (!refreshToken) return null;
  const cacheKey = `${supabaseUrl}:${refreshToken}`;
  if (_inFlightRefreshes.has(cacheKey)) {
    return _inFlightRefreshes.get(cacheKey);
  }

  const refreshPromise = (async () => {
    const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=refresh_token`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': anonKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return null;
      }
      return data;
    } catch (_networkErr) {
      return null;
    } finally {
      _inFlightRefreshes.delete(cacheKey);
    }
  })();

  _inFlightRefreshes.set(cacheKey, refreshPromise);
  return refreshPromise;
}

export async function resetPasswordForEmail(supabaseUrl, anonKey, email, options = {}) {
  const redirectTo = options?.redirectTo || 'smartalertmanager://reset-password';
  const encodedRedirect = encodeURIComponent(redirectTo);
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/recover?redirect_to=${encodedRedirect}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: String(email || '').trim(),
      }),
    });
  } catch (networkErr) {
    const error = new Error('Unable to reach the sign-in service.');
    error.code = 'RECOVERY_REQUEST_FAILED';
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error_description || data.msg || data.message || 'Password reset request failed.';
    const error = new Error(message);
    error.status = response.status;
    error.code = 'RECOVERY_REQUEST_FAILED';
    throw error;
  }
  return { ok: true, code: 'RECOVERY_REQUEST_ACCEPTED', message: 'If an account exists for this email, password reset instructions have been sent.' };
}

export function parseRecoveryUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, error: 'invalid_url', message: 'No recovery link provided.' };
  }

  const trimmed = rawUrl.trim().replace(/^["']+|["']+$/g, '');
  const validPattern = /^(smartalertmanager|sam):\/\/reset-password\/?([?#].*)?$/i;
  if (!validPattern.test(trimmed)) {
    return { ok: false, error: 'invalid_protocol', message: 'Unrecognized recovery URL format.' };
  }

  const hashIndex = trimmed.indexOf('#');
  const queryIndex = trimmed.indexOf('?');

  const params = new URLSearchParams();

  if (queryIndex !== -1) {
    const queryString = hashIndex !== -1 && hashIndex > queryIndex
      ? trimmed.substring(queryIndex + 1, hashIndex)
      : trimmed.substring(queryIndex + 1);
    const qParams = new URLSearchParams(queryString);
    for (const [k, v] of qParams.entries()) {
      params.set(k, v);
    }
  }

  if (hashIndex !== -1) {
    const hashString = trimmed.substring(hashIndex + 1);
    const hParams = new URLSearchParams(hashString);
    for (const [k, v] of hParams.entries()) {
      params.set(k, v);
    }
  }

  const error = params.get('error');
  const errorCode = params.get('error_code') || params.get('errorCode');
  const errorDescription = params.get('error_description') || params.get('errorDescription');

  if (error || errorCode) {
    const isExpired = errorCode === 'otp_expired' || String(errorDescription || '').toLowerCase().includes('expired');
    return {
      ok: false,
      error: errorCode || error || 'recovery_error',
      isExpired,
      message: isExpired
        ? 'This password-reset link is no longer valid. Request a new reset email.'
        : 'The password-reset link could not be verified. Request a new reset email.',
    };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const type = params.get('type');
  const code = params.get('code');

  if (accessToken) {
    return {
      ok: true,
      type: type || 'recovery',
      accessToken,
      refreshToken: refreshToken || '',
      expiresIn: Number(params.get('expires_in') || 3600),
      tokenType: params.get('token_type') || 'bearer',
    };
  }

  if (code) {
    return {
      ok: true,
      type: 'pkce_code',
      code,
    };
  }

  return {
    ok: false,
    error: 'missing_token',
    message: 'The recovery link did not contain valid authentication credentials. Request a new reset email.',
  };
}

export async function updateUserPassword(supabaseUrl, anonKey, accessToken, newPassword) {
  if (!accessToken) {
    const err = new Error('No active recovery session. Please request a new reset email.');
    err.code = 'missing_session';
    throw err;
  }
  if (!newPassword || newPassword.length < 6) {
    const err = new Error('Password must be at least 6 characters long.');
    err.code = 'invalid_password';
    throw err;
  }

  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        password: String(newPassword),
      }),
    });
  } catch (networkErr) {
    const err = new Error('Unable to reach the sign-in service.');
    err.code = 'network_failure';
    throw err;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data.error_description || data.msg || data.message || 'Failed to update password.';
    const err = new Error(msg);
    err.status = response.status;
    err.code = data.error_code || 'update_failed';
    throw err;
  }

  return { ok: true, user: data };
}

export async function updateUserAccount(supabaseUrl, anonKey, accessToken, updates) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates || {}),
    });
  } catch (networkErr) {
    const error = new Error('Unable to reach the server.');
    error.code = 'network_failure';
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error_description || data.msg || data.message || 'Account update failed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function signOutAuth(supabaseUrl, anonKey, accessToken) {
  if (!accessToken) return { ok: true };
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/logout`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': anonKey,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  } catch (_ignored) {
    // Graceful logout even if network is offline
  }
  return { ok: true };
}
