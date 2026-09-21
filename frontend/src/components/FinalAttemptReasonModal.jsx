import React, { useState, useRef, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

export default function FinalAttemptReasonModal({
  onCancel,
  onConfirm,
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleConfirm = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('A mandatory written explanation is required to change Final Attempt from Yes to No.');
      textareaRef.current?.focus();
      return;
    }
    if (trimmed.toLowerCase() === 'tester confirmed final attempt yes to no override.') {
      setError('Please provide a specific explanation rather than the default confirmation text.');
      textareaRef.current?.focus();
      return;
    }
    setError('');
    onConfirm(trimmed);
  };

  return (
    <div className="cmodal-overlay open">
      <div
        className="cmodal cmodal-warning"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm Final Attempt Override"
        style={{ maxWidth: '500px', width: '90%' }}
      >
        <div className="cmodal-icon" style={{ color: 'var(--color-warning, #f59e0b)' }}>
          <AlertTriangle size={40} />
        </div>
        <div className="cmodal-title">Confirm Final Attempt Override</div>
        <div className="cmodal-body" style={{ textAlign: 'left', marginTop: '12px' }}>
          <p style={{ marginBottom: '12px' }}>
            This is the candidate's final currently authorized certification attempt. Changing Final Attempt
            to <b>No</b> will be recorded canonically and will notify SAM. This does not grant the candidate
            another attempt.
          </p>
          <label
            htmlFor="final-attempt-override-reason"
            style={{ display: 'block', fontWeight: 'bold', fontSize: '13px', marginBottom: '6px' }}
          >
            Mandatory Written Reason:
          </label>
          <textarea
            id="final-attempt-override-reason"
            ref={textareaRef}
            rows={3}
            className="form-control"
            style={{ width: '100%', resize: 'vertical', minHeight: '70px' }}
            placeholder="Explain why Final Attempt is being changed from Yes to No..."
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
            onClick={handleConfirm}
          >
            Confirm Override
          </button>
        </div>
      </div>
    </div>
  );
}
