import React, { useState, useEffect } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import { playError } from '../utils/buzz';

const SUP_ONLY_MODE_KEY = 'mts_sup_transfer_only_mode';

export default function BasicsPage({ onNavigate }) {
  const modal = useModal();
  const [settings, setSettings] = useState({});
  const [techOpen, setTechOpen] = useState(false);
  const [supervisorOnlyMode, setSupervisorOnlyMode] = useState(false);
  const [form, setForm] = useState({
    candidate_name: '', tester_name: '', final_attempt: false,
    headset_usb: null, noise_cancel: null, headset_brand: '',
    vpn_on: null, vpn_off: null, chrome_default: null, extensions_disabled: null, popups_allowed: null,
  });

  useEffect(() => {
    setSupervisorOnlyMode(window.sessionStorage.getItem(SUP_ONLY_MODE_KEY) === '1');
    api.getSettings().then(s => {
      setSettings(s);
      setForm(f => ({ ...f, tester_name: s.tester_name || '' }));
    }).catch(() => {});
  }, []);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const autoFail = async (reason) => {
    if (!form.candidate_name.trim()) { await modal.warning('Missing Info', 'Enter the Candidate Name first.'); return; }
    playError();
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
      const yes = await modal.confirm('Headset Issue', `To contract with ACD, a USB headset with a noise cancelling microphone must be used.<br><br>Fail session for: <b>${reasons.join(' and ')}</b>?`);
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
      <h1 style={{ marginBottom: 16 }}>The Basics</h1>
      <div className="card" style={{ marginBottom: 8, padding: '16px 24px' }}>
        <h3 style={{ marginBottom: 8 }}>Session Information</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="text-sm font-bold" style={{ minWidth: 130 }}>Candidate Name</label>
            <input type="text" value={form.candidate_name} onChange={e => set('candidate_name', e.target.value)} placeholder="Required" style={{ flex: 1 }} data-testid="basics-candidate" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="text-sm font-bold" style={{ minWidth: 130, color: 'var(--color-danger)', fontWeight: 800 }}>Final Attempt</label>
            <div>
              <RadioGroup name="b-final-attempt" value={form.final_attempt} onChange={v => set('final_attempt', v)} />
              <div className="text-xs" style={{ marginTop: 2, color: 'var(--color-danger)', fontWeight: 800 }}>Select Yes only if this is the candidate&apos;s last allowed attempt.</div>
            </div>
          </div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 8, padding: '16px 24px' }}>
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
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div className="card" style={{ padding: '16px 24px' }}>
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
        <div className="card" style={{ padding: '16px 24px' }}>
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

      <div className="footer-bar" data-testid="basics-footer">
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('NC/NS')} data-testid="basics-ncns" title="No Call / No Show — candidate did not join the session">NC / NS</button>
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('Not ready for session')} data-testid="basics-notready" title="Candidate was not prepared for the session (wrong setup, etc.)">Not Ready</button>
        <button className="btn btn-danger btn-sm" onClick={() => autoFail('Stopped Responding in Chat')} data-testid="basics-stopped" title="Candidate went silent in Discord during the session">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="basics-tech" title="Log a technical issue (internet, calls routing, script pop, etc.)">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="basics-continue">Continue</button>
      </div>
    </div>
  );
}
