import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';

export default function HistoryPage({ onNavigate, navigationState }) {
  const modal = useModal();
  const [stats, setStats] = useState({});
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    try {
      const [st, h] = await Promise.all([api.getHistoryStats(), api.getHistory()]);
      setStats(st); setHistory(h || []);
    } catch (_err) {
      // History data load failed — table remains empty
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (navigationState?.selectedHistoryRecord) {
      setDetail(navigationState.selectedHistoryRecord);
    }
  }, [navigationState]);

  const filtered = history.filter(s => (s.candidate || '').toLowerCase().includes(search.toLowerCase()));
  const badgeClass = (s) => ({ Pass: 'badge-pass', Fail: 'badge-fail', Incomplete: 'badge-incomplete', 'NC/NS': 'badge-ncns' }[s] || 'badge-ncns');

  const colorResult = (r) => {
    if (r === 'Pass') return <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>PASS</span>;
    if (r === 'Fail') return <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>FAIL</span>;
    return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  };

  const extractChecked = (obj) => {
    if (!obj) return [];
    return Object.entries(obj).filter(([k, v]) => v && k !== 'Other').map(([k]) => k);
  };

  const handleHistoricalFillForm = async (record) => {
    try {
      const coaching = (record?.coaching_summary || '').trim();
      const failSummary = (record?.fail_summary || '').trim();
      const response = await api.fillForm(coaching, failSummary, record);
      if (response.ok) {
        await modal.alert('Form Filled', response.message, 'check-circle', 'success');
        return;
      }
      await modal.error('Form Fill Failed', response.message || 'Unable to send this historical session to the Cert Form.');
    } catch (error) {
      await modal.error('Form Fill Failed', error.message || 'Unable to send this historical session to the Cert Form.');
    }
  };

  return (
    <div data-testid="history-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1>Session History</h1>
        <button className="btn btn-danger btn-sm" onClick={async () => {
          if (history.length === 0) { await modal.warning('Notice', 'No history to clear.'); return; }
          const c = await modal.confirmDanger('Clear History', `This will permanently delete ${history.length} session records. This cannot be undone.`);
          if (!c) return;
          if (!await modal.confirm('Confirm', 'This cannot be undone. Are you absolutely sure?')) return;
          await api.clearHistory(); await modal.alert('Cleared', 'Session history has been cleared.'); load();
        }} data-testid="history-clear">Clear All History</button>
      </div>

      <div className="stats-row" style={{ marginBottom: 24 }}>
        <SC label="Total" value={stats.total} />
        <SC label="Passed" value={stats.passes} color="var(--color-success)" />
        <SC label="Failed" value={stats.fails} color="var(--color-danger)" />
        <SC label="NC/NS" value={stats.ncns} color="var(--text-tertiary)" />
        <SC label="Incomplete" value={stats.incomplete} color="var(--color-warning)" />
        <SC label="Pass Rate" value={`${stats.pass_rate || 0}%`} color="var(--color-success)" />
      </div>

      <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by candidate name..." style={{ marginBottom: 16, maxWidth: 400 }} data-testid="history-search" />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-tertiary)' }}>No session history yet.</div>
        ) : (
          <table className="hist-table">
            <thead><tr><th>Date</th><th>Candidate</th><th>Tester</th><th>Status</th><th style={{ width: 70 }}></th></tr></thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={i} className="hist-row">
                  <td className="hist-date">{s.timestamp || 'Unknown'}</td>
                  <td className="hist-name">{s.candidate || 'Unknown'}</td>
                  <td className="hist-tester">{s.tester_name || ''}</td>
                  <td><span className={`badge ${badgeClass(s.status)}`}>{s.status || '?'}</span></td>
                  <td><button className="btn btn-primary btn-sm" onClick={() => setDetail(s)} data-testid={`history-view-${i}`}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <div className="modal-overlay open" onClick={e => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="modal" style={{ width: 700, maxHeight: '85vh' }}>
            <div className="modal-header">
              <h2>{detail.candidate || 'Unknown'} — <span style={{ color: ({ Pass: 'var(--color-success)', Fail: 'var(--color-danger)', Incomplete: 'var(--color-warning)' }[detail.status]) || 'var(--text-secondary)' }}>{(detail.status || '').toUpperCase()}</span></h2>
              <button className="modal-close" onClick={() => setDetail(null)}>&times;</button>
            </div>
            <div className="modal-body" style={{ lineHeight: 1.7 }}>
              <div className="text-muted text-sm" style={{ marginBottom: 16 }}>{detail.timestamp || ''}</div>
              <strong>Tester:</strong> {detail.tester_name || 'N/A'}<br />
              {detail.auto_fail_reason && <><strong>Auto-Fail:</strong> <span style={{ color: 'var(--color-danger)' }}>{detail.auto_fail_reason}</span><br /></>}
              {detail.headset_brand && <><strong>Headset:</strong> {detail.headset_brand}<br /></>}
              {[1, 2, 3].map(i => {
                const call = detail[`call_${i}`];
                if (!call || !call.result) return null;
                const coaching = extractChecked(call.coaching);
                const failReasons = extractChecked(call.fails);
                return (
                  <div key={i}>
                    <br /><strong>Call {i}:</strong> {colorResult(call.result)}<br />
                    <span className="text-sm text-muted">&nbsp;&nbsp;Type: {call.type || 'N/A'}, Show: {call.show || 'N/A'}</span><br />
                    {coaching.length > 0 && <span className="text-sm">&nbsp;&nbsp;Coaching: {coaching.join(', ')}</span>}
                    {call.result === 'Fail' && failReasons.length > 0 && <><br /><span className="text-sm" style={{ color: 'var(--color-danger)' }}>&nbsp;&nbsp;Fails: {failReasons.join(', ')}</span></>}
                  </div>
                );
              })}
              {[1, 2].map(i => {
                const sup = detail[`sup_transfer_${i}`];
                if (!sup || !sup.result) return null;
                const coaching = extractChecked(sup.coaching);
                return (
                  <div key={`sup${i}`}>
                    <br /><strong>Sup Transfer {i}:</strong> {colorResult(sup.result)}<br />
                    <span className="text-sm text-muted">&nbsp;&nbsp;Reason: {sup.reason || 'N/A'}</span><br />
                    {coaching.length > 0 && <span className="text-sm">&nbsp;&nbsp;Coaching: {coaching.join(', ')}</span>}
                  </div>
                );
              })}
              {detail.newbie_shift_data && (
                <><br /><strong>Newbie Shift:</strong> {detail.newbie_shift_data.newbie_date} at {detail.newbie_shift_data.newbie_time} {detail.newbie_shift_data.newbie_tz}</>
              )}
            </div>
            <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
              <button className="btn btn-muted" onClick={() => setDetail(null)}>Close</button>
              <button className="btn btn-warning" onClick={() => handleHistoricalFillForm(detail)} data-testid="history-fill-form">Fill Cert Form</button>
              <button
                className="btn btn-primary"
                onClick={() => onNavigate('review', { historyRecord: detail })}
                data-testid="history-open-review"
              >
                Open in Review
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SC({ label, value, color }) {
  return <div className="stat-card"><div className="stat-label">{label}</div><div className="stat-value" style={color ? { color } : {}}>{value ?? 0}</div></div>;
}
