/**
 * Supabase Auth client for SAM desktop frontend.
 * Direct lightweight REST implementation using publishable anon key.
 */

export async function signInWithPassword(supabaseUrl, anonKey, email, password) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`;
  const response = await fetch(url, {
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

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error_description || data.msg || data.message || 'Invalid email or password.';
    const error = new Error(message);
    error.status = response.status;
    error.code = data.error_code || data.code;
    throw error;
  }
  return data;
}

export async function refreshAuthSession(supabaseUrl, anonKey, refreshToken) {
  if (!refreshToken) return null;
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=refresh_token`;
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
}

export async function resetPasswordForEmail(supabaseUrl, anonKey, email) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/recover`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: String(email || '').trim(),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error_description || data.msg || data.message || 'Password reset request failed.';
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return { ok: true, message: 'Password recovery email sent if account exists.' };
}

export async function updateUserAccount(supabaseUrl, anonKey, accessToken, updates) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'apikey': anonKey,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates || {}),
  });

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
