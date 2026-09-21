import React, { useState, useRef, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export default function AdditionalAttemptModal({
  candidateName,
  attemptNumber = 4,
  onCancel,
  onProceed,
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const textareaRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  const handleProceed = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('A written reason is required to proceed with an Additional Attempt Override.');
      textareaRef.current?.focus();
      return;
    }
    setError('');
    onProceed(trimmed);
  };

  return (
    <div className="cmodal-overlay open" onKeyDown={handleKeyDown}>
      <div
        className="cmodal cmodal-warning"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Additional Attempt Authorization Required"
        style={{ maxWidth: '520px', width: '90%' }}
      >
        <div className="cmodal-icon" style={{ color: 'var(--color-warning, #f59e0b)' }}>
          <AlertTriangle size={40} />
        </div>
        <div className="cmodal-title">Additional Attempt Authorization Required</div>
        <div className="cmodal-body" style={{ textAlign: 'left', marginTop: '12px' }}>
          <p style={{ marginBottom: '12px' }}>
            <b>{candidateName || 'This candidate'}</b> has reached the standard limit of authorized
            certification attempts. Starting this session will request <b>Attempt {attemptNumber}</b> as an
            Additional Attempt Override.
          </p>
          <div
            style={{
              background: 'var(--bg-secondary, #f3f4f6)',
              padding: '10px 14px',
              borderRadius: '6px',
              marginBottom: '14px',
              fontSize: '13px',
              color: 'var(--text-secondary, #4b5563)',
            }}
          >
            <strong>Administrative Requirement:</strong> A reservation will be recorded immediately.
            The final result will require affirmative administrator authorization in SAM before
            certification clearance can be granted.
          </div>
          <label
            htmlFor="additional-attempt-reason"
            style={{ display: 'block', fontWeight: 'bold', fontSize: '13px', marginBottom: '6px' }}
          >
            Mandatory Written Reason:
          </label>
          <textarea
            id="additional-attempt-reason"
            ref={textareaRef}
            rows={3}
            className="form-control"
            style={{ width: '100%', resize: 'vertical', minHeight: '70px' }}
            placeholder="Explain why an additional attempt is required (e.g., technical failure, approved retake)..."
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError('');
            }}
          />
          {error && (
            <div
              style={{
                color: 'var(--color-danger, #ef4444)',
                fontSize: '12px',
                marginTop: '6px',
                fontWeight: '500',
              }}
            >
              {error}
            </div>
          )}
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
            onClick={handleProceed}
          >
            Proceed with Additional Attempt
          </button>
        </div>
      </div>
    </div>
  );
}
