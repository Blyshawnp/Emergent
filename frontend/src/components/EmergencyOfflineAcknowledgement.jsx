import React, { useState } from 'react';
import { WifiOff } from 'lucide-react';

export default function EmergencyOfflineAcknowledgement({
  candidateName,
  onCancel,
  onAcknowledge,
}) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="cmodal-overlay open">
      <div
        className="cmodal cmodal-warning"
        role="dialog"
        aria-modal="true"
        aria-label="Emergency Offline Override Acknowledgement"
        style={{ maxWidth: '540px', width: '90%' }}
      >
        <div className="cmodal-icon" style={{ color: 'var(--color-danger, #ef4444)' }}>
          <WifiOff size={40} />
        </div>
        <div className="cmodal-title">Emergency Offline Override</div>
        <div className="cmodal-body" style={{ textAlign: 'left', marginTop: '12px' }}>
          <p style={{ marginBottom: '12px' }}>
            The shared database server could not be reached to verify or reserve an online override for{' '}
            <b>{candidateName || 'this candidate'}</b>.
          </p>
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: '6px',
              padding: '12px',
              marginBottom: '16px',
              fontSize: '13px',
              color: 'var(--text-primary, #111827)',
            }}
          >
            <strong>Important Emergency Offline Policy (Option B):</strong>
            <ul style={{ paddingLeft: '20px', marginTop: '6px', marginBottom: 0 }}>
              <li style={{ marginBottom: '4px' }}>
                This session will be persisted locally with a temporary offline reservation.
              </li>
              <li style={{ marginBottom: '4px' }}>
                When connectivity returns, the session evaluation will sync to SAM for administrator review.
              </li>
              <li>
                <b>No automatic certification:</b> Passing results will remain uncertified until affirmatively
                authorized by an administrator.
              </li>
            </ul>
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              cursor: 'pointer',
              fontSize: '13px',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              style={{ marginTop: '3px' }}
            />
            <span>
              I understand that this candidate requires administrator authorization and that this offline
              evaluation will be subject to SAM administrator review before any certification can be issued.
            </span>
          </label>
        </div>
        <div className="cmodal-btns" style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-muted"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!acknowledged}
            onClick={onAcknowledge}
          >
            Acknowledge &amp; Start Offline
          </button>
        </div>
      </div>
    </div>
  );
}
