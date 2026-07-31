import React from 'react';
import { resolveTickerDurationSeconds } from '../utils/notifications';

function getTickerMessage(notification) {
  if (!notification?.message) return '';
  if (notification.type === 'warning') return `WARNING: ${notification.message}`;
  if (notification.type === 'urgent') return `URGENT: ${notification.message}`;
  return notification.message;
}

function getTickerItemClass(notification) {
  if (notification?.type === 'urgent') return 'ticker-item ticker-item-urgent';
  if (notification?.type === 'warning') return 'ticker-item ticker-item-warning';
  return 'ticker-item ticker-item-info';
}

export default function MtsTickerBar({ notificationGroups, settings, appVersion }) {
  const notificationTickerMessages = notificationGroups.tickerMessages
    .map((notification) => ({
      id: notification.id,
      className: getTickerItemClass(notification),
      text: getTickerMessage(notification),
    }))
    .filter((notification) => notification.text);

  const tickerDurationSeconds = resolveTickerDurationSeconds(settings?.ticker_speed || 'normal');
  const tickerContent = notificationTickerMessages.length > 0
    ? notificationTickerMessages
    : [
        { id: 'default-welcome', className: 'ticker-item ticker-item-info', text: `Welcome to Mock Testing Suite v${appVersion}.` },
        { id: 'default-basics', className: 'ticker-item ticker-item-info', text: 'Complete The Basics before beginning call review.' },
        { id: 'default-headset', className: 'ticker-item ticker-item-info', text: 'Review headset requirements before certification begins.' },
        { id: 'default-discord', className: 'ticker-item ticker-item-info', text: 'Use Discord copy templates when posting session updates.' },
        { id: 'default-vpn', className: 'ticker-item ticker-item-warning', text: 'Confirm VPN/proxy checks manually when automated coverage is limited.' },
        { id: 'default-readiness', className: 'ticker-item ticker-item-info', text: 'Remember to review final readiness before submitting results.' },
        { id: 'default-fallback', className: 'ticker-item ticker-item-warning', text: 'If Google Sheets is unavailable, continue using local fallback guidance.' },
        { id: 'default-tip', className: 'ticker-item ticker-item-info', text: 'Tip: Use the Discord Post button to quickly copy common messages.' },
      ];

  return (
    <div className="ticker-bar" data-testid="ticker-bar" style={{ '--ticker-duration': `${tickerDurationSeconds}s` }}>
      <div className="ticker-track" data-testid="ticker-track">
        <span className="ticker-content">
          {tickerContent.map((item, index) => (
            <React.Fragment key={item.id || `ticker-${index}`}>
              {index > 0 ? <span className="ticker-separator" aria-hidden="true">{' \u25C6 '}</span> : null}
              <span className={item.className}>{item.text}</span>
            </React.Fragment>
          ))}
        </span>
      </div>
    </div>
  );
}
