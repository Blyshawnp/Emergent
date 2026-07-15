import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import {
  followUpStatusMeta,
  formFillStatusMeta,
  formatNewbieScheduleParts,
  formatNewbieSchedule,
  NEWBIE_REQUEST_STATUS,
  NEWBIE_REQUEST_TYPE,
  sessionStatusMeta,
} from '../utils/certificationWorkflow';

function adminHistoryControlsEnabled() {
  try {
    return Boolean(window.electronAPI?.getRuntimeFlags?.().adminDiagnosticsEnabled);
  } catch (_) {
    return false;
  }
}

function detailDate(record) {
  return record?.timestamp || record?.completed_at || record?.created_at || record?.displayDate || '';
}

function formRecoveryKey(record) {
  if (!record) return '';
  const identity = [
    record.history_id || '',
    record.timestamp_iso || record.timestamp || '',
    record.tester_name || '',
    record.candidate_name || record.candidate || '',
  ].join('|');
  return identity ? `mts-form-fill-recovery:${identity}` : '';
}

function hasFormRecoveryMarker(record) {
  try {
    const key = formRecoveryKey(record);
    return Boolean(key && window.localStorage.getItem(key) === 'filled');
  } catch (_error) {
    return false;
  }
}

function setFormRecoveryMarker(record, value) {
  try {
    const key = formRecoveryKey(record);
    if (!key) return;
    if (value) window.localStorage.setItem(key, 'filled');
    else window.localStorage.removeItem(key);
  } catch (_error) {
    // Local recovery marker is best-effort only.
  }
}

function applyFormRecoveryMarker(record) {
  if (!record || record.form_fill_status === 'filled' || !hasFormRecoveryMarker(record)) return record;
  return {
    ...record,
    form_fill_status: 'filled',
    form_fill_recovery_marker: true,
  };
}

function formatFollowUpParts(record) {
  const parts = formatNewbieScheduleParts(record?.newbie_shift_data || {});
  const dateTime = [parts.date, parts.time].filter(Boolean).join(parts.date && parts.time ? ', ' : '');
  return {
    dateTime: dateTime || 'Not scheduled',
    timezone: parts.timezone || '',
  };
}

