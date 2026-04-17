import React, { useState, useEffect } from 'react';
import api from '../api';

export default function HomePage({ onNavigate }) {
  const [settings, setSettings] = useState({});
  const [stats, setStats] = useState({});
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, st, h] = await Promise.all([api.getSettings(), api.getHistoryStats(), api.getHistory()]);
        if (!cancelled) { setSettings(s); setStats(st); setHistory(h || []); }
      } catch (_err) {
        // Home page data load failed
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="page-loading">Loading...</div>;

  const name = settings.display_name || settings.tester_name || 'Tester';
  const recent = (history || []).slice(0, 5);
  const badgeClass = (s) => ({ Pass: 'badge-pass', Fail: 'badge-fail', Incomplete: 'badge-incomplete', 'NC/NS': 'badge-ncns' }[s] || 'badge-ncns');

  return (
    <div data-testid="home-page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className="home-header" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <img src="/logo.png" alt="ACD" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'contain' }} />
          <div>
            <h1 style={{ marginBottom: 0 }}>Welcome, {name}!</h1>
            <p className="text-muted" style={{ margin: 0 }}>Mock Testing Suite — Certification</p>
          </div>
        </div>
      </div>
      <div className="stats-row" style={{ marginBottom: 16 }}>
        <StatCard label="Total Sessions" value={stats.total || 0} />
        <StatCard label="Pass Rate" value={`${stats.pass_rate || 0}%`} color="var(--color-success)" />
        <StatCard label="NC/NS Rate" value={`${stats.total > 0 ? Math.round((stats.ncns || 0) / stats.total * 100) : 0}%`} color="var(--color-danger)" />
      </div>
      <div className="home-actions" style={{ marginBottom: 12 }}>
        <button className="home-btn home-btn-start" onClick={() => onNavigate('basics')} data-testid="home-start-btn">
          {'\uD83D\uDE80'} Start New Session
        </button>
        <button className="home-btn home-btn-sup" onClick={() => onNavigate('basics')} data-testid="home-sup-only-btn">
          {'\uD83D\uDD04'} Supervisor Transfer Only
        </button>
        <button className="home-btn home-btn-history" onClick={() => onNavigate('history')} data-testid="home-history-btn">
          {'\uD83D\uDCCA'} Session History
        </button>
      </div>
      <div className="home-section" style={{ flex: 1, minHeight: 0 }}>
        <h3>Recent Sessions</h3>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {recent.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)' }}>No sessions yet. Start testing to see history here.</div>
          ) : recent.map((s, i) => (
            <div key={i} className="recent-row">
              <span className="recent-date">{s.timestamp || 'Unknown'}</span>
              <span style={{ margin: '0 8px', color: 'var(--text-tertiary)' }}>&bull;</span>
              <span className="recent-name">{s.candidate || 'Unknown'}</span>
              <span className={`badge ${badgeClass(s.status)}`}>{s.status || '?'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : {}}>{value}</div>
    </div>
  );
}
