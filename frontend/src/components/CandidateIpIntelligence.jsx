import React, { useEffect, useMemo, useState } from 'react';
import api from '../api';

export const CANDIDATE_IP_INTELLIGENCE_STORAGE_KEY = 'mts_candidate_ip_intelligence';

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

function riskText(result) {
  if (!result) return 'Unknown';
  if (result.vpnProxy) return result.vpnProxy;
  const flags = result.flags || {};
  return ['vpn', 'proxy', 'hosting', 'datacenter', 'tor', 'residential_proxy'].some((key) => flags[key]) ? 'Yes' : 'No';
}

export function CandidateIpProviderTable({ results = [] }) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) {
    return <div className="text-sm text-muted">No provider results available.</div>;
  }
  return (
    <div className="ip-provider-table-wrap">
      <table className="ip-provider-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th>VPN / Proxy</th>
            <th>Last Seen</th>
            <th>ISP</th>
            <th>ASN</th>
            <th>Usage Type</th>
            <th>Country</th>
            <th>Region</th>
            <th>City</th>
            <th>Connection Type</th>
            <th>Confidence</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((result, index) => {
            const risky = riskText(result) === 'Yes';
            const failed = result.status && !['ok', 'metadata'].includes(result.status);
            return (
              <tr key={`${result.provider || 'provider'}-${index}`} className={risky ? 'ip-provider-conflict' : failed ? 'ip-provider-failed' : ''}>
                <td>{result.provider || 'Unknown'}</td>
                <td>{result.status || 'Unknown'}</td>
                <td>{riskText(result)}</td>
                <td>{result.lastSeen || 'N/A'}</td>
                <td>{result.isp || 'N/A'}</td>
                <td>{result.asn || 'N/A'}</td>
                <td>{result.usageType || 'N/A'}</td>
                <td>{result.country || 'N/A'}</td>
                <td>{result.region || 'N/A'}</td>
                <td>{result.city || 'N/A'}</td>
                <td>{result.connectionType || 'N/A'}</td>
                <td>{result.confidence || 'Unknown'}</td>
                <td>{result.notes || 'None'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CandidateIpResultSummary({ result }) {
  if (!result) return null;
  return (
    <div className={`ip-verdict-banner ${verdictClass(result.level)}`} data-testid="candidate-ip-verdict">
      <div>
        <div className="ip-verdict-label">Current Verdict</div>
        <div className="ip-verdict-value">{result.verdict || 'UNABLE TO VERIFY'}</div>
      </div>
      <div className="ip-verdict-summary">{result.summary || 'No summary available.'}</div>
    </div>
  );
}

export function CandidateIpReviewBlock({ result, notes, onNotesChange, readOnly = false }) {
  if (!result) return null;
  return (
    <div className="card candidate-ip-review-card" data-testid="candidate-ip-review">
      <h3>Candidate IP Intelligence</h3>
      <CandidateIpResultSummary result={result} />
      <div className="ip-review-grid">
        <div><strong>Candidate IP:</strong> {result.ip || 'N/A'}</div>
        <div><strong>Last Checked:</strong> {formatTimestamp(result.timestamp)}</div>
      </div>
      <div className="text-sm text-muted" style={{ marginTop: 10 }}>
        This is decision support only. It does not automatically determine the session result.
      </div>
      <details className="ip-provider-details" open>
        <summary>Provider Results</summary>
        <CandidateIpProviderTable results={result.providerResults} />
      </details>
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
    </div>
  );
}

export default function CandidateIpIntelligencePanel({ initialResult, onResultChange }) {
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState(initialResult?.ip || '');
  const [result, setResult] = useState(initialResult || null);
  const [validationMessage, setValidationMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [notes, setNotes] = useState(initialResult?.trainerNotes || '');

  const lastChecked = useMemo(() => formatTimestamp(result?.timestamp), [result]);

  useEffect(() => {
    setResult(initialResult || null);
    setIp(initialResult?.ip || '');
    setNotes(initialResult?.trainerNotes || '');
  }, [initialResult]);

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
      const next = { ...response, trainerNotes: notes };
      setResult(next);
      setProviderOpen(true);
      await persist(next);
    } catch (_error) {
      setValidationMessage('No IP reputation provider is currently available. Manual verification required.');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setIp('');
    setResult(null);
    setNotes('');
    setValidationMessage('');
    setProviderOpen(false);
    await persist(null);
  };

  const handleNotesChange = async (value) => {
    setNotes(value);
    if (!result) return;
    const next = { ...result, trainerNotes: value };
    setResult(next);
    storeCandidateIpIntelligence(next);
    onResultChange?.(next);
    try {
      const current = await api.getCurrentSession(3000);
      if (current?.has_active) {
        await api.updateSession({ candidate_ip_intelligence: next });
      }
    } catch (_error) {
      // Notes remain in sessionStorage if no active backend session exists yet.
    }
  };

  return (
    <div className="candidate-ip-card candidate-ip-card-embedded" data-testid="candidate-ip-intelligence">
      <button
        type="button"
        className="candidate-ip-card-toggle"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span>Candidate IP Intelligence</span>
        <span>{open ? 'Collapse' : 'Expand'}</span>
      </button>
      {!open && result && (
        <div className="candidate-ip-collapsed-summary">
          <span><strong>Last Checked:</strong> {lastChecked}</span>
          <span><strong>Current Verdict:</strong> {result.verdict || 'UNABLE TO VERIFY'}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Check Again</button>
          <button type="button" className="btn btn-muted btn-sm" onClick={handleClear}>Clear</button>
        </div>
      )}
      {open && (
        <div className="candidate-ip-body">
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
                <span><strong>Current Verdict:</strong> {result.verdict || 'UNABLE TO VERIFY'}</span>
              </div>
              <CandidateIpResultSummary result={result} />
              <label className="ip-trainer-notes">
                <span>Trainer Notes</span>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(event) => handleNotesChange(event.target.value)}
                  placeholder="Example: Candidate explained they were using a company VPN."
                  data-testid="candidate-ip-notes"
                />
              </label>
              <details className="ip-provider-details" open={providerOpen} onToggle={(event) => setProviderOpen(event.currentTarget.open)}>
                <summary>Provider Results</summary>
                <CandidateIpProviderTable results={result.providerResults} />
              </details>
            </>
          ) : (
            <div className="text-sm text-muted">
              This tool uses provider signals for decision support only. It never automatically fails a candidate.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
