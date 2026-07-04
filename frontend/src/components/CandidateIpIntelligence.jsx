import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';

export const CANDIDATE_IP_INTELLIGENCE_STORAGE_KEY = 'mts_candidate_ip_intelligence';
export const VPN_PROXY_CHECK_LABEL = 'VPN / Proxy Check';
export const VPN_PROXY_CHECK_MODES = {
  CHECKER: 'checker',
  LINKS: 'links',
  DISABLED: 'disabled',
};

const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_SEGMENT_PATTERN = /^[0-9a-fA-F]{1,4}$/;

export function loadStoredCandidateIpIntelligence() {
  try {
    const raw = window.sessionStorage.getItem(CANDIDATE_IP_INTELLIGENCE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

export function storeCandidateIpIntelligence(result) {
  try {
    if (result) {
      window.sessionStorage.setItem(CANDIDATE_IP_INTELLIGENCE_STORAGE_KEY, JSON.stringify(result));
    } else {
      window.sessionStorage.removeItem(CANDIDATE_IP_INTELLIGENCE_STORAGE_KEY);
    }
  } catch (_error) {
    // Session storage is a convenience cache only.
  }
}

function isValidIpv6(value) {
  const ip = String(value || '').trim();
  if (!ip.includes(':')) return false;
  if ((ip.match(/::/g) || []).length > 1) return false;
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  if (headParts.some((part) => !IPV6_SEGMENT_PATTERN.test(part))) return false;
  if (tailParts.some((part) => !IPV6_SEGMENT_PATTERN.test(part))) return false;
  const total = headParts.length + tailParts.length;
  if (ip.includes('::')) return total < 8;
  return total === 8;
}

export function validateIpAddress(value) {
  const ip = String(value || '').trim();
  if (!ip) return 'Enter the candidate public IP address.';
  if (IPV4_PATTERN.test(ip) || isValidIpv6(ip)) return '';
  return 'Enter a valid IPv4 or IPv6 address before checking providers.';
}

export function normalizeVpnProxyCheckMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return Object.values(VPN_PROXY_CHECK_MODES).includes(mode) ? mode : VPN_PROXY_CHECK_MODES.LINKS;
}

export function buildManualLookupLinks(ipValue) {
  const ip = String(ipValue || '').trim();
  const encoded = encodeURIComponent(ip);
  return [
    {
      label: 'IPQualityScore',
      desc: 'Strong VPN/proxy reputation',
      badge: 'VPN',
      url: ip ? `https://www.ipqualityscore.com/free-ip-lookup-proxy-vpn-test/lookup/${encoded}` : 'https://www.ipqualityscore.com/free-ip-lookup-proxy-vpn-test',
    },
    {
      label: 'ProxyCheck.io',
      desc: 'VPN/proxy detection',
      badge: 'Proxy',
      url: 'https://proxycheck.io/',
    },
    {
      label: 'GetIPIntel',
      desc: 'Residential vs proxy reputation',
      badge: 'Geo',
      url: 'https://getipintel.net/',
    },
    {
      label: 'IP2Location',
      desc: 'IP intelligence and ASN',
      badge: 'ASN',
      url: ip ? `https://www.ip2location.com/demo/${encoded}` : 'https://www.ip2location.com/demo',
    },
  ];
}

function formatTimestamp(value) {
  if (!value) return 'Not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function verdictClass(level) {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'green') return 'ip-verdict-green';
  if (normalized === 'yellow') return 'ip-verdict-yellow';
  if (normalized === 'red') return 'ip-verdict-red';
  return 'ip-verdict-gray';
}

export function vpnProxyNeedsTesterDecision(result) {
  const verdict = String(result?.verdict || '').trim().toUpperCase();
  return verdict === 'REVIEW' || verdict === 'VPN / PROXY LIKELY';
}

function riskText(result) {
  if (!result) return 'Unknown';
  if (result.status === 'not configured') return 'Not configured';
  if (result.status === 'timeout') return 'Timeout';
  if (result.status === 'failed') return 'Failed';
  if (result.status === 'disabled') return 'Disabled';
  if (result.capability === 'metadata_only' || result.reputationCapable === false) return 'Metadata only';
  if (result.vpnProxy) return result.vpnProxy;
  const flags = result.flags || {};
  return ['vpn', 'proxy', 'hosting', 'datacenter', 'tor', 'residential_proxy'].some((key) => flags[key]) ? 'Yes' : 'No';
}

function isDetectorResult(result) {
  return result?.capability === 'vpn_proxy_detector' && result.reputationCapable !== false;
}

function isMetadataResult(result) {
  return result?.capability === 'metadata_only' || result?.reputationCapable === false;
}

function providerCapabilityText(result) {
  return isDetectorResult(result) ? 'VPN/proxy detector' : 'Metadata only';
}

function successfulDetectorCount(results = []) {
  return results.filter((result) => result.status === 'ok' && isDetectorResult(result)).length;
}

function successfulMetadataCount(results = []) {
  return results.filter((result) => ['ok', 'metadata'].includes(result.status) && isMetadataResult(result)).length;
}

function firstProviderValue(results = [], key, predicate = () => true) {
  const row = results.find((result) => predicate(result) && String(result?.[key] || '').trim());
  return row ? row[key] : '';
}

function summaryConfidence(result, detectorCount, metadataCount) {
  if (result?.confidence) return result.confidence;
  const verdict = String(result?.verdict || '').toUpperCase();
  if (detectorCount <= 0) return 'Unknown';
  if (verdict === 'CLEAR' || verdict === 'VPN / PROXY LIKELY') return detectorCount >= 2 ? 'High' : 'Medium';
  if (verdict === 'REVIEW') return detectorCount >= 2 ? 'Medium' : 'Low';
  return metadataCount ? 'Low' : 'Unknown';
}

function displayVerdictText(result) {
  if (!result) return 'UNABLE TO VERIFY';
  const rows = Array.isArray(result.providerResults) ? result.providerResults : [];
  const detectorCount = Number.isFinite(Number(result.detectorProviderCount)) ? Number(result.detectorProviderCount) : successfulDetectorCount(rows);
  if (String(result.verdict || '').toUpperCase() === 'CLEAR' && detectorCount < 2) {
    return 'CLEAR — LIMITED CHECK';
  }
  return result.verdict || 'UNABLE TO VERIFY';
}

function primaryWarningText(result, detectorCount) {
  if (detectorCount <= 0) return 'No VPN/proxy reputation provider is currently available. Manual verification required.';
  if (result?.warning) return result.warning;
  if (detectorCount < 2) return 'Only one VPN/proxy detector is currently available. Verify manually if this result is important.';
  return '';
}

function shouldShowManualFallback(result) {
  if (!result) return false;
  const verdict = String(result.verdict || '').toUpperCase();
  const detectorCount = Number(result.detectorProviderCount || 0);
  return detectorCount < 2
    || verdict.includes('LIMITED')
    || verdict.includes('VERIFY')
    || verdict === 'REVIEW'
    || verdict === 'UNABLE TO VERIFY'
    || Boolean(result.warning);
}

function shouldOpenTechnicalDetails(result) {
  if (!result) return false;
  const verdict = String(result.verdict || '').toUpperCase();
  return verdict === 'REVIEW' || verdict === 'VPN / PROXY LIKELY' || verdict === 'UNABLE TO VERIFY' || verdict.includes('MIXED');
}

function ModeBadge({ mode }) {
  const label = mode === VPN_PROXY_CHECK_MODES.CHECKER ? 'Integrated Check' : mode === VPN_PROXY_CHECK_MODES.DISABLED ? 'Disabled' : 'Manual Verification';
  return <span className={`candidate-ip-mode-badge candidate-ip-mode-${mode}`}>{label}</span>;
}

function ManualLookupBlock({ ip, links, onOpenLink, onCopyIp, copiedIp, compact = false }) {
  return (
    <div className={`ip-manual-lookup ${compact ? 'ip-manual-lookup-compact' : ''}`} data-testid="candidate-ip-manual-links">
      <div className="ip-manual-header">
        <div>
          <div className="ip-manual-title">Recommended manual lookup links</div>
          <div className="ip-manual-subtitle">Copy the candidate IP, then verify with one or more external services.</div>
        </div>
        <button type="button" className="btn btn-muted btn-sm" onClick={onCopyIp} disabled={!ip}>
          {copiedIp ? 'Copied!' : 'Copy IP'}
        </button>
      </div>
      <div className="ip-manual-services-list">
        {links.map((link) => (
          <div key={link.label} className="ip-manual-service-row">
            <div className="ip-manual-service-copy">
              <span className="ip-manual-service-badge">{link.badge}</span>
              <div>
                <div className="ip-manual-service-name">{link.label}</div>
                <div className="ip-manual-service-desc">{link.desc}</div>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onOpenLink(link.url)}
              data-testid={`candidate-ip-link-${link.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            >
              Open Lookup
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderSummaryTable({ title, rows = [] }) {
  if (!rows.length) return null;
  return (
    <div className="ip-provider-group">
      <div className="ip-provider-group-title">{title}</div>
      <div className="ip-provider-table-wrap ip-provider-table-wrap-simple">
        <table className="ip-provider-table ip-provider-table-simple">
          <thead>
            <tr>
              <th style={{ width: '35%' }}>Provider</th>
              <th style={{ width: '20%' }}>Result</th>
              <th style={{ width: '25%' }}>Capability</th>
              <th style={{ width: '12%' }}>Last Seen</th>
              <th style={{ width: '8%' }}>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((result, index) => {
              const risky = isDetectorResult(result) && riskText(result) === 'Yes';
              const failed = result.status && !['ok', 'metadata'].includes(result.status);
              return (
                <tr key={`${title}-${result.provider || 'provider'}-${index}`} className={risky ? 'ip-provider-conflict' : failed ? 'ip-provider-failed' : ''}>
                  <td style={{ whiteSpace: 'nowrap', minWidth: '120px' }}>{result.provider || 'Unknown'}</td>
                  <td>{riskText(result)}</td>
                  <td>{providerCapabilityText(result)}</td>
                  <td>{result.lastSeen || 'N/A'}</td>
                  <td>{result.confidence || 'Unknown'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdvancedProviderMetadata({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <details className="ip-provider-advanced">
      <summary>Show advanced provider metadata</summary>
      <div className="ip-provider-table-wrap ip-provider-table-wrap-advanced">
        <table className="ip-provider-table ip-provider-table-advanced">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Status</th>
              <th>ISP</th>
              <th>ASN</th>
              <th>Usage Type</th>
              <th>Country</th>
              <th>Region</th>
              <th>City</th>
              <th>Connection Type</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((result, index) => (
              <tr key={`advanced-${result.provider || 'provider'}-${index}`}>
                <td>{result.provider || 'Unknown'}</td>
                <td>{result.status || 'Unknown'}</td>
                <td>{result.isp || 'N/A'}</td>
                <td>{result.asn || 'N/A'}</td>
                <td>{result.usageType || 'N/A'}</td>
                <td>{result.country || 'N/A'}</td>
                <td>{result.region || 'N/A'}</td>
                <td>{result.city || 'N/A'}</td>
                <td>{result.connectionType || 'N/A'}</td>
                <td>{result.notes || result.error || 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function CandidateIpProviderTable({ results = [] }) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) {
    return <div className="text-sm text-muted">No provider results available.</div>;
  }
  const detectorRows = rows.filter(isDetectorResult);
  const metadataRows = rows.filter((result) => !isDetectorResult(result));
  return (
    <div className="ip-provider-details-body">
      <ProviderSummaryTable title="Detector providers" rows={detectorRows} />
      <ProviderSummaryTable title="Metadata providers" rows={metadataRows} />
      <AdvancedProviderMetadata rows={rows} />
    </div>
  );
}

export function CandidateIpResultSummary({ result }) {
  if (!result) return null;
  const rows = Array.isArray(result.providerResults) ? result.providerResults : [];
  const detectorCount = Number.isFinite(Number(result.detectorProviderCount)) ? Number(result.detectorProviderCount) : successfulDetectorCount(rows);
  const metadataCount = Number.isFinite(Number(result.metadataProviderCount)) ? Number(result.metadataProviderCount) : successfulMetadataCount(rows);
  const limitedClear = String(result.verdict || '').toUpperCase() === 'CLEAR' && detectorCount < 2;
  const displayVerdict = limitedClear ? 'CLEAR — LIMITED CHECK' : (result.verdict || 'UNABLE TO VERIFY');
  const displayLevel = limitedClear ? 'yellow' : result.level;
  const displaySummary = limitedClear
    ? 'No VPN or proxy signals detected, but fewer than two detector providers responded. Verify manually if this result is important.'
    : (result.summary || 'No summary available.');
  const primaryIsp = firstProviderValue(rows, 'isp', isDetectorResult) || firstProviderValue(rows, 'isp');
  const usageType = firstProviderValue(rows, 'usageType', isDetectorResult) || firstProviderValue(rows, 'usageType');
  const lastSeen = result.lastSeen || firstProviderValue(rows, 'lastSeen');
  const warning = primaryWarningText(result, detectorCount);
  return (
    <div className={`ip-verdict-banner ${verdictClass(displayLevel)}`} data-testid="candidate-ip-verdict">
      <div className="ip-verdict-heading">
        <div className="ip-verdict-label">Verdict</div>
        <div className="ip-verdict-value">{displayVerdict}</div>
      </div>
      <div className="ip-verdict-summary">
        <div className="ip-summary-copy">{displaySummary}</div>
        <div className="ip-summary-list">
          <div className="ip-summary-row"><span className="ip-summary-label">Confidence:</span> <strong>{summaryConfidence(result, detectorCount, metadataCount)}</strong></div>
          <div className="ip-summary-row"><span className="ip-summary-label">Providers checked:</span> <strong>{detectorCount + metadataCount} of {rows.length}</strong></div>
          <div className="ip-summary-row"><span className="ip-summary-label">Detectors:</span> <strong>{detectorCount}</strong></div>
          <div className="ip-summary-row"><span className="ip-summary-label">Metadata sources:</span> <strong>{metadataCount}</strong></div>
          {primaryIsp ? <div className="ip-summary-row"><span className="ip-summary-label">ISP:</span> <strong>{primaryIsp}</strong></div> : null}
          {usageType ? <div className="ip-summary-row"><span className="ip-summary-label">Connection:</span> <strong>{usageType}</strong></div> : null}
          {lastSeen ? <div className="ip-summary-row"><span className="ip-summary-label">Last Seen:</span> <strong>{lastSeen}</strong></div> : null}
        </div>
        {warning ? (
          <div className="ip-detector-warning" data-testid="candidate-ip-detector-warning">{warning}</div>
        ) : null}
      </div>
    </div>
  );
}

export function CandidateIpReviewBlock({ result, notes, onNotesChange, readOnly = false, showTrainerNotes = false }) {
  if (!result) return null;
  return (
    <div className="card candidate-ip-review-card" data-testid="candidate-ip-review">
      <h3>{VPN_PROXY_CHECK_LABEL}</h3>
      <CandidateIpResultSummary result={result} />
      <div className="ip-review-grid">
        <div><strong>Candidate IP:</strong> {result.ip || 'N/A'}</div>
        <div><strong>Last Checked:</strong> {formatTimestamp(result.timestamp)}</div>
      </div>
      <div className="text-sm text-muted" style={{ marginTop: 10 }}>
        This is decision support only. The tester always makes the final decision.
      </div>
      <details className="ip-provider-details">
        <summary>Show technical details</summary>
        <CandidateIpProviderTable results={result.providerResults} />
      </details>
      {showTrainerNotes ? (
        <label className="ip-trainer-notes">
          <span>Trainer Notes</span>
          <textarea
            rows={3}
            value={notes || ''}
            onChange={(event) => onNotesChange?.(event.target.value)}
            readOnly={readOnly}
            placeholder="Example: Candidate explained they were using a company VPN."
            data-testid="candidate-ip-trainer-notes"
          />
        </label>
      ) : null}
    </div>
  );
}

export default function CandidateIpIntelligencePanel({ initialResult, onResultChange, mode = VPN_PROXY_CHECK_MODES.LINKS }) {
  const resolvedMode = normalizeVpnProxyCheckMode(mode);
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState(initialResult?.ip || '');
  const [result, setResult] = useState(initialResult || null);
  const [validationMessage, setValidationMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [copiedIp, setCopiedIp] = useState(false);

  const handleCopyIp = async () => {
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      setCopiedIp(true);
      setTimeout(() => setCopiedIp(false), 2000);
    } catch (e) {
      console.error('Failed to copy IP', e);
    }
  };

  const lastChecked = useMemo(() => formatTimestamp(result?.timestamp), [result]);
  const manualLinks = useMemo(() => buildManualLookupLinks(ip), [ip]);

  useEffect(() => {
    setResult(initialResult || null);
    setIp(initialResult?.ip || '');
  }, [initialResult]);

  useEffect(() => {
    setProviderOpen(shouldOpenTechnicalDetails(result));
  }, [result]);

  const persist = async (nextResult) => {
    storeCandidateIpIntelligence(nextResult);
    onResultChange?.(nextResult);
    try {
      const current = await api.getCurrentSession(3000);
      if (current?.has_active) {
        await api.updateSession({ candidate_ip_intelligence: nextResult });
      }
    } catch (_error) {
      // The result is still retained for the session start payload.
    }
  };

  const handleCheck = async () => {
    const message = validateIpAddress(ip);
    setValidationMessage(message);
    if (message) return;
    setLoading(true);
    try {
      const response = await api.checkIpIntelligence(ip.trim());
      if (!response?.ok) {
        setValidationMessage(response?.error || 'IP lookup could not be completed.');
        return;
      }
      const next = { ...response };
      setResult(next);
      setProviderOpen(shouldOpenTechnicalDetails(next));
      await persist(next);
    } catch (_error) {
      setValidationMessage('No VPN/proxy reputation provider available. Manual verification required.');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setIp('');
    setResult(null);
    setValidationMessage('');
    setProviderOpen(false);
    await persist(null);
  };

  const openManualLink = async (url) => {
    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  if (resolvedMode === VPN_PROXY_CHECK_MODES.DISABLED) {
    return (
      <div className="candidate-ip-card candidate-ip-card-embedded candidate-ip-card-disabled" data-testid="candidate-ip-disabled">
        <div className="candidate-ip-static-title">{VPN_PROXY_CHECK_LABEL}</div>
        <div className="candidate-ip-mode-row">
          <ModeBadge mode={resolvedMode} />
        </div>
        <div className="text-sm text-muted">Built-in VPN / Proxy Check is disabled. Use manual verification if needed.</div>
      </div>
    );
  }

  if (resolvedMode === VPN_PROXY_CHECK_MODES.LINKS) {
    return (
      <div className="candidate-ip-card candidate-ip-card-embedded candidate-ip-card-links" data-testid="candidate-ip-links">
        <button
          type="button"
          className="candidate-ip-card-toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          <span>{VPN_PROXY_CHECK_LABEL} <ModeBadge mode={resolvedMode} /></span>
          <span>{open ? 'Collapse' : 'Expand'}</span>
        </button>
        {!open && (
          <div className="candidate-ip-collapsed-summary">
            <span className="text-sm text-muted">Use manual lookup links to verify candidate VPN status.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Show details</button>
          </div>
        )}
        {open && (
          <div className="candidate-ip-body">
            <div className="candidate-ip-mode-helper">
              Manual lookup is the release-safe default. Use one or more trusted lookup services below to verify if the candidate IP is associated with a VPN or proxy.
            </div>

            <div className="candidate-ip-input-row" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', margin: '1rem 0' }}>
              <label style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 600, marginBottom: '0.25rem', fontSize: '13px' }}>Candidate IP Address</span>
                <input
                  type="text"
                  value={ip}
                  onChange={(event) => setIp(event.target.value)}
                  placeholder="IPv4 or IPv6"
                  data-testid="candidate-ip-manual-input"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #ccc)' }}
                />
              </label>
              <button
                type="button"
                className="btn btn-muted"
                onClick={handleCopyIp}
                style={{ width: '100px', height: '36px' }}
                disabled={!ip}
              >
                {copiedIp ? 'Copied!' : 'Copy IP'}
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {manualLinks.map((link) => (
                <div key={link.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.05)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--border-color, #eee)' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>{link.label}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{link.desc}</div>
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => openManualLink(link.url)} data-testid={`candidate-ip-link-${link.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>Open</button>
                </div>
              ))}
            </div>

            <div className="text-xs text-muted" style={{ fontStyle: 'italic', marginTop: '1rem' }}>
              Integrated automated VPN verification may be available if configured by your administrator.
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="candidate-ip-card candidate-ip-card-embedded" data-testid="candidate-ip-intelligence">
      <button
        type="button"
        className="candidate-ip-card-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span>{VPN_PROXY_CHECK_LABEL} <ModeBadge mode={resolvedMode} /></span>
        <span>{open ? 'Collapse' : 'Expand'}</span>
      </button>
      {!open && result && (
        <div className="candidate-ip-collapsed-summary">
          <span><strong>Last Checked:</strong> {lastChecked}</span>
          <span><strong>Current Verdict:</strong> {displayVerdictText(result)}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Check Again</button>
          <button type="button" className="btn btn-muted btn-sm" onClick={handleClear}>Clear</button>
        </div>
      )}
      {open && (
        <div className="candidate-ip-body">
          <div className="candidate-ip-mode-helper">Integrated checks require configured providers. Manual links appear whenever coverage is limited.</div>
          <div className="candidate-ip-input-row">
            <label>
              <span>Candidate Public IP Address</span>
              <input
                type="text"
                value={ip}
                onChange={(event) => {
                  setIp(event.target.value);
                  if (validationMessage) setValidationMessage('');
                }}
                placeholder="IPv4 or IPv6"
                data-testid="candidate-ip-input"
              />
            </label>
            <div className="candidate-ip-actions">
              <button type="button" className="btn btn-primary" onClick={handleCheck} disabled={loading}>
                {loading ? 'Checking...' : 'Check IP'}
              </button>
              <button type="button" className="btn btn-muted" onClick={handleClear} disabled={loading}>Clear</button>
            </div>
          </div>
          {validationMessage && <div className="ip-validation-message">{validationMessage}</div>}
          {result ? (
            <>
              <div className="candidate-ip-meta-row">
                <span><strong>Last Checked:</strong> {lastChecked}</span>
                <span><strong>Current Verdict:</strong> {displayVerdictText(result)}</span>
              </div>
              <CandidateIpResultSummary result={result} />
              {shouldShowManualFallback(result) ? (
                <ManualLookupBlock ip={ip || result.ip} links={manualLinks} onOpenLink={openManualLink} onCopyIp={handleCopyIp} copiedIp={copiedIp} compact />
              ) : null}
              {vpnProxyNeedsTesterDecision(result) ? (
                <div className="ip-decision-reminder" data-testid="candidate-ip-decision-reminder">
                  If the candidate turns off a VPN/proxy, wait 2-3 minutes before checking again. Reputation and routing services may take a few minutes to reflect the change.
                </div>
              ) : null}
              <details className="ip-provider-details" open={providerOpen} onToggle={(event) => setProviderOpen(event.currentTarget.open)}>
                <summary>{providerOpen ? 'Hide technical details' : 'Show technical details'}</summary>
                <CandidateIpProviderTable results={result.providerResults} />
              </details>
            </>
          ) : (
            <div className="text-sm text-muted">
              This tool checks VPN/proxy reputation signals for decision support only. It never automatically fails a candidate.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
