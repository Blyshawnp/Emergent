import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import RescheduleIntakeModal from '../components/RescheduleIntakeModal';
import FinalAttemptBanner from '../components/FinalAttemptBanner';
import {
  canRescheduleNewbieShift,
  formFillStatusMeta,
  formatNewbieScheduleParts,
  formatNewbieSchedule,
  getNewbieShiftEligibility,
  newbieShiftStatusMeta,
  NEWBIE_REQUEST_STATUS,
  sessionStatusMeta,
} from '../utils/certificationWorkflow';
import { buildNewbieShiftRescheduleSession } from '../utils/newbieShiftWorkflow';

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

export function buildHistoryCorrectionChanges(record = {}, draft = {}) {
  const current = {
    candidate_name: String(record.candidate || record.candidate_name || '').trim(),
    headset_model: String(record.headset_brand || '').trim(),
  };
  const requested = {
    candidate_name: String(draft.candidateName || '').trim(),
    headset_model: String(draft.headsetModel || '').trim(),
  };
  return [
    { field_key: 'candidate_name', label: 'Candidate Name' },
    { field_key: 'headset_model', label: 'Headset Model' },
  ].flatMap(({ field_key, label }) => (
    requested[field_key] && requested[field_key] !== current[field_key]
      ? [{ field: field_key, field_key, label, previous_value: current[field_key], requested_value: requested[field_key] }]
      : []
  ));
}