export default function HistoryPage({ onNavigate, navigationState, onHistoryRefresh }) {
  const modal = useModal();
  const [stats, setStats] = useState({});
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);
  const [showAdminHistoryControls] = useState(() => adminHistoryControlsEnabled());

  const load = useCallback(async () => {
    try {
      const result = onHistoryRefresh
        ? await onHistoryRefresh('history-page')
        : { stats: await api.getHistoryStats(), history: await api.getHistory() };
      const nextHistory = (Array.isArray(result?.history) ? result.history : []).map(applyFormRecoveryMarker);
      setStats(result?.stats || {});
      setHistory(nextHistory);
      console.log('[HISTORY PAGE] fresh history loaded', { count: nextHistory.length });
    } catch (_err) {
      // History data load failed - table remains empty
    }
  }, [onHistoryRefresh]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (navigationState?.selectedHistoryRecord) {
      setDetail(applyFormRecoveryMarker(navigationState.selectedHistoryRecord));
    }
  }, [navigationState]);

  const filtered = history.filter(s => ((s.candidate || s.candidate_name || '')).toLowerCase().includes(search.toLowerCase()));

  const getHistoryIdentity = (record) => {
    if (record?.history_id) return record.history_id;
    return [
      record?.timestamp_iso || record?.timestamp || '',
      record?.tester_name || '',
      record?.candidate_name || record?.candidate || '',
    ].join('|');
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));

  const isLinkedResumeSession = (record) => Boolean(
    record?.resumed_from_history
      || record?.resumed_sup_transfer_only
      || record?.resume_source_history_id
      || record?.resume_source_timestamp_iso
  );

  const canReschedule = (record) => {
    const status = record?.status || record?.final_status;
    const prompt = record?.newbie_shift_prompt || {};
    return status === 'Incomplete' && (
      record?.time_for_sup === false
      || record?.newbie_shift_data
      || record?.needs_sup_transfer
      || record?.pending_sup_transfer_id
      || prompt.trigger === 'not_enough_time_sup_transfer'
      || prompt.trigger === 'both_sup_transfers_failed'
    );
  };

  const handleRescheduleSession = async (record) => {
    const identity = getHistoryIdentity(record);
    const existingNewbie = record?.newbie_shift_data || {};
    const originalScheduledAt = record?.newbie_shift_original_scheduled_at
      || record?.newbie_shift_scheduled_at
      || '';
    await api.startSession({
      ...record,
      status: 'In Progress',
      final_status: 'Incomplete',
      history_id: record.history_id || identity,
      newbie_shift_request_type: NEWBIE_REQUEST_TYPE.RESCHEDULE,
      newbie_shift_request_status: NEWBIE_REQUEST_STATUS.PENDING,
      newbie_shift_requested_by: '',
      newbie_shift_request_reason: '',
      newbie_shift_request_details: '',
      newbie_shift_original_scheduled_at: originalScheduledAt,
      newbie_shift_scheduled_at: record?.newbie_shift_scheduled_at || originalScheduledAt,
      newbie_shift_data: existingNewbie,
    });
    onNavigate('newbieshift');
  };

  const colorResult = (r) => {
    if (r === 'Pass') return <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>PASS</span>;
    if (r === 'Fail') return <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>FAIL</span>;
    return <span style={{ color: 'var(--text-tertiary)' }}>-</span>;
  };

  const readinessJudgment = (record) => {
    const judgment = record?.finalReadinessJudgment && typeof record.finalReadinessJudgment === 'object'
      ? record.finalReadinessJudgment
      : {};
    return {
      ...judgment,
      calculatedResult: judgment.calculatedResult || record?.calculated_result || '',
      overrideApplied: Boolean(judgment.overrideApplied || record?.readiness_override_applied === true || record?.readiness_override_applied === 'TRUE'),
      overrideResult: judgment.overrideResult || record?.readiness_override_result || '',
      primaryReason: judgment.primaryReason || record?.readiness_override_reason || '',
      explanation: judgment.explanation || record?.readiness_override_explanation || '',
    };
  };

  const extractChecked = (obj) => {
    if (!obj) return [];
    return Object.entries(obj).filter(([k, v]) => v && k !== 'Other').map(([k]) => k);
  };

  const handleHistoricalFillForm = async (record) => {
    if (record?.form_fill_status === 'filled' || hasFormRecoveryMarker(record)) {
      const confirmed = await modal.confirm(
        'Form Already Filled',
        'This history record is already marked Form Filled. Running Form Fill again can duplicate work in Microsoft Forms. Continue only if you intentionally need to refill it.',
        'alert-triangle',
        'warning'
      );
      if (!confirmed) return;
    }
    try {
      const coaching = (record?.coaching_summary || '').trim();
      const failSummary = (record?.fail_summary || '').trim();
      const response = await api.fillForm(coaching, failSummary, record);
      if (response.ok || response.form_filled || response.automation_completed) {
        const now = new Date().toISOString();
        const statusUpdate = response.status_update || {};
        const nextRecord = {
          ...record,
          ...statusUpdate,
          form_fill_status: 'filled',
          form_filled_at: statusUpdate.form_filled_at || now,
        };
        setFormRecoveryMarker(record, response.local_status_saved === false);
        setDetail((current) => (current && getHistoryIdentity(current) === getHistoryIdentity(record) ? { ...current, ...nextRecord } : current));
        setHistory((current) => current.map((item) => (
          getHistoryIdentity(item) === getHistoryIdentity(record) ? { ...item, ...nextRecord } : item
        )));
        if (response.warning || response.local_status_saved === false) {
          await modal.warning(
            'Form Filled - Status Warning',
            response.warning || 'The Microsoft Form was filled, but MTS could not update the session status. Do not run Form Fill again. Refresh or update the status manually if needed.'
          );
        } else {
          setFormRecoveryMarker(record, false);
          await modal.alert('Form Filled', response.message || 'The Microsoft Form was filled.', 'check-circle', 'success');
        }
        await load();
        return;
      }
      await modal.error('Form Fill Failed', response.message || 'Unable to send this historical session to the Cert Form.');
    } catch (error) {
      const data = error?.response?.data || {};
      if (data.form_filled || data.automation_completed) {
        setFormRecoveryMarker(record, true);
        await modal.warning(
          'Form Filled - Status Warning',
          data.warning || 'The Microsoft Form was filled, but MTS could not update the session status. Do not run Form Fill again. Refresh or update the status manually if needed.'
        );
        return;
      }
      await modal.error('Form Fill Failed', error.message || 'Unable to send this historical session to the Cert Form.');
    }
  };

  const handleDeleteSession = async (record) => {
    if (!record) return;
    const identity = getHistoryIdentity(record);
    const candidate = record.candidate || record.candidate_name || 'Unknown';
    const status = record.status || record.final_status || '?';
    const linkedWarning = isLinkedResumeSession(record)
      ? '<br /><br /><strong>This session is linked to a resumed supervisor-transfer session. Deleting it will remove the linked session relationship.</strong>'
      : '';
    const choice = await modal.showModal({
      type: 'danger',
      title: 'Delete Session?',
      body: `Would you like to remove this session from your history only, or submit a request to delete it from the certification candidate list as well?<br /><br /><strong>Candidate:</strong> ${escapeHtml(candidate)}<br /><strong>Date:</strong> ${escapeHtml(record.timestamp || record.timestamp_iso || 'Unknown')}<br /><strong>Status:</strong> ${escapeHtml(status)}${linkedWarning}`,
      icon: 'trash-2',
      graphic: 'warning',
      buttons: [
        { label: 'Cancel', cls: 'btn-muted', value: 'cancel' },
        { label: 'History & Candidate List Request', cls: 'btn-warning', value: 'request' },
        { label: 'History Only', cls: 'btn-danger', value: 'history-only' },
      ],
    });
    if (choice === 'cancel' || !choice) return;
    try {
      if (choice === 'request') {
        const response = await api.requestHistorySessionDeletion(identity);
        if (detail && getHistoryIdentity(detail) === identity) setDetail(null);
        await load();
        await modal.alert('Deletion Request Pending', response.message || 'The session was removed from local history. SAM review is pending.');
        return;
      }
      await api.deleteHistorySession(identity);
      if (detail && getHistoryIdentity(detail) === identity) setDetail(null);
      await load();
      await modal.alert('Deleted', 'The session was deleted and Smart Resume references were cleaned up.');
    } catch (error) {
      await modal.error('Delete Failed', error.response?.data?.detail || error.message || 'Unable to delete this history session.');
    }
  };

  return (
    <div data-testid="history-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1>Session History</h1>
        {showAdminHistoryControls && (
          <button className="btn btn-danger btn-sm" onClick={async () => {
            if (history.length === 0) { await modal.warning('Notice', 'No history to clear.'); return; }
            const c = await modal.confirmDanger('Clear History', `This will permanently delete ${history.length} session records. This cannot be undone.`);
            if (!c) return;
            if (!await modal.confirm('Confirm', 'This cannot be undone. Are you absolutely sure?')) return;
            await api.clearHistory(); await modal.alert('Cleared', 'Session history has been cleared.'); await load();
          }} data-testid="history-clear">Clear All History</button>
        )}
      </div>
      <div className="text-sm text-muted" style={{ marginTop: -12, marginBottom: 18 }}>
        Local History shows recent sessions from this app/user. Shared Google Sheet lookup remains available for older or cross-tester candidate records.
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
          <div className="hist-grid" role="table" aria-label="Session history">
            <div className="hist-grid-head" role="row">
              <div role="columnheader">Date</div>
              <div role="columnheader">Candidate</div>
              <div role="columnheader">Tester</div>
              <div role="columnheader">Session Status</div>
              <div role="columnheader">Follow-Up</div>
              <div role="columnheader">Form Status</div>
              <div role="columnheader">Actions</div>
            </div>
              {filtered.map((s, i) => (
                <div key={getHistoryIdentity(s) || i} className="hist-row" role="row" data-testid={`history-row-${i}`}>
                  <div className="hist-cell hist-date" role="cell" data-label="Date">{s.timestamp || 'Unknown'}</div>
                  <div className="hist-cell hist-name" role="cell" data-label="Candidate">{s.candidate || s.candidate_name || 'Unknown'}</div>
                  <div className="hist-cell hist-tester" role="cell" data-label="Tester">{s.tester_name || ''}</div>
                  <div className="hist-cell hist-status" role="cell" data-label="Session Status"><StatusChip meta={sessionStatusMeta(s.status)} /></div>
                  <div className="hist-cell hist-followup text-sm" role="cell" data-label="Follow-Up">
                    {(s.newbie_shift_data || s.newbie_shift_request_id) ? (() => {
                      const followUp = formatFollowUpParts(s);
                      return (
                        <>
                          <span className="hist-followup-date" title={formatNewbieSchedule(s.newbie_shift_data)}>{followUp.dateTime}</span>
                          {followUp.timezone && <span className="hist-followup-tz">{followUp.timezone}</span>}
                          <StatusChip meta={followUpStatusMeta(s.newbie_shift_request_status || NEWBIE_REQUEST_STATUS.PENDING)} />
                        </>
                      );
                    })() : <span className="text-muted">No follow-up</span>}
                  </div>
                  <div className="hist-cell hist-form-status" role="cell" data-label="Form Status">
                    <StatusChip meta={formFillStatusMeta(s.form_fill_status, { legacy: !s.form_fill_status })} />
                  </div>
                  <div className="hist-cell hist-actions" role="cell" data-label="Actions">
                    <div className="hist-actions-group">
                      <button className="btn btn-primary btn-sm" onClick={() => setDetail(s)} data-testid={`history-view-${i}`}>View</button>
                      {canReschedule(s) && <button className="btn btn-warning btn-sm" onClick={() => handleRescheduleSession(s)} data-testid={`history-reschedule-${i}`}>Reschedule</button>}
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteSession(s)} data-testid={`history-delete-${i}`}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {detail && (
        <div className="modal-overlay open">
          <div className="modal" style={{ width: 700, maxHeight: '85vh' }}>
            <div className="modal-header">
              <h2>{detail.candidate || detail.candidate_name || 'Unknown'} - <StatusChip meta={sessionStatusMeta(detail.status || detail.final_status)} /></h2>
              <button className="modal-close" onClick={() => setDetail(null)}>&times;</button>
            </div>
            <div className="modal-body" style={{ lineHeight: 1.7 }}>
              <div className="text-muted text-sm" style={{ marginBottom: 16 }}>{detailDate(detail)}</div>
              <div className="card" style={{ padding: 14, marginBottom: 14 }}>
                <div className="text-sm"><strong>Candidate:</strong> {detail.candidate || detail.candidate_name || 'Unknown'}</div>
                <div className="text-sm"><strong>Tester:</strong> {detail.tester_name || 'N/A'}</div>
                <div className="text-sm"><strong>Status:</strong> <StatusChip meta={sessionStatusMeta(detail.status || detail.final_status)} /></div>
                {readinessJudgment(detail).calculatedResult && (
                  <div className="text-sm"><strong>Calculated Result:</strong> {readinessJudgment(detail).calculatedResult}</div>
                )}
                {readinessJudgment(detail).overrideApplied && (
                  <div className="text-sm"><strong>Evaluator Override Applied:</strong> {readinessJudgment(detail).overrideResult || detail.final_status || detail.status || 'N/A'}</div>
                )}
                {readinessJudgment(detail).overrideApplied && readinessJudgment(detail).primaryReason && (
                  <div className="text-sm"><strong>Override Reason:</strong> {readinessJudgment(detail).primaryReason}</div>
                )}
                <div className="text-sm"><strong>Date:</strong> {detailDate(detail) || 'Unknown'}</div>
                <div className="text-sm"><strong>Final Attempt:</strong> {detail.final_attempt ? 'Yes' : 'No'}</div>
                {detail.headset_brand && <div className="text-sm"><strong>Headset:</strong> {detail.headset_brand}</div>}
                <div className="text-sm"><strong>Form Fill:</strong> <StatusChip meta={formFillStatusMeta(detail.form_fill_status, { legacy: !detail.form_fill_status })} /></div>
              </div>
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
              {(detail.newbie_shift_data || detail.newbie_shift_request_id) && (
                <><br /><strong>Newbie Shift:</strong> {formatNewbieSchedule(detail.newbie_shift_data || {})}<br /><strong>Approval Status:</strong> <StatusChip meta={followUpStatusMeta(detail.newbie_shift_request_status || NEWBIE_REQUEST_STATUS.PENDING)} />{detail.newbie_shift_original_scheduled_at && <><br /><strong>Original Scheduled At:</strong> {detail.newbie_shift_original_scheduled_at}</>}{detail.newbie_shift_request_status === NEWBIE_REQUEST_STATUS.DENIED && detail.newbie_shift_denial_reason && <><br /><strong>Denial Reason:</strong> {detail.newbie_shift_denial_reason}</>}</>
              )}
              <div style={{ marginTop: 16 }}>
                <div className="text-sm font-bold">Coaching Summary</div>
                <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.coaching_summary || 'None recorded'}</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="text-sm font-bold">Fail Summary</div>
                <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.fail_summary || 'N/A'}</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div className="text-sm font-bold">Notes</div>
                <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>
                  {(() => {
                    if (detail.evaluatorNotesSummaryEdited) return detail.evaluatorNotesSummaryEdited;
                    if (detail.finalEvaluatorNotes) {
                      const notes = detail.finalEvaluatorNotes;
                      const lines = [];
                      if (notes.historyOnly) {
                        lines.push("(History-Only Notes - not included in summaries)");
                      }
                      if (notes.notes?.trim()) lines.push(notes.notes.trim());
                      if (notes.strengths?.trim()) lines.push(`Strengths: ${notes.strengths.trim()}`);
                      if (notes.needsCoaching?.trim()) lines.push(`Needs Coaching: ${notes.needsCoaching.trim()}`);
                      if (notes.other?.trim()) lines.push(`Other Notes: ${notes.other.trim()}`);
                      return lines.join('\n\n') || 'No final notes were added.';
                    }
                    return detail.notes || detail.review_notes || 'None recorded';
                  })()}
                </div>
              </div>
            </div>
            <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
              <button className="btn btn-muted" onClick={() => setDetail(null)}>Close</button>
              <button className="btn btn-danger" onClick={() => handleDeleteSession(detail)} data-testid="history-detail-delete">Delete Session</button>
              <button className="btn btn-warning" onClick={() => handleHistoricalFillForm(detail)} data-testid="history-fill-form">{detail.form_fill_status === 'filled' ? 'Refill Cert Form' : 'Fill Cert Form'}</button>
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

function StatusChip({ meta }) {
  const safe = meta || { label: 'Unknown', title: 'Unknown', ariaLabel: 'Status: Unknown', className: 'status-chip-form-legacy' };
  return (
    <span className={`status-chip ${safe.className}`} title={safe.title || safe.label} aria-label={safe.ariaLabel || safe.label}>
      <span className="status-chip-icon" aria-hidden="true" />
      <span className="status-chip-label">{safe.label}</span>
    </span>
  );
}
