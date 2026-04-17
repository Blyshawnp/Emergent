import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';

const LOGO_SRC = 'logo.png';
const SUP_ONLY_MODE_KEY = 'mts_sup_transfer_only_mode';

function canResumeForSupTransfer(entry, testerName) {
  const matchesTester = (entry.tester_name || '').trim().toLowerCase() === (testerName || '').trim().toLowerCase();
  const hasMockCalls = Boolean(entry.call_1 || entry.call_2 || entry.call_3);
  const hasSupTransfers = Boolean(entry.sup_transfer_1 || entry.sup_transfer_2);
  return matchesTester && hasMockCalls && !hasSupTransfers;
}

function buildResumedSession(entry) {
  return {
    candidate_name: entry.candidate_name || entry.candidate || '',
    tester_name: entry.tester_name || '',
    pronoun: entry.pronoun || '',
    final_attempt: !!entry.final_attempt,
    supervisor_only: true,
    status: 'In Progress',
    auto_fail_reason: null,
    tech_issue: entry.tech_issue || 'N/A',
    headset_usb: entry.headset_usb ?? null,
    headset_brand: entry.headset_brand || '',
    noise_cancel: entry.noise_cancel ?? null,
    vpn_on: entry.vpn_on ?? null,
    vpn_off: entry.vpn_off ?? null,
    chrome_default: entry.chrome_default ?? null,
    extensions_disabled: entry.extensions_disabled ?? null,
    popups_allowed: entry.popups_allowed ?? null,
    call_1: entry.call_1 || null,
    call_2: entry.call_2 || null,
    call_3: entry.call_3 || null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: true,
    newbie_shift_data: null,
    final_status: null,
    last_saved: null,
    tech_issues_log: [],
  };
}

export default function HomePage({ onNavigate }) {
  const modal = useModal();
  const [settings, setSettings] = useState({});
  const [stats, setStats] = useState({});
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [resumeEntry, setResumeEntry] = useState(null);

  const testerName = settings.tester_name || '';
  const resumableHistory = useMemo(
    () => history
      .filter((entry) => canResumeForSupTransfer(entry, testerName))
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')),
    [history, testerName]
  );

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

  const startStandardSession = () => {
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    onNavigate('basics');
  };

  const startFreshSupTransferOnly = () => {
    window.sessionStorage.setItem(SUP_ONLY_MODE_KEY, '1');
    onNavigate('basics');
  };

  const handleSupTransferOnly = async () => {
    const hasPriorSession = await modal.confirm(
      'Supervisor Transfer Only',
      'Did you previously conduct the mock call session for this candidate?'
    );

    if (!hasPriorSession) {
      startFreshSupTransferOnly();
      return;
    }

    if (!testerName.trim()) {
      await modal.warning('Tester Missing', 'Set your tester name in Settings before resuming a Supervisor Transfer session.');
      return;
    }

    if (resumableHistory.length === 0) {
      await modal.warning('No Matching Sessions', `No prior mock-call sessions were found for tester <b>${testerName}</b>.`);
      return;
    }

    setResumeEntry(resumableHistory[0]);
  };

  const handleResumeConfirm = async () => {
    if (!resumeEntry) return;

    const confirmed = await modal.confirm(
      'Confirm Resume',
      `Continue with <b>${resumeEntry.candidate || resumeEntry.candidate_name || 'this candidate'}</b> Supervisor Transfer?`
    );
    if (!confirmed) return;

    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await api.startSession(buildResumedSession(resumeEntry));
    setResumeEntry(null);
    onNavigate('suptransfer');
  };

  return (
    <div data-testid="home-page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className="home-header" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <img src={LOGO_SRC} alt="ACD" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'contain' }} />
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
        <button className="home-btn home-btn-start" onClick={startStandardSession} data-testid="home-start-btn">
          {'\uD83D\uDE80'} Start New Session
        </button>
        <button className="home-btn home-btn-sup" onClick={handleSupTransferOnly} data-testid="home-sup-only-btn">
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

      {resumeEntry && (
        <ResumeSupTransferModal
          entries={resumableHistory}
          selectedEntry={resumeEntry}
          onSelect={setResumeEntry}
          onClose={() => setResumeEntry(null)}
          onConfirm={handleResumeConfirm}
        />
      )}
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

function ResumeSupTransferModal({ entries, selectedEntry, onSelect, onClose, onConfirm }) {
  const [search, setSearch] = useState('');
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const candidateName = (entry.candidate || entry.candidate_name || '').toLowerCase();
      const timestamp = (entry.timestamp || '').toLowerCase();
      return candidateName.includes(query) || timestamp.includes(query);
    });
  }, [entries, search]);

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 760, maxHeight: '85vh' }}>
        <div className="modal-header">
          <h2>Resume Supervisor Transfer</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" style={{ paddingTop: 0 }}>
          <p className="text-muted" style={{ marginBottom: 16 }}>
            Select the prior mock-call session to continue from.
          </p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by candidate or date..."
            style={{ marginBottom: 16, width: '100%' }}
            data-testid="resume-sup-search"
          />
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="hist-table">
              <thead>
                <tr><th></th><th>Date</th><th>Candidate</th><th>Calls</th><th>Status</th></tr>
              </thead>
              <tbody>
                {filteredEntries.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                      No prior sessions match that search.
                    </td>
                  </tr>
                )}
                {filteredEntries.map((entry, index) => {
                  const candidateName = entry.candidate || entry.candidate_name || 'Unknown';
                  const completedCalls = [entry.call_1, entry.call_2, entry.call_3].filter((call) => call && call.result).length;
                  return (
                    <tr key={`${candidateName}-${entry.timestamp || index}`} className="hist-row">
                      <td style={{ width: 44 }}>
                        <input
                          type="radio"
                          name="resume-sup-transfer"
                          checked={selectedEntry === entry}
                          onChange={() => onSelect(entry)}
                          data-testid={`resume-entry-${index}`}
                        />
                      </td>
                      <td className="hist-date">{entry.timestamp || 'Unknown'}</td>
                      <td className="hist-name">{candidateName}</td>
                      <td>{completedCalls}</td>
                      <td><span className="badge badge-incomplete">{entry.status || 'Saved'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
          <button className="btn btn-muted" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} data-testid="resume-sup-confirm">Continue</button>
        </div>
      </div>
    </div>
  );
}
