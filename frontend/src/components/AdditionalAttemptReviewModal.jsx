import React, { useState, useEffect, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  WifiOff,
  Shield,
  FileText,
  AlertCircle,
  ChevronRight,
  Info,
} from 'lucide-react';

export default function AdditionalAttemptReviewModal({
  open,
  override,
  onClose,
  onDecide,
  onResolveConflict,
  loading = false,
}) {
  const [confirmingAction, setConfirmingAction] = useState(null); // 'approved' | 'denied' | 'resolve_conflict'
  const [decisionReason, setDecisionReason] = useState('');
  const [conflictActionType, setConflictActionType] = useState('approve_winner_deny_loser'); // 'approve_winner_deny_loser' | 'deny_both'
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => {
    if (open) {
      setConfirmingAction(null);
      setDecisionReason('');
      setActionError('');
      setSubmitting(false);
    }
  }, [open, override]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && open && !submitting) {
        if (confirmingAction) {
          setConfirmingAction(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, confirmingAction, submitting, onClose]);

  if (!open || !override) {
    return null;
  }

  const session = override.session || {};
  const isConflict = override.authorization_status === 'conflict' || Boolean(override.conflict_data);
  const isInProgress = session.is_in_progress ?? !session.final_result;
  const finalResult = session.final_result || session.raw_status;
  const isPassed = String(finalResult || '').toUpperCase().includes('PASS');
  const isFailed = String(finalResult || '').toUpperCase().includes('FAIL');
  const priorHistory = Array.isArray(override.prior_history) ? override.prior_history : [];

  const handleStartDecide = (decision) => {
    setActionError('');
    setDecisionReason('');
    setConfirmingAction(decision);
  };

  const handleStartConflictResolution = (actionType) => {
    setActionError('');
    setDecisionReason('');
    setConflictActionType(actionType);
    setConfirmingAction('resolve_conflict');
  };

  const submitDecision = async () => {
    if (confirmingAction === 'denied' && !decisionReason.trim()) {
      setActionError('A denial reason is required.');
      return;
    }

    setSubmitting(true);
    setActionError('');
    try {
      if (confirmingAction === 'resolve_conflict') {
        const decision = conflictActionType === 'approve_winner_deny_loser' ? 'approved' : 'denied';
        const res = await onResolveConflict?.({
          conflict_override_id: override.id || override.override_id,
          decision,
          reason: decisionReason.trim() || undefined,
        });
        if (!res?.ok) {
          setActionError(res?.error || 'Failed to resolve offline override conflict.');
          return;
        }
      } else {
        const res = await onDecide?.({
          override_id: override.id || override.override_id,
          decision: confirmingAction,
          reason: decisionReason.trim() || undefined,
        });
        if (!res?.ok) {
          setActionError(res?.error || `Failed to ${confirmingAction} additional attempt override.`);
          return;
        }
      }
      onClose();
    } catch (err) {
      setActionError(err.message || 'An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  };

  const formatTimestamp = (ts) => {
    if (!ts) return 'Unknown';
    try {
      const d = new Date(ts);
      return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    } catch {
      return String(ts);
    }
  };

  return (
    <div className="nm-modal-backdrop" style={{ zIndex: 9999 }}>
      <section
        className="nm-candidate-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="override-review-title"
        ref={modalRef}
        style={{ maxWidth: '680px', width: '92vw', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="nm-candidate-detail-header">
          <div className="nm-detail-id">
            <div className="nm-detail-name" id="override-review-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Shield size={20} style={{ color: 'var(--color-primary, #3b82f6)' }} />
              {isConflict ? 'Offline Override Conflict Review' : 'Additional Attempt Override Review'}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
              {override.is_offline_emergency ? (
                <span className="nm-badge nm-badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <WifiOff size={12} /> Emergency Offline Option B
                </span>
              ) : (
                <span className="nm-badge nm-badge-info">Online Reservation</span>
              )}
              <span className={`nm-request-status is-${override.authorization_status === 'approved' ? 'approved' : override.authorization_status === 'denied' ? 'denied' : 'pending'}`}>
                <Clock size={12} />
                {override.authorization_status === 'conflict' ? 'Conflict Pending Resolution' : override.authorization_status || 'Pending Authorization'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="nm-modal-close"
            aria-label="Close override review"
            onClick={onClose}
            disabled={submitting}
          >
            ×
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="nm-candidate-detail-scroll" style={{ padding: '16px 24px' }}>
          {actionError ? (
            <div className="nm-status-card is-warning" style={{ marginBottom: '16px' }} role="alert">
              <AlertCircle size={16} />
              <div>
                <strong>Action could not be completed</strong>
                <div>{actionError}</div>
              </div>
            </div>
          ) : null}

          {/* Business Fields Grid */}
          <dl className="nm-detail-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
            <div>
              <dt>Candidate</dt>
              <dd><strong>{override.candidate_name || override.candidate || 'Unknown'}</strong></dd>
            </div>
            <div>
              <dt>Tester</dt>
              <dd>{override.tester_name || override.tester || 'Unknown'}</dd>
            </div>
            <div>
              <dt>Attempt Number</dt>
              <dd>
                Attempt <strong>{override.attempt_number || 4}</strong> of {override.authorized_max_attempts || 3} allowed
              </dd>
            </div>
            <div>
              <dt>Started / Occurred At</dt>
              <dd>{formatTimestamp(override.occurred_at || override.created_at)}</dd>
            </div>
            <div>
              <dt>Workstation / Installation</dt>
              <dd data-testid="workstation-attribution">
                {override.actor_installation_id ? (
                  <code style={{ fontSize: '12px', background: '#ecfdf5', color: '#065f46', padding: '2px 6px', borderRadius: '4px' }}>
                    {override.actor_installation_id} (Verified)
                  </code>
                ) : override.unverified_actor_installation_id ? (
                  <span style={{ fontSize: '12px', color: '#b45309' }}>
                    Unverified (<code>{override.unverified_actor_installation_id}</code>)
                  </span>
                ) : (
                  <span style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                    Unknown / Unverified
                  </span>
                )}
              </dd>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>Exact Session ID</dt>
              <dd><code style={{ fontSize: '12px', background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>{override.source_session_id || override.session_id}</code></dd>
            </div>
          </dl>

          {/* Mandatory Written Reason (Tester Attribution) */}
          <div className="nm-detail-section" style={{ marginBottom: '16px' }}>
            <div className="nm-detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FileText size={15} /> Mandatory Written Reason for Override (Tester)
            </div>
            <div
              style={{
                background: '#f8fafc',
                borderLeft: '4px solid #3b82f6',
                padding: '10px 14px',
                borderRadius: '0 6px 6px 0',
                fontSize: '14px',
                fontStyle: 'italic',
                marginTop: '6px',
              }}
              data-testid="tester-written-reason"
            >
              {override.tester_override_reason || override.reason ? (
                `"${override.tester_override_reason || override.reason}"`
              ) : (
                <span style={{ color: '#64748b', fontStyle: 'normal' }}>
                  Missing — No tester explanation was submitted with this session.
                </span>
              )}
            </div>
          </div>

          {/* System Conflict Diagnostic (Distinguishable from Tester Reason) */}
          {override.system_conflict_reason ? (
            <div className="nm-detail-section" style={{ marginBottom: '16px' }}>
              <div className="nm-detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#b45309' }}>
                <AlertTriangle size={15} /> System Conflict Diagnostic
              </div>
              <div
                style={{
                  background: '#fffbeb',
                  borderLeft: '4px solid #f59e0b',
                  padding: '10px 14px',
                  borderRadius: '0 6px 6px 0',
                  fontSize: '13px',
                  color: '#92400e',
                  marginTop: '6px',
                }}
                data-testid="system-conflict-diagnostic"
              >
                {override.system_conflict_reason}
              </div>
            </div>
          ) : null}

          {/* Administrator Decision Reason */}
          {override.decision_reason ? (
            <div className="nm-detail-section" style={{ marginBottom: '16px' }}>
              <div className="nm-detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#15803d' }}>
                <CheckCircle size={15} /> Administrator Decision Reason
              </div>
              <div
                style={{
                  background: '#f0fdf4',
                  borderLeft: '4px solid #22c55e',
                  padding: '10px 14px',
                  borderRadius: '0 6px 6px 0',
                  fontSize: '13px',
                  color: '#166534',
                  marginTop: '6px',
                }}
                data-testid="admin-decision-reason"
              >
                {override.decision_reason}
              </div>
            </div>
          ) : null}

          {/* Evaluation / Actual Result Status */}
          <div className="nm-detail-section" style={{ marginBottom: '16px' }}>
            <div className="nm-detail-label">Session Evaluation &amp; Result</div>
            {isInProgress ? (
              <div
                style={{
                  background: '#fef3c7',
                  border: '1px solid #f59e0b',
                  color: '#92400e',
                  padding: '12px 16px',
                  borderRadius: '6px',
                  marginTop: '6px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                }}
                data-testid="in-progress-warning"
              >
                <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong style={{ display: 'block', fontSize: '14px' }}>
                    Session in Progress — Evaluation Not Yet Available
                  </strong>
                  <span style={{ fontSize: '13px' }}>
                    The tester has not yet completed and submitted the evaluation for this session.
                    Administrative decision (Approve or Deny) is <strong>disabled</strong> until the evaluation has been submitted.
                  </span>
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: isPassed ? '#ecfdf5' : '#fef2f2',
                  border: `1px solid ${isPassed ? '#10b981' : '#ef4444'}`,
                  color: isPassed ? '#065f46' : '#991b1b',
                  padding: '12px 16px',
                  borderRadius: '6px',
                  marginTop: '6px',
                }}
                data-testid="evaluation-completed"
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isPassed ? <CheckCircle size={20} /> : <XCircle size={20} />}
                    <span style={{ fontSize: '16px', fontWeight: 'bold' }}>
                      Result: {finalResult}
                    </span>
                  </div>
                  <span className={`nm-badge ${isPassed ? 'nm-badge-success' : 'nm-badge-danger'}`}>
                    Evaluation Submitted
                  </span>
                </div>
                <div style={{ fontSize: '13px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
                  <div>Mock Calls: <strong>{session.mock_calls_completed ?? 0}</strong> of 3</div>
                  <div>Supervisor Transfers: <strong>{session.sup_transfers_completed ?? 0}</strong></div>
                  {session.evaluator_notes_summary ? (
                    <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                      Notes: <em>{session.evaluator_notes_summary}</em>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {/* Conflict Side-by-Side Review */}
          {isConflict && override.conflict_data ? (
            <div
              className="nm-detail-section"
              style={{
                background: '#fff1f2',
                border: '1px solid #fecdd3',
                padding: '14px',
                borderRadius: '6px',
                marginBottom: '16px',
              }}
            >
              <div className="nm-detail-label" style={{ color: '#be123c', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <AlertTriangle size={16} /> Conflicting Sessions Comparison
              </div>
              <div style={{ fontSize: '13px', color: '#881337', marginBottom: '10px' }}>
                An emergency offline session was submitted while another override was already pending for this candidate.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ background: '#fff', padding: '10px', borderRadius: '4px', border: '1px solid #f43f5e' }}>
                  <div style={{ fontWeight: 'bold', color: '#e11d48', fontSize: '13px', marginBottom: '4px' }}>
                    This Session (Offline Emergency)
                  </div>
                  <div style={{ fontSize: '12px' }}><strong>Tester:</strong> {override.tester_name}</div>
                  <div style={{ fontSize: '12px' }}><strong>Session ID:</strong> <code>{override.source_session_id}</code></div>
                  <div style={{ fontSize: '12px' }}><strong>Result:</strong> {finalResult || 'In Progress'}</div>
                  <div style={{ fontSize: '12px', marginTop: '4px' }}><strong>Reason:</strong> {override.reason}</div>
                </div>
                <div style={{ background: '#fff', padding: '10px', borderRadius: '4px', border: '1px solid #cbd5e1' }}>
                  <div style={{ fontWeight: 'bold', color: '#475569', fontSize: '13px', marginBottom: '4px' }}>
                    Conflicting Outstanding Session
                  </div>
                  <div style={{ fontSize: '12px' }}><strong>Tester:</strong> {override.conflict_data.conflicting_tester_name || 'N/A'}</div>
                  <div style={{ fontSize: '12px' }}><strong>Session ID:</strong> <code>{override.conflict_data.conflicting_session_id}</code></div>
                  <div style={{ fontSize: '12px' }}><strong>Status:</strong> {override.conflict_data.conflicting_authorization_status || 'Pending'}</div>
                  <div style={{ fontSize: '12px', marginTop: '4px' }}><strong>Reason:</strong> {override.conflict_data.conflicting_reason || 'N/A'}</div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Prior Attempt History */}
          {priorHistory.length > 0 ? (
            <div className="nm-detail-section" style={{ marginBottom: '16px' }}>
              <div className="nm-detail-label">Prior Certification History</div>
              <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse', marginTop: '6px' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                    <th style={{ padding: '6px 8px' }}>Attempt</th>
                    <th style={{ padding: '6px 8px' }}>Result</th>
                    <th style={{ padding: '6px 8px' }}>Date</th>
                    <th style={{ padding: '6px 8px' }}>Session ID</th>
                  </tr>
                </thead>
                <tbody>
                  {priorHistory.map((att, idx) => (
                    <tr key={att.session_id || idx} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '6px 8px' }}>Attempt {att.attempt_number || idx + 1}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <span className={`nm-badge ${String(att.final_result || '').toUpperCase() === 'PASS' ? 'nm-badge-success' : 'nm-badge-danger'}`}>
                          {att.final_result || att.status || 'Fail'}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px' }}>{formatTimestamp(att.created_at)}</td>
                      <td style={{ padding: '6px 8px' }}><code>{att.session_id}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Confirmation Step */}
          {confirmingAction ? (
            <div
              style={{
                background: '#f8fafc',
                border: '2px solid var(--color-primary, #3b82f6)',
                padding: '16px',
                borderRadius: '8px',
                marginTop: '16px',
              }}
              data-testid="confirmation-step"
            >
              <h4 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>
                {confirmingAction === 'approved' ? 'Confirm Approval' : confirmingAction === 'denied' ? 'Confirm Denial' : 'Confirm Conflict Resolution'}
              </h4>
              <p style={{ fontSize: '13px', margin: '0 0 12px 0', color: '#334155' }}>
                {confirmingAction === 'approved' && (
                  <>
                    Are you sure you want to <strong>Approve</strong> this additional attempt for{' '}
                    <strong>{override.candidate_name}</strong>? If the evaluation passed, certification clearance will be granted.
                  </>
                )}
                {confirmingAction === 'denied' && (
                  <>
                    Are you sure you want to <strong>Deny</strong> this additional attempt for{' '}
                    <strong>{override.candidate_name}</strong>? The session will remain uncertified.
                  </>
                )}
                {confirmingAction === 'resolve_conflict' && (
                  <>
                    Resolve this conflict by <strong>{conflictActionType === 'approve_winner_deny_loser' ? 'Approving this session and Denying the conflicting session' : 'Denying both sessions'}</strong>?
                  </>
                )}
              </p>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', marginBottom: '4px' }}>
                  {confirmingAction === 'denied' ? 'Denial Reason (Required):' : 'Administrator Note / Reason (Optional):'}
                </label>
                <textarea
                  className="nm-input"
                  rows={2}
                  value={decisionReason}
                  onChange={(e) => setDecisionReason(e.target.value)}
                  placeholder={confirmingAction === 'denied' ? 'Enter required explanation for denial...' : 'Optional note on this decision...'}
                  style={{ width: '100%', fontSize: '13px' }}
                  data-testid="decision-reason-input"
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="nm-btn nm-btn-secondary"
                  onClick={() => setConfirmingAction(null)}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`nm-btn ${confirmingAction === 'denied' ? 'nm-btn-danger' : 'nm-btn-primary'}`}
                  onClick={submitDecision}
                  disabled={submitting || (confirmingAction === 'denied' && !decisionReason.trim())}
                  data-testid="confirm-decision-btn"
                >
                  {submitting ? 'Submitting...' : confirmingAction === 'denied' ? 'Confirm Denial' : 'Confirm Decision'}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer Actions */}
        <div className="nm-candidate-detail-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            type="button"
            className="nm-btn nm-btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Close
          </button>

          {!confirmingAction ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              {isConflict ? (
                <>
                  <button
                    type="button"
                    className="nm-btn nm-btn-danger"
                    onClick={() => handleStartConflictResolution('deny_both')}
                    disabled={isInProgress || submitting || loading}
                    title={isInProgress ? 'Evaluation must be submitted before deciding' : undefined}
                    data-testid="deny-both-btn"
                  >
                    Deny Both
                  </button>
                  <button
                    type="button"
                    className="nm-btn nm-btn-primary"
                    onClick={() => handleStartConflictResolution('approve_winner_deny_loser')}
                    disabled={isInProgress || submitting || loading}
                    title={isInProgress ? 'Evaluation must be submitted before deciding' : undefined}
                    data-testid="approve-winner-btn"
                  >
                    Approve This Session
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="nm-btn nm-btn-danger"
                    onClick={() => handleStartDecide('denied')}
                    disabled={isInProgress || submitting || loading}
                    title={isInProgress ? 'Evaluation must be submitted before deciding' : undefined}
                    data-testid="deny-override-btn"
                  >
                    Deny Override
                  </button>
                  <button
                    type="button"
                    className="nm-btn nm-btn-primary"
                    onClick={() => handleStartDecide('approved')}
                    disabled={isInProgress || submitting || loading}
                    title={isInProgress ? 'Evaluation must be submitted before deciding' : undefined}
                    data-testid="approve-override-btn"
                  >
                    Approve Override
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
