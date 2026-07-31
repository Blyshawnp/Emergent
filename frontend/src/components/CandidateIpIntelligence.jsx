import React, { useEffect, useRef, useState } from 'react';

export function buildManualLookupLinks() {
  return [
    {
      label: 'IP2Location',
      desc: 'Review IP location and network details.',
      url: 'https://www.ip2location.com/demo',
    },
    {
      label: 'IPinfo',
      desc: 'Review IP ownership and network details.',
      url: 'https://ipinfo.io/',
    },
    {
      label: 'ip.teoh.io',
      desc: 'Review VPN-related IP information.',
      url: 'https://ip.teoh.io/',
    },
  ];
}

export default function CandidateIpIntelligencePanel() {
  const [open, setOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState('');
  const copyFeedbackTimerRef = useRef(null);
  const manualLinks = buildManualLookupLinks();

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
  }, []);

  const copyUrl = async (url) => {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    if (copyFeedbackTimerRef.current) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => setCopiedUrl(''), 1800);
  };

  return (
    <div className="candidate-ip-card candidate-ip-card-embedded candidate-ip-card-links candidate-ip-manual-simple" data-testid="candidate-ip-links">
      <button
        type="button"
        className="candidate-ip-card-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="candidate-ip-toggle-title">VPN / Proxy Lookup Sites</span>
        <span className="candidate-ip-toggle-action">{open ? 'Collapse' : 'Expand'}</span>
      </button>
      {!open && (
        <div className="candidate-ip-collapsed-summary">
          <span className="text-sm text-muted">Use these sites when a manual IP lookup is needed.</span>
        </div>
      )}
      {open && (
        <div className="candidate-ip-body">
          <div className="ip-manual-lookup ip-manual-lookup-compact" data-testid="candidate-ip-manual-links">
            <div className="ip-manual-header">
              <div>
                <div className="ip-manual-subtitle">Use these sites when a manual IP lookup is needed. Copy a link, open it in a browser, and enter the candidate’s IP on the website.</div>
              </div>
            </div>
            <div className="ip-manual-services-list">
              {manualLinks.map((link) => (
                <div key={link.label} className="ip-manual-service-row">
                  <div className="ip-manual-service-copy">
                    <div>
                      <div className="ip-manual-service-name">{link.label}</div>
                      <div className="ip-manual-service-desc">{link.desc}</div>
                    </div>
                  </div>
                  <div className="ip-manual-service-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => copyUrl(link.url)}
                      aria-label={`Copy ${link.label} link`}
                      data-testid={`candidate-ip-copy-url-${link.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                    >
                      <span aria-live="polite">{copiedUrl === link.url ? 'Copied' : 'Copy Link'}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
