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

export async function refreshAuthSession(supabaseUrl, anonKey, refreshToken) {
  if (!refreshToken) return null;
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
  }
}

export async function resetPasswordForEmail(supabaseUrl, anonKey, email) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/recover`;
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
