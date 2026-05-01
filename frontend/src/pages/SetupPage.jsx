import React, { useState, useEffect } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import { playSound } from '../utils/sound';
import mtsLogo from '../assets/images/MTSLogonew.png';

const TUTORIAL_AFTER_SETUP_KEY = 'mts-start-tutorial-after-setup';

export default function SetupPage({ onNavigate, onSetupCompleted }) {
  const modal = useModal();
  const [step, setStep] = useState(0);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [display, setDisplay] = useState('');
  const [formUrl, setFormUrl] = useState('https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl');
  const [certSheetUrl, setCertSheetUrl] = useState('https://acddirect-my.sharepoint.com/:x:/p/becky_sowles/IQDxXC0z-rUHS6oowjotk0e6AZeldAj2eFiqT8oNiOEAWjA?rtime=5Q1giSl33kg');

  useEffect(() => {
    playSound('setup');
  }, []);

  const steps = [
    // Step 0 - Welcome
    () => (
      <div className="setup-step">
        <div className="setup-center">
          <img src={mtsLogo} alt="Mock Testing Suite" className="setup-logo" />
          <h1 className="setup-heading">Welcome to Mock Testing Suite</h1>
          <p className="setup-sub">Let's get your profile set up.</p>
          <div className="card setup-card">
            <div className="form-row"><label>First Name</label><input type="text" value={first} onChange={e => setFirst(e.target.value)} placeholder="e.g. Jordan" data-testid="setup-first" /></div>
            <div className="form-row"><label>Last Name</label><input type="text" value={last} onChange={e => setLast(e.target.value)} placeholder="e.g. Taylor" data-testid="setup-last" /></div>
            <div className="form-row"><label>Display Name</label><input type="text" value={display} onChange={e => setDisplay(e.target.value)} placeholder="Optional nickname" data-testid="setup-display" /></div>
          </div>
        </div>
      </div>
    ),
    // Step 1 - URLs
    () => (
      <div className="setup-step">
        <div className="setup-center">
          <img src={mtsLogo} alt="Mock Testing Suite" className="setup-logo" />
          <h1 className="setup-heading">System Links</h1>
          <p className="setup-sub">Pre-filled for you. Change only if needed.</p>
          <div className="card setup-card">
            <div className="form-row"><label>Cert Form URL</label><input type="text" value={formUrl} onChange={e => setFormUrl(e.target.value)} data-testid="setup-form-url" /></div>
            <div className="form-row"><label>Cert Spreadsheet URL</label><input type="text" value={certSheetUrl} onChange={e => setCertSheetUrl(e.target.value)} data-testid="setup-cert-sheet-url" /></div>
          </div>
        </div>
      </div>
    ),
    // Step 2 - Power-ups
    () => (
      <div className="setup-step">
        <div className="setup-center">
          <img src={mtsLogo} alt="Mock Testing Suite" className="setup-logo" />
          <h1 className="setup-heading">Unlock App Power-Ups</h1>
          <p className="setup-sub">Enable these anytime in the Settings tab.</p>
          <div className="card setup-card" style={{ textAlign: 'left', lineHeight: 1.8 }}>
            <p><strong>Gemini AI</strong> — Generates clean, professional coaching summaries from your checkboxes.</p>
            <p><strong>Google Calendar</strong> — Adds Newbie Shifts to your calendar with one click.</p>
            <p className="text-muted text-sm" style={{ marginTop: 12 }}>Step-by-step setup guides are in the Help tab.</p>
          </div>
        </div>
      </div>
    ),
  ];

  const handleNext = async () => {
    if (step === 0) {
      if (!first.trim() || !last.trim()) {
        await modal.warning('Missing Info', 'First and Last name are required.');
        return;
      }
      setStep(1);
    } else if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      try {
        await api.completeSetup({
          tester_name: `${first.trim()} ${last.trim()}`,
          display_name: display.trim() || first.trim(),
          form_url: formUrl.trim(),
          cert_sheet_url: certSheetUrl.trim(),
        });
        if (onSetupCompleted) {
          await onSetupCompleted();
        } else {
          localStorage.setItem(TUTORIAL_AFTER_SETUP_KEY, '1');
          onNavigate('home');
        }
      } catch (e) {
        await modal.error('Error', e.message);
      }
    }
  };

  return (
    <div className="page-setup" data-testid="setup-page">
      {steps[step]()}
      <div className="setup-footer">
        {step > 0 && <button className="btn btn-muted" onClick={() => setStep(step - 1)} data-testid="setup-back">Back</button>}
        <span style={{ flex: 1 }} />
        <div className="setup-dots">
          {steps.map((_, i) => <span key={i} className={`setup-dot ${i === step ? 'active' : i < step ? 'done' : ''}`} />)}
        </div>
        <span style={{ flex: 1 }} />
        <button className={`btn ${step === 2 ? 'btn-success' : 'btn-primary'}`} onClick={handleNext} data-testid="setup-next">
          {step === 2 ? 'Launch App' : 'Next'}
        </button>
      </div>
    </div>
  );
}
