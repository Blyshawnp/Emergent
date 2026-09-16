import React from 'react';

export default function ActiveCandidateHeader({ candidateName, className = '' }) {
  const name = String(candidateName || '').trim();
  if (!name) return null;
  return (
    <div className={`candidate-header ${className}`.trim()} data-testid="active-candidate-header">
      <span className="candidate-header-label">Candidate:</span> {name}
    </div>
  );
}