export default function HistoryPage({ onNavigate, navigationState, onHistoryRefresh }) {
  const modal = useModal();
  const [stats, setStats] = useState({});
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);
  const [deletionRequestDraft, setDeletionRequestDraft] = useState(null);
  const [correctionDraft, setCorrectionDraft] = useState(null);
  const [rescheduleDraft, setRescheduleDraft] = useState(null);
  const [rescheduleSubmitting, setRescheduleSubmitting] = useState(false);
  const [showAdminHistoryControls] = useState(() => adminHistoryControlsEnabled());
  const rescheduleTriggerRef = useRef(null);
  const restoreRescheduleFocusRef = useRef(false);

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

  useEffect(() => {
    if (!rescheduleDraft && detail && restoreRescheduleFocusRef.current) {
      restoreRescheduleFocusRef.current = false;
      rescheduleTriggerRef.current?.focus();
    }
  }, [detail, rescheduleDraft]);

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

  const handleRescheduleSession = (record) => {
    if (!canRescheduleNewbieShift(record)) return;
    setRescheduleDraft(record);
  };

  const continueReschedule = async (intake) => {
    if (!rescheduleDraft) return;
    setRescheduleSubmitting(true);
    try {
      const response = await api.startSession(buildNewbieShiftRescheduleSession(rescheduleDraft, intake));
      if (response?.ok !== true || !response?.session) {
        throw new Error(response?.error || 'Unable to save the reschedule draft.');
      }
      setRescheduleDraft(null);
      setDetail(null);
      onNavigate('newbieshift');
    } catch (error) {
      await modal.error('Reschedule Failed', error.message || 'Unable to save the reschedule details. Your selections were preserved.');
    } finally {
      setRescheduleSubmitting(false);
    }
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
        { label: 'History & Candidate List Request', cls: 'btn-warning deletion-request-primary', value: 'request' },
        { label: 'History Only', cls: 'btn-danger', value: 'history-only' },
      ],
    });
    if (choice === 'cancel' || !choice) return;
    try {
      if (choice === 'request') {
        setDeletionRequestDraft({ record, identity, reason: '', error: '', submitting: false });
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

  const submitCandidateDeletionRequest = async () => {
    const reason = String(deletionRequestDraft?.reason || '').trim();
    if (reason.length < 10) {
      setDeletionRequestDraft((current) => ({ ...current, error: 'Enter at least 10 characters explaining why Candidate Tracking should be updated.' }));
      return;
    }
    setDeletionRequestDraft((current) => ({ ...current, reason, error: '', submitting: true }));
    try {
      const response = await api.requestHistorySessionDeletion(deletionRequestDraft.identity, reason);
      if (detail && getHistoryIdentity(detail) === deletionRequestDraft.identity) setDetail(null);
      setDeletionRequestDraft(null);
      await load();
      await modal.success(
        'Deletion Request Submitted',
        'The session was removed from local History. The Candidate Tracking deletion request was submitted to SAM and is awaiting review.'
      );
    } catch (error) {
      setDeletionRequestDraft((current) => ({
        ...current,
        submitting: false,
        error: error.response?.data?.detail || error.message || 'Unable to submit the deletion request. Your reason has been preserved.',
      }));
    }
  };

  const openCorrectionRequest = (record) => {
    setCorrectionDraft({
      record,
      candidateName: record.candidate || record.candidate_name || '',
      headsetModel: record.headset_brand || '',
      reason: '', error: '', submitting: false,
    });
  };

  const submitCorrectionRequest = async () => {
    const reason = String(correctionDraft?.reason || '').trim();
    if (reason.length < 10) {
      setCorrectionDraft((current) => ({ ...current, error: 'Enter at least 10 characters explaining the correction.' }));
      return;
    }
    const record = correctionDraft.record;
    const changes = buildHistoryCorrectionChanges(record, correctionDraft);
    if (!changes.length) {
      setCorrectionDraft((current) => ({ ...current, error: 'Change the candidate name or headset model before submitting.' }));
      return;
    }
    setCorrectionDraft((current) => ({ ...current, reason, error: '', submitting: true }));
    try {
      const response = await api.requestHistorySessionCorrection(getHistoryIdentity(record), changes, reason);
      const pendingRecord = { ...record, candidate_correction_pending: true, candidate_correction_status: 'pending', candidate_correction_request_id: response.request_id, candidate_correction_changes: response.changes, candidate_correction_reason: reason };
      setHistory((current) => current.map((item) => getHistoryIdentity(item) === getHistoryIdentity(record) ? pendingRecord : item));
      setDetail(pendingRecord);
      setCorrectionDraft(null);
      await modal.success('Correction Request Submitted', 'The requested correction was saved locally and sent to SAM for review. The current candidate information will remain authoritative until the request is approved.');
    } catch (error) {
      const detailMessage = error.response?.data?.detail?.message || error.response?.data?.detail || error.message;
      setCorrectionDraft((current) => ({ ...current, submitting: false, error: detailMessage || 'Unable to submit the correction request.' }));
    }
  };

  const retryHeadsetReview = async (record) => {
    let result;
    try {
      result = await api.logHeadsetReview({
        review_id: record.headset_review_id || '',
        source_session_id: record.session_id || record.history_id || '',
        candidate_name: record.candidate_name || record.candidate || '',
        tester_name: record.tester_name || '',
        headset_model: record.headset_brand || '',
        note: record.headset_review_note || '',
      });
    } catch (_error) {
      result = { ok: false };
    }
    if (!result?.ok) {
      await modal.warning('Headset Review Not Submitted', 'The headset review request is still unavailable. Your session remains saved; try again later.');
      return;
    }
    setHistory((current) => current.map((item) => (
      getHistoryIdentity(item) === getHistoryIdentity(record)
        ? { ...item, headset_review_id: result.review_id || item.headset_review_id, headset_review_sync_status: 'synced', headset_review_status: result.status || 'pending' }
        : item
    )));
    await modal.success('Headset Review Submitted', 'The headset review request is now pending in SAM.');
  };

  const correctionChanges = correctionDraft ? buildHistoryCorrectionChanges(correctionDraft.record, correctionDraft) : [];

  return (
    <div className="history-page" data-testid="history-page">
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

      <div className="card history-list-card" style={{ padding: 0 }}>
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
                    {s.candidate_correction_pending ? <StatusChip meta={{ label: 'Correction Pending', tone: 'pending' }} title="Candidate information correction pending SAM review" /> : null}
                    {getNewbieShiftEligibility(s).active || getNewbieShiftEligibility(s).denied ? (() => {
                      const followUp = formatFollowUpParts(s);
                      const meta = newbieShiftStatusMeta(s);
                      return (
                        <>
                          <span className="hist-followup-date" title={formatNewbieSchedule(s.newbie_shift_data)}>{followUp.dateTime}</span>
                          {followUp.timezone && <span className="hist-followup-tz">{followUp.timezone}</span>}
                          {meta ? <StatusChip meta={meta} /> : null}
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
                      {canRescheduleNewbieShift(s) && <button className="btn btn-warning btn-sm" onClick={() => handleRescheduleSession(s)} data-testid={`history-reschedule-${i}`}>Reschedule</button>}
                      {s.headset_review_sync_status === 'failed' && <button className="btn btn-warning btn-sm" onClick={() => retryHeadsetReview(s)} data-testid={`history-headset-retry-${i}`}>Retry Headset Review</button>}
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteSession(s)} data-testid={`history-delete-${i}`}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>

      {deletionRequestDraft && (
        <div className="modal-overlay open">
          <section className="modal deletion-reason-modal" role="dialog" aria-modal="true" aria-labelledby="deletion-reason-title">
            <div className="modal-header">
              <div className="deletion-modal-heading">
                <span className="deletion-warning-icon" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                </span>
                <div><h2 id="deletion-reason-title">Candidate List Deletion Request</h2><p className="text-muted text-sm">Candidate Tracking deletion requires SAM approval.</p></div>
              </div>
              <button type="button" className="modal-close" onClick={() => setDeletionRequestDraft(null)} aria-label="Cancel deletion request">×</button>
            </div>
            <div className="modal-body">
              <label className="deletion-reason-field">
                <span>Reason for candidate-list deletion request</span>
                <textarea
                  rows={5}
                  value={deletionRequestDraft.reason}
                  onChange={(event) => setDeletionRequestDraft((current) => ({ ...current, reason: event.target.value, error: '' }))}
                  placeholder="Explain why this session should also be removed from Candidate Tracking."
                  data-testid="candidate-deletion-reason"
                  autoFocus
                />
                <small>Explain why this session should also be removed from Candidate Tracking.</small>
              </label>
              {deletionRequestDraft.error ? <div className="form-error" role="alert">{deletionRequestDraft.error}</div> : null}
            </div>
            <div className="modal-footer-actions">
              <button type="button" className="btn btn-muted" onClick={() => setDeletionRequestDraft(null)} disabled={deletionRequestDraft.submitting}>Cancel</button>
              <button type="button" className="btn btn-warning" onClick={submitCandidateDeletionRequest} disabled={deletionRequestDraft.submitting} data-testid="candidate-deletion-submit">
                {deletionRequestDraft.submitting ? 'Submitting…' : 'Submit Deletion Request'}
              </button>
            </div>
          </section>
        </div>
      )}

      {correctionDraft && (
        <div className="modal-overlay open correction-request-overlay">
          <section className="modal correction-request-modal" role="dialog" aria-modal="true" aria-labelledby="correction-request-title">
            <div className="modal-header">
              <div><h2 id="correction-request-title">Correct Candidate Information</h2><p className="text-muted text-sm">Request a correction to the candidate name or headset recorded for this session. Certification results and attempt information will not be changed.</p></div>
              <button type="button" className="modal-close" onClick={() => setCorrectionDraft(null)} aria-label="Cancel correction request">×</button>
            </div>
            <div className="modal-body correction-request-fields">
              <label><span>Candidate name</span><small>Current: {correctionDraft.record.candidate || correctionDraft.record.candidate_name || 'Not recorded'}</small><input value={correctionDraft.candidateName} onChange={(event) => setCorrectionDraft((current) => ({ ...current, candidateName: event.target.value, error: '' }))} /></label>
              <label><span>Headset model</span><small>Current: {correctionDraft.record.headset_brand || 'Not recorded'}</small><input value={correctionDraft.headsetModel} onChange={(event) => setCorrectionDraft((current) => ({ ...current, headsetModel: event.target.value, error: '' }))} /></label>
              <label><span>Correction reason</span><textarea className="correction-reason-input" rows={4} required aria-invalid={Boolean(correctionDraft.error && correctionDraft.reason.trim().length < 10)} value={correctionDraft.reason} onChange={(event) => setCorrectionDraft((current) => ({ ...current, reason: event.target.value, error: '' }))} placeholder="Explain why this correction is needed, such as a misspelled candidate name or headset model." /></label>
              <div className="correction-review" aria-live="polite">
                <strong>Changed fields</strong>
                {correctionChanges.map((change) => <div key={change.field_key}><span>{change.label}</span><span>{change.previous_value || 'Not recorded'} → {change.requested_value}</span></div>)}
                {!correctionChanges.length ? <p className="correction-empty-guidance">Change the candidate name or headset model to enable Submit Correction Request.</p> : null}
              </div>
              {correctionDraft.error ? <div className="form-error" role="alert">{correctionDraft.error}</div> : null}
            </div>
            <div className="modal-footer-actions">
              <button type="button" className="btn btn-muted" onClick={() => setCorrectionDraft(null)} disabled={correctionDraft.submitting}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={submitCorrectionRequest} disabled={correctionDraft.submitting || !correctionChanges.length || correctionDraft.reason.trim().length < 10} data-testid="candidate-correction-submit">{correctionDraft.submitting ? 'Submitting…' : 'Submit Correction Request'}</button>
            </div>
          </section>
        </div>
      )}

      {rescheduleDraft && (
        <RescheduleIntakeModal
          record={rescheduleDraft}
          onCancel={() => {
            restoreRescheduleFocusRef.current = true;
            setRescheduleDraft(null);
          }}
          onContinue={continueReschedule}
          submitting={rescheduleSubmitting}
        />
      )}

      {detail && !rescheduleDraft && (
        <div className="modal-overlay open" data-testid="history-detail-modal">
          <div className="modal" style={{ width: 700, maxHeight: '85vh' }}>
            <div className="modal-header">
              <h2>{detail.candidate || detail.candidate_name || 'Unknown'} - <StatusChip meta={sessionStatusMeta(detail.status || detail.final_status)} /></h2>
              <button className="modal-close" onClick={() => setDetail(null)}>&times;</button>
            </div>
            <div className="modal-body" style={{ lineHeight: 1.7 }}>
              <FinalAttemptBanner visible={detail.final_attempt} attemptState={detail.attempt_state} />
              {Array.isArray(detail.attempt_history) && detail.attempt_history.length > 0 && (
                <div className="card" style={{ padding: 16, marginBottom: 16 }} data-testid="history-attempt-history">
                  <h3 style={{ marginBottom: 10 }}>Attempt History</h3>
                  {detail.attempt_history.map((attempt, index) => (
                    <div key={`${attempt.attempt_number || index}-${attempt.timestamp_iso || attempt.timestamp || index}`} className="text-sm" style={{ marginBottom: 8 }}>
                      <strong>Attempt {attempt.attempt_number || index + 1}:</strong> {attempt.status || 'Incomplete'}
                      {attempt.final_attempt ? ' — Final Attempt' : ''}
                      <br />
                      <span className="text-muted">
                        Calls: {[attempt.call_1?.result, attempt.call_2?.result, attempt.call_3?.result].filter(Boolean).join(', ') || 'None'}; Supervisor Transfers: {[attempt.sup_transfer_1?.result, attempt.sup_transfer_2?.result].filter(Boolean).join(', ') || 'None'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
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
                {detail.candidate_correction_status ? <div className="text-sm"><strong>Candidate Information Correction:</strong> <StatusChip meta={{ label: detail.candidate_correction_status === 'pending' ? 'Pending SAM Review' : detail.candidate_correction_status === 'approved' ? 'Approved' : 'Denied', tone: detail.candidate_correction_status === 'approved' ? 'approved' : detail.candidate_correction_status === 'denied' ? 'denied' : 'pending' }} /></div> : null}
                {detail.candidate_correction_status !== 'approved' && Array.isArray(detail.candidate_correction_changes) && detail.candidate_correction_changes.length ? (
                  <div className="history-correction-summary" data-testid="history-correction-summary">
                    {detail.candidate_correction_changes.map((change) => (
                      <div key={change.field_key || change.field}>
                        <strong>{change.label || (change.field === 'candidate_name' ? 'Candidate Name' : 'Headset Model')}</strong>
                        <span>Current: {change.previous_value || 'Not recorded'}</span>
                        <span>Requested correction: {change.requested_value}</span>
                      </div>
                    ))}
                    {detail.candidate_correction_reason ? <p><strong>Reason:</strong> {detail.candidate_correction_reason}</p> : null}
                  </div>
                ) : null}
                {detail.candidate_correction_denial_reason ? <div className="text-sm"><strong>Correction Denial Reason:</strong> {detail.candidate_correction_denial_reason}</div> : null}
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => openCorrectionRequest(detail)} disabled={detail.candidate_correction_pending} data-testid="history-correction-action">
                {detail.candidate_correction_pending ? 'Correction Pending' : 'Correct Candidate Information'}
              </button>
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
              {(getNewbieShiftEligibility(detail).active || getNewbieShiftEligibility(detail).denied) && (
                <><br /><strong>Newbie Shift:</strong> {formatNewbieSchedule(detail.newbie_shift_data || {})}<br /><strong>Approval Status:</strong> <StatusChip meta={newbieShiftStatusMeta(detail)} />{detail.newbie_shift_original_scheduled_at && <><br /><strong>Original Scheduled At:</strong> {detail.newbie_shift_original_scheduled_at}</>}{detail.newbie_shift_request_status === NEWBIE_REQUEST_STATUS.DENIED && detail.newbie_shift_denial_reason && <><br /><strong>Denial Reason:</strong> {detail.newbie_shift_denial_reason}</>}</>
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
              {canRescheduleNewbieShift(detail) && <button ref={rescheduleTriggerRef} className="btn btn-warning" onClick={() => handleRescheduleSession(detail)} data-testid="history-detail-reschedule">Reschedule</button>}
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
