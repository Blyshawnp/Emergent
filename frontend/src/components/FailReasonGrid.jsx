import React from 'react';

function splitItems(items = []) {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

export default function FailReasonGrid({
  items = [],
  checked = {},
  onCheckedChange,
  details = {},
  onDetailsChange,
  expanded = {},
  onExpandedChange,
}) {
  const updateChecked = (reason) => {
    const isChecked = !!checked[reason];
    onCheckedChange((prev) => ({ ...prev, [reason]: !isChecked }));

    if (isChecked && reason !== 'Other') {
      onDetailsChange((prev) => {
        const next = { ...prev };
        delete next[reason];
        return next;
      });
      onExpandedChange((prev) => {
        const next = { ...prev };
        delete next[reason];
        return next;
      });
    }
  };

  const showDetail = (reason) => {
    onExpandedChange((prev) => ({ ...prev, [reason]: true }));
  };

  const updateDetail = (reason, value) => {
    onDetailsChange((prev) => ({ ...prev, [reason]: value }));
  };

  const renderItem = (reason) => {
    const isOther = reason === 'Other';
    const isChecked = !!checked[reason];
    const isExpanded = !!expanded[reason] || !!String(details[reason] || '').trim();

    return (
      <div key={reason} className="fail-reason-item">
        <div className="fail-reason-row">
          <label className="checkbox-label fail-reason-checkbox">
            <input type="checkbox" checked={isChecked} onChange={() => updateChecked(reason)} />
            <span>{reason}</span>
          </label>
          {isChecked && !isOther && !isExpanded && (
            <button type="button" className="fail-detail-toggle" onClick={() => showDetail(reason)}>
              + Add detail
            </button>
          )}
        </div>
        {isChecked && !isOther && isExpanded && (
          <div className="fail-detail-panel">
            <label className="fail-detail-label" htmlFor={`fail-detail-${reason.replace(/\W+/g, '-').toLowerCase()}`}>
              Optional detail for this fail reason
            </label>
            <textarea
              id={`fail-detail-${reason.replace(/\W+/g, '-').toLowerCase()}`}
              rows={2}
              value={details[reason] || ''}
              onChange={(event) => updateDetail(reason, event.target.value)}
              placeholder="What specifically happened?"
            />
          </div>
        )}
      </div>
    );
  };

  const [leftItems, rightItems] = splitItems(items);

  return (
    <div className="coaching-grid fail-reason-grid">
      <div>{leftItems.map(renderItem)}</div>
      <div>{rightItems.map(renderItem)}</div>
    </div>
  );
}
