import React from 'react';

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function getWorkflowProgress({ page, supervisorOnly = false, callNum = 1, transferNum = 1 }) {
  const normalizedCallNum = Math.max(1, Math.min(3, Number(callNum) || 1));
  const normalizedTransferNum = Math.max(1, Math.min(2, Number(transferNum) || 1));

  if (supervisorOnly) {
    switch (page) {
      case 'basics':
        return { percent: 20, label: 'Session setup' };
      case 'suptransfer':
        return {
          percent: normalizedTransferNum === 1 ? 60 : 80,
          label: `Supervisor transfer ${normalizedTransferNum} of 2`,
        };
      case 'newbieshift':
        return { percent: 90, label: 'Scheduling newbie shift' };
      case 'review':
        return { percent: 100, label: 'Review and finish' };
      default:
        return null;
    }
  }

  switch (page) {
    case 'basics':
      return { percent: 15, label: 'Session setup' };
    case 'calls': {
      const callPercents = { 1: 35, 2: 50, 3: 65 };
      return {
        percent: callPercents[normalizedCallNum],
        label: `Mock call ${normalizedCallNum} of 3`,
      };
    }
    case 'suptransfer':
      return {
        percent: normalizedTransferNum === 1 ? 82 : 90,
        label: `Supervisor transfer ${normalizedTransferNum} of 2`,
      };
    case 'newbieshift':
      return { percent: 92, label: 'Scheduling newbie shift' };
    case 'review':
      return { percent: 100, label: 'Review and finish' };
    default:
      return null;
  }
}

export default function WorkflowProgress({ percent, label }) {
  const safePercent = clampPercent(percent);

  return (
    <div className="workflow-progress" data-testid="workflow-progress">
      <div className="workflow-progress-header">
        <span className="workflow-progress-label">{label}</span>
        <span className="workflow-progress-percent">{safePercent}%</span>
      </div>
      <div className="workflow-progress-track" aria-hidden="true">
        <div className="workflow-progress-fill" style={{ width: `${safePercent}%` }} />
      </div>
    </div>
  );
}
