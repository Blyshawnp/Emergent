import React, { useEffect, useRef, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import {
  NEWBIE_REQUESTED_BY,
  RESCHEDULE_REASONS,
  splitCandidateFirstName,
} from '../utils/certificationWorkflow';

const REQUESTER_CHOICES = [
  { value: NEWBIE_REQUESTED_BY.CANDIDATE, label: 'Candidate' },
  { value: NEWBIE_REQUESTED_BY.TESTER, label: 'Tester/Trainer' },
  { value: NEWBIE_REQUESTED_BY.OTHER, label: 'Other' },
];

export default function RescheduleIntakeModal({ record, onCancel, onContinue, submitting = false }) {
  const [requestedBy, setRequestedBy] = useState('');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  const firstChoiceRef = useRef(null);
  const candidate = splitCandidateFirstName(record?.candidate_name || record?.candidate);

  useEffect(() => {
    const previousFocus = document.activeElement;
    firstChoiceRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) previousFocus.focus();
    };
  }, []);

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!submitting) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) || []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async () => {
    if (!requestedBy) {
      setError('Select who needs the Newbie Shift rescheduled.');
      return;
    }
    if (!reason) {
      setError('Select a reason for the reschedule.');
      return;
    }
    if (reason === 'Other' && !details.trim()) {
      setError('Enter the reason for rescheduling when Other is selected.');
      return;
    }
    await onContinue({ requestedBy, reason, details: details.trim() });
  };

  return (
    <div
      className="modal-overlay open"
      data-testid="reschedule-intake-modal"
      data-modal-layer="workflow-child"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="modal reschedule-intake-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-intake-title"
        onKeyDown={handleDialogKeyDown}
      >
        <div className="modal-header">
          <h2 id="reschedule-intake-title"><CalendarClock size={24} aria-hidden="true" /> Reschedule Newbie Shift</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cancel reschedule">×</button>
        </div>
        <div className="modal-body">
          <fieldset className="reschedule-intake-fieldset">
            <legend>Who needs to reschedule?</legend>
            <div className="reschedule-requester-grid" role="radiogroup" aria-label="Who needs to reschedule?">
              {REQUESTER_CHOICES.map((choice, index) => (
                <button
                  key={choice.value}
                  ref={index === 0 ? firstChoiceRef : undefined}
                  type="button"
                  role="radio"
                  aria-checked={requestedBy === choice.value}
                  className={`reschedule-radio-card ${requestedBy === choice.value ? 'is-selected' : ''}`}
                  onClick={() => { setRequestedBy(choice.value); setError(''); }}
                  data-testid={`reschedule-intake-requester-${choice.value}`}
                >
                  <span className="reschedule-radio-mark" aria-hidden="true" />
                  {choice.value === NEWBIE_REQUESTED_BY.CANDIDATE ? `${choice.label} (${candidate})` : choice.label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="reschedule-intake-fieldset">
            <legend>Reason for rescheduling</legend>
            <div className="reschedule-reason-grid" role="radiogroup" aria-label="Reason for rescheduling">
              {RESCHEDULE_REASONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="radio"
                  aria-checked={reason === item}
                  className={`reschedule-radio-card ${reason === item ? 'is-selected' : ''}`}
                  onClick={() => { setReason(item); setError(''); }}
                  data-testid={`reschedule-intake-reason-${item.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <span className="reschedule-radio-mark" aria-hidden="true" />
                  {item}
                </button>
              ))}
            </div>
            <label className="reschedule-details-label" htmlFor="reschedule-intake-details">
              <span>{reason === 'Other' ? 'Reason details (required)' : 'Additional details (optional)'}</span>
              <textarea
                id="reschedule-intake-details"
                rows={4}
                value={details}
                onChange={(event) => { setDetails(event.target.value); setError(''); }}
                aria-required={reason === 'Other'}
                data-testid="reschedule-intake-details"
              />
            </label>
          </fieldset>
          {error ? <div className="form-error" role="alert" data-testid="reschedule-intake-error">{error}</div> : null}
        </div>
        <div className="modal-footer-actions reschedule-intake-actions">
          <button type="button" className="btn btn-muted" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting} data-testid="reschedule-intake-continue">
            {submitting ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </section>
    </div>
  );
}
