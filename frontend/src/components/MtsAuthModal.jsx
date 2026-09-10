import React, { useState, useRef, useEffect } from 'react';
import { Lock, Mail, AlertTriangle, LogIn, LogOut, CheckCircle } from 'lucide-react';
import api, { setMtsAuthToken } from '../api';
import { signInWithPassword, refreshAuthSession } from '../utils/supabaseAuth';

export default function MtsAuthModal({ isOpen, onClose, onAuthSuccess, authSession, onSignOut }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const submitInFlightRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      setError('');
      setStatusMessage('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSubmitting(true);
    setError('');
    setStatusMessage('');

    try {
      const configRes = await api.getMtsAuthConfig();
      const supabaseUrl = configRes?.supabase_url;
      const anonKey = configRes?.supabase_anon_key;
      if (!supabaseUrl || !anonKey) {
        setError('Unable to reach the authentication service.');
        return;
      }

      // Step 1: Direct sign-in with password via Supabase Auth (publishable key only)
      const session = await signInWithPassword(supabaseUrl, anonKey, email.trim(), password);
      const authUser = session?.user || session;
      const authUid = authUser?.id;
      const accessToken = session?.access_token;

      if (!authUid || !accessToken) {
        setError('Email or password is incorrect.');
        return;
      }

      // Step 2: Early entitlement check via verify_mts_authorization
      setMtsAuthToken(accessToken);
      const verifyRes = await api.verifyMtsAuth();

      if (!verifyRes?.ok) {
        setMtsAuthToken('');
        const code = verifyRes?.error_code || verifyRes?.errorCode;
        if (code === 'inactive_account') {
          setError('Your account is inactive.');
        } else if (code === 'insufficient_role' || code === 'unauthorized_account') {
          setError('Your account does not currently have access to Mock Testing Suite.');
        } else {
          setError(verifyRes?.error || 'Your account is not authorized for Mock Testing Suite.');
        }
        return;
      }

      // Step 3: Save encrypted session to Electron safeStorage
      if (window.electronAPI?.mtsAuthSession?.save) {
        await window.electronAPI.mtsAuthSession.save(session);
      }

      setStatusMessage('Signed in successfully.');
      onAuthSuccess?.(session, verifyRes);
      onClose?.();
    } catch (err) {
      setMtsAuthToken('');
      const msg = String(err?.message || '');
      if (msg.includes('network') || err?.code === 'network_failure') {
        setError('Unable to reach the sign-in service. Check network connection.');
      } else {
        setError(msg || 'Email or password is incorrect.');
      }
    } finally {
      setSubmitting(false);
      submitInFlightRef.current = false;
    }
  };

  const handleSignOutClick = async () => {
    setMtsAuthToken('');
    if (window.electronAPI?.mtsAuthSession?.clear) {
      await window.electronAPI.mtsAuthSession.clear();
    }
    onSignOut?.();
    onClose?.();
  };

  const isAuthenticated = Boolean(authSession?.access_token);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="MTS Evaluator Authentication">
      <div className="modal-content" style={{ maxWidth: 440, padding: 24, borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Lock size={20} color="#3b82f6" />
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
              {isAuthenticated ? 'Evaluator Account' : 'Evaluator Sign In'}
            </h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dialog">&times;</button>
        </div>

        {isAuthenticated ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)', borderRadius: 8, marginBottom: 16 }}>
              <CheckCircle size={18} color="#22c55e" />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#22c55e' }}>Authenticated Evaluator</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #94a3b8)' }}>{authSession?.user?.email || 'Logged in'}</div>
              </div>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary, #94a3b8)', marginBottom: 20 }}>
              Your session is active. Completed certifications will be authoritatively saved to shared candidate history.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
              <button type="button" className="btn btn-danger" onClick={handleSignOutClick} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <LogOut size={15} /> Sign Out
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary, #94a3b8)', marginBottom: 16 }}>
              Sign in with your authorized evaluator credentials to sync completed candidate sessions.
            </p>

            {error && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: 8, marginBottom: 14, color: '#f87171', fontSize: 13 }}>
                <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                <span>{error}</span>
              </div>
            )}

            {statusMessage && (
              <div style={{ padding: '10px 12px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)', borderRadius: 8, marginBottom: 14, color: '#22c55e', fontSize: 13 }}>
                {statusMessage}
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary, #e2e8f0)' }}>Email Address</label>
              <div style={{ position: 'relative' }}>
                <Mail size={15} style={{ position: 'absolute', left: 12, top: 12, color: '#64748b' }} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="evaluator@example.com"
                  style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 8, border: '1px solid var(--border-subtle, #334155)', background: 'var(--bg-input, #1e293b)', color: '#fff', fontSize: 14 }}
                  disabled={submitting}
                />
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary, #e2e8f0)' }}>Password</label>
              <div style={{ position: 'relative' }}>
                <Lock size={15} style={{ position: 'absolute', left: 12, top: 12, color: '#64748b' }} />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 8, border: '1px solid var(--border-subtle, #334155)', background: 'var(--bg-input, #1e293b)', color: '#fff', fontSize: 14 }}
                  disabled={submitting}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={submitting} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <LogIn size={15} /> {submitting ? 'Signing In...' : 'Sign In'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
