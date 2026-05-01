import React from 'react';

const TYPE_LABELS = {
  info: 'Info',
  warning: 'Warning',
  urgent: 'Urgent',
  ticker: 'Ticker',
};

export default function NotificationBanner({
  notification,
  onDismiss,
  onAction,
}) {
  if (!notification) {
    return null;
  }

  const typeLabel = TYPE_LABELS[notification.type] || 'Notice';

  return (
    <div
      className={`notification-banner notification-banner-${notification.type}`}
      data-testid={`notification-banner-${notification.id}`}
      role="status"
      aria-live={notification.type === 'urgent' ? 'assertive' : 'polite'}
    >
      <div className="notification-banner-copy">
        <div className="notification-banner-meta">{typeLabel}</div>
        {notification.title ? <div className="notification-banner-title">{notification.title}</div> : null}
        <div className="notification-banner-message">{notification.message}</div>
      </div>

      <div className="notification-banner-actions">
        {notification.actionURL ? (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => onAction?.(notification)}>
            {notification.actionText || 'Open'}
          </button>
        ) : null}
        {!notification.persistent ? (
          <button
            className="notification-banner-dismiss"
            type="button"
            onClick={() => onDismiss?.(notification.id)}
            aria-label={`Dismiss ${notification.title || typeLabel} notification`}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
