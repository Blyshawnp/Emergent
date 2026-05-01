import React, { useState, useEffect, useMemo, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
const SUP_ONLY_MODE_KEY = 'mts_sup_transfer_only_mode';
const HEADSET_HELPER_TEXT = '*If the brand/model is not listed, confirm it is USB and has a noise-cancelling microphone. Unsure? Post in Discord Tester Room.';

function hasBasicsDraft(form) {
  return Boolean(
    String(form.candidate_name || '').trim() ||
    form.final_attempt ||
    form.headset_usb !== null ||
    form.noise_cancel !== null ||
    String(form.headset_brand || '').trim() ||
    form.vpn_on !== null ||
    form.vpn_off !== null ||
    form.chrome_default !== null ||
    form.extensions_disabled !== null ||
    form.popups_allowed !== null
  );
}

export default function BasicsPage({ onNavigate }) {
  const modal = useModal();
  const [settings, setSettings] = useState({});
  const [techOpen, setTechOpen] = useState(false);
  const [supervisorOnlyMode, setSupervisorOnlyMode] = useState(false);
  const [headsetLookupOpen, setHeadsetLookupOpen] = useState(false);
  const [headsetQuery, setHeadsetQuery] = useState('');
  const [approvedHeadsets, setApprovedHeadsets] = useState([]);
  const [headsetLookupError, setHeadsetLookupError] = useState('');
  const [headsetLookupLoading, setHeadsetLookupLoading] = useState(true);
  const [form, setForm] = useState({
    candidate_name: '', tester_name: '', final_attempt: false,
    headset_usb: null, noise_cancel: null, headset_brand: '',
    vpn_on: null, vpn_off: null, chrome_default: null, extensions_disabled: null, popups_allowed: null,
  });
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [currentSettings, sessionResponse, headsetResponse] = await Promise.all([
          api.getSettings(),
          api.getCurrentSession(),
          api.getApprovedHeadsets().catch((error) => ({ groups: [], error: error.message || 'Unable to load the approved headset list right now.' })),
        ]);
        if (cancelled) return;

        const session = sessionResponse?.session || null;
        const storedSupervisorOnly = Boolean(session?.supervisor_only) || window.sessionStorage.getItem(SUP_ONLY_MODE_KEY) === '1';
        setSupervisorOnlyMode(storedSupervisorOnly);
        setSettings(currentSettings);
        setForm((prev) => ({
          ...prev,
          tester_name: currentSettings.tester_name || '',
          ...(session ? {
            candidate_name: session.candidate_name || '',
            tester_name: session.tester_name || currentSettings.tester_name || '',
            final_attempt: !!session.final_attempt,
            headset_usb: session.headset_usb ?? null,
            noise_cancel: session.noise_cancel ?? null,
            headset_brand: session.headset_brand || '',
            vpn_on: session.vpn_on ?? null,
            vpn_off: session.vpn_off ?? null,
            chrome_default: session.chrome_default ?? null,
            extensions_disabled: session.extensions_disabled ?? null,
            popups_allowed: session.popups_allowed ?? null,
          } : {}),
        }));

        setApprovedHeadsets(headsetResponse.groups || []);
        setHeadsetLookupError(headsetResponse.error || '');
      } catch (_error) {
        if (cancelled) return;
        setHeadsetLookupError('Unable to load the approved headset list right now. You can still type the headset manually.');
      } finally {
        if (!cancelled) {
          setHeadsetLookupLoading(false);
          hydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current || !hasBasicsDraft(form)) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      api.updateSession({
        ...form,
        supervisor_only: supervisorOnlyMode,
        status: 'In Progress',
      }).catch(() => {});
    }, 250);

    return () => window.clearTimeout(timer);
  }, [form, supervisorOnlyMode]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const filteredHeadsets = useMemo(() => {
    const query = headsetQuery.trim().toLowerCase();
    if (!query) return approvedHeadsets;

    return approvedHeadsets
      .map((group) => {
        const brandMatches = group.brand.toLowerCase().includes(query);
        const models = brandMatches
          ? group.models
          : group.models.filter((model) => model.toLowerCase().includes(query));

        return { ...group, models };
      })
      .filter((group) => group.models.length > 0);
  }, [approvedHeadsets, headsetQuery]);

  const handleDiscardSession = async () => {
    const confirmed = await modal.confirmDanger('Discard Session', 'Discard the current session draft and lose all progress?');
    if (!confirmed) return;
    await api.discardSession();
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    onNavigate('home');
  };

  const autoFail = async (reason) => {
    if (!form.candidate_name.trim()) { await modal.warning('Missing Info', 'Enter the Candidate Name first.'); return; }
    let body = '';
    if (reason === 'NC/NS') {
      body = `This will Automatically fail ${form.candidate_name.trim()} and mark as a NC/NS. Do you want to proceed?`;
    } else if (reason === 'Not Ready for Session') {
      body = `This will Automatically fail ${form.candidate_name.trim()} and mark as Not Ready for Session. Do you want to proceed?`;
    } else {
      body = `This will Automatically fail ${form.candidate_name.trim()} and mark as Stopped Responding in Chat. Do you want to proceed?`;
    }
    const confirmed = await modal.confirm('Confirm Auto-Fail', body, 'alert-triangle', 'warning');
    if (!confirmed) return;
    const data = { ...form, supervisor_only: supervisorOnlyMode, auto_fail_reason: reason, final_status: 'Fail' };
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await api.startSession(data);
    onNavigate('review');
  };

  const handleContinue = async () => {
    const d = form;
    if (!d.candidate_name.trim()) { await modal.warning('Missing Info', 'Candidate Name is required.'); return; }
    if (d.headset_usb === null || d.noise_cancel === null || !d.headset_brand.trim()) { await modal.warning('Missing Info', 'All Headset fields are required.'); return; }
    if (d.vpn_on === null) { await modal.warning('Missing Info', 'VPN question must be answered.'); return; }
    if (d.vpn_on && d.vpn_off === null) { await modal.warning('Missing Info', 'Please confirm if the candidate can turn off their VPN.'); return; }
    if (d.chrome_default === null || d.extensions_disabled === null || d.popups_allowed === null) { await modal.warning('Missing Info', 'All Browser questions must be answered.'); return; }

    if (!d.headset_usb || !d.noise_cancel) {
      const reasons = [];
      if (!d.headset_usb) reasons.push('Wrong headset (not USB)');
      if (!d.noise_cancel) reasons.push('Wrong headset (not noise cancelling)');
      const yes = await modal.showModal({
        type: 'confirm',
        title: 'Headset Issue',
        body: `To contract with ACD, a USB headset with a noise cancelling microphone must be used.<br><br>Fail session for: <b>${reasons.join(' and ')}</b>?`,
        graphic: 'warning',
        buttons: [
          { label: 'Yes', cls: 'btn-primary', value: true },
          { label: 'No', cls: 'btn-muted', value: false },
        ],
      });
      if (yes) {
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: reasons.join(' and '), final_status: 'Fail' });
        onNavigate('review');
      }
      return;
    }
    if (d.vpn_on && d.vpn_off === false) {
      const yes = await modal.confirm('VPN Issue', 'Using a VPN is not accepted when contracting with ACD. The candidate cannot turn it off.<br><br>Fail this session?');
      if (yes) {
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Unable to turn off VPN', final_status: 'Fail' });
        onNavigate('review');
      }
      return;
    }
    if (d.chrome_default === false) {
      const fixed = await modal.confirm('Browser Issue', 'The browser must be set as default so that DTE login functions properly.<br><br>Were they able to fix it?');
      if (!fixed) {
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' });
        onNavigate('review');
        return;
      }
    }
    if (d.extensions_disabled === false) {
      const fixed = await modal.confirm('Browser Issue', 'Browser extensions must be disabled so they do not interfere with the script.<br><br>Were they able to fix it?');
      if (!fixed) {
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' });
        onNavigate('review');
        return;
      }
    }
    if (d.popups_allowed === false) {
      const fixed = await modal.confirm('Browser Issue', 'Necessary pop-ups must be allowed so the script can pop correctly.<br><br>Were they able to fix it?');
      if (!fixed) {
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' });
        onNavigate('review');
        return;
      }
    }
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await api.startSession({ ...d, supervisor_only: supervisorOnlyMode, time_for_sup: supervisorOnlyMode ? true : null });
    onNavigate(supervisorOnlyMode ? 'suptransfer' : 'calls');
  };

  const RadioGroup = ({ name, value, onChange }) => (
    <div className="radio-group">
      <label className="radio-label"><input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} /> Yes</label>
      <label className="radio-label"><input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} /> No</label>
    </div>
  );

  return (
    <div data-testid="basics-page">
      <WorkflowProgress {...getWorkflowProgress({ page: 'basics', supervisorOnly: supervisorOnlyMode })} />
      <h1 style={{ marginBottom: 16 }}>The Basics</h1>
      <div className="card" style={{ marginBottom: 8, padding: '16px 24px' }}>
        <h3 style={{ marginBottom: 8 }}>Session Information</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="text-sm font-bold" style={{ minWidth: 130 }}>Candidate Name</label>
            <input type="text" value={form.candidate_name} onChange={e => set('candidate_name', e.target.value)} placeholder="Required" style={{ flex: 1 }} data-testid="basics-candidate" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-tour="basics-final-attempt">
            <label className="text-sm font-bold" style={{ minWidth: 130, color: 'var(--color-danger)', fontWeight: 800 }}>Final Attempt</label>
            <div>
              <RadioGroup name="b-final-attempt" value={form.final_attempt} onChange={v => set('final_attempt', v)} />
              <div className="text-xs" style={{ marginTop: 2, color: 'var(--color-danger)', fontWeight: 800 }}>Select Yes only if this is the candidate&apos;s last allowed attempt.</div>
            </div>
          </div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 8, padding: '16px 24px' }} data-tour="basics-headset-section">
        <h3 style={{ marginBottom: 12 }}>Headset Requirements</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <label className="text-sm font-bold" style={{ minWidth: 160 }}>Is the headset USB?</label>
            <RadioGroup name="b-usb" value={form.headset_usb} onChange={v => set('headset_usb', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <label className="text-sm font-bold" style={{ minWidth: 160 }}>Noise Cancelling Mic?</label>
            <RadioGroup name="b-noise" value={form.noise_cancel} onChange={v => set('noise_cancel', v)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <label className="text-sm font-bold" style={{ minWidth: 160 }}>Brand / Model</label>
            <input type="text" value={form.headset_brand} onChange={e => set('headset_brand', e.target.value)} placeholder="e.g. Logitech H390" style={{ maxWidth: 280 }} data-testid="basics-brand" />
          </div>
          <div style={{ marginTop: 4 }}>
            <div className="basics-headset-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm basics-headset-lookup-btn"
                onClick={() => setHeadsetLookupOpen(true)}
                data-testid="basics-headset-lookup"
              >
                {'\uD83D\uDD0D'} Lookup Approved Headsets
              </button>
            </div>
            <div className="text-xs text-muted basics-headset-note">
              {HEADSET_HELPER_TEXT}
            </div>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="card" style={{ padding: '16px 24px' }} data-tour="basics-vpn-section">
          <h3 style={{ marginBottom: 8 }}>VPN</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 110 }}>Has VPN?</label>
              <RadioGroup name="b-vpn" value={form.vpn_on} onChange={v => { set('vpn_on', v); if (!v) set('vpn_off', null); }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: form.vpn_on ? 1 : 0.3, pointerEvents: form.vpn_on ? 'auto' : 'none' }}>
              <label className="text-sm font-bold" style={{ minWidth: 110 }}>Can turn off?</label>
              <RadioGroup name="b-vpnoff" value={form.vpn_off} onChange={v => set('vpn_off', v)} />
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: '16px 24px' }} data-tour="basics-browser-section">
          <h3 style={{ marginBottom: 8 }}>Browser</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 130 }}>Default browser?</label>
              <RadioGroup name="b-chrome" value={form.chrome_default} onChange={v => set('chrome_default', v)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 130 }}>Extensions off?</label>
              <RadioGroup name="b-ext" value={form.extensions_disabled} onChange={v => set('extensions_disabled', v)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 130 }}>Pop-ups allowed?</label>
              <RadioGroup name="b-popups" value={form.popups_allowed} onChange={v => set('popups_allowed', v)} />
            </div>
          </div>
        </div>
      </div>

      <TechIssueDialog open={techOpen} onClose={() => setTechOpen(false)} isFinalAttempt={form.final_attempt} onNavigate={onNavigate} />

      {headsetLookupOpen && (
        <div
          className="modal-overlay open"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setHeadsetLookupOpen(false);
            }
          }}
        >
          <div className="modal" style={{ width: 640, maxWidth: '92vw' }}>
            <div className="modal-header">
              <h2>Approved Headset Lookup</h2>
              <button className="modal-close" onClick={() => setHeadsetLookupOpen(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="headset-lookup-subtitle">Search by brand or model</div>
              <div className="text-xs text-muted headset-lookup-note">
                {HEADSET_HELPER_TEXT}
              </div>
              <input
                type="text"
                value={headsetQuery}
                onChange={(event) => setHeadsetQuery(event.target.value)}
                placeholder="Search brand or model..."
                data-testid="headset-lookup-search"
                style={{ marginBottom: 16 }}
              />
              <div className="headset-lookup-results-scroll">
                {headsetLookupError && approvedHeadsets.length === 0 ? (
                  <div className="headset-lookup-empty">
                    <div className="text-muted">{headsetLookupError}</div>
                    <div className="text-xs text-muted headset-lookup-empty-note">
                      You can still type the headset brand/model manually and confirm it is USB with a noise-cancelling microphone.
                    </div>
                  </div>
                ) : headsetLookupLoading ? (
                  <div className="headset-lookup-empty">
                    <div className="text-muted">Loading approved headset list...</div>
                  </div>
                ) : filteredHeadsets.length === 0 ? (
                  <div className="headset-lookup-empty">
                    <div className="text-muted">No matching headset found.</div>
                    <div className="text-xs text-muted headset-lookup-empty-note">
                      {HEADSET_HELPER_TEXT}
                    </div>
                  </div>
                ) : (
                  <div className="headset-lookup-results">
                  {filteredHeadsets.map((group) => (
                    <div key={group.brand} className="headset-lookup-group">
                      <div className="headset-lookup-brand">{group.brand}</div>
                      <ul className="headset-lookup-models">
                        {group.models.map((model) => (
                          <li key={`${group.brand}-${model}`}>
                            <button
                              type="button"
                              className="headset-lookup-model-btn"
                              onClick={() => {
                                set('headset_brand', `${group.brand} ${model}`);
                                setHeadsetLookupOpen(false);
                              }}
                            >
                              {model}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  </div>
                )}
              </div>
              <div className="headset-lookup-footer">
                <button
                  type="button"
                  className="btn btn-muted btn-sm"
                  onClick={() => setHeadsetLookupOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="footer-bar" data-testid="basics-footer">
        <button className="btn btn-muted btn-sm" onClick={handleDiscardSession} data-testid="basics-discard">Discard Session</button>
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('NC/NS')} data-testid="basics-ncns" title="No Call / No Show — candidate did not join the session">NC / NS</button>
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('Not Ready for Session')} data-testid="basics-notready" title="Candidate was not prepared for the session (wrong setup, etc.)">Not Ready</button>
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('Stopped Responding in Chat')} data-testid="basics-stopped" title="Candidate went silent in Discord during the session">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="basics-tech" title="Log a technical issue (internet, calls routing, script pop, etc.)">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="basics-continue">Continue</button>
      </div>
    </div>
  );
}
