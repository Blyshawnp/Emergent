import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
const CALL_COACHING = [
  { id: 'c-show-app', label: 'Show appreciation', children: ['For Current/Existing Donors', 'After donation amount is given'] },
  { id: 'c-phonetics', label: 'Phonetics table provided to candidate' },
  { id: 'c-dontask', label: "Don't Ask, Just Verify Address and Phone Number", helper: 'Existing member already provided address and phone number' },
  { id: 'c-verify', label: 'Verification', children: ['Name', 'Address', 'Phone', 'Email', 'Card/EFT', 'Phonetics for Sound Alike Letters'] },
  { id: 'c-verbatim', label: 'Read script verbatim', helper: 'No adlibbing or skipping sections' },
  { id: 'c-nav', label: 'Use effective script navigation', children: ['Scroll down to avoid missing parts of the script', 'Use the Back and Next buttons and not the Icons'] },
  { id: 'c-other', label: 'Other' },
];

const CALL_FAILS = [
  'Skipped parts of script', 'Volunteered info', 'Wrong donation', 'Background noise on call',
  'Paraphrased script', 'Wrong thank you gift', 'Script navigation issues', 'Other',
];

// --- Extracted helpers to reduce main component complexity ---
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomFlags() {
  const phone = pickRandom(['Mobile', 'Landline']);
  return {
    phone,
    sms: phone === 'Mobile' ? pickRandom(['Yes', 'No']) : 'N/A',
    enews: pickRandom(['Yes', 'No']),
    ship: pickRandom(['Yes', 'No']),
    ccfee: pickRandom(['Yes', 'No']),
  };
}

function getCallersForType(callType, settings, defaults) {
  const ct = callType.toLowerCase();
  if (ct.includes('increase')) return settings.donors_increase || defaults.donors_increase || [];
  if (ct.includes('new')) return settings.donors_new || defaults.donors_new || [];
  return settings.donors_existing || defaults.donors_existing || [];
}

function getDonationsForShow(showData, callType) {
  if (!showData) return ['Other'];
  const ct = callType.toLowerCase();
  const isMonthly = !ct.includes('one time');
  const amt = isMonthly ? showData[2] : showData[1];
  return amt ? [amt, 'Other'] : ['Other'];
}

function isOneTimeDonation(callType) {
  return callType.toLowerCase().includes('one time');
}

function ScenarioCard({ currentCaller, callSetup, randFlags, donations, onRegenerate, showData }) {
  if (!currentCaller.length) return <div className="card card-scenario"><p className="text-muted">Select call type, show, and caller.</p></div>;
  const fname = currentCaller[0];
  const fullName = `${currentCaller[0]} ${currentCaller[1]}`;
  const ct = callSetup.type.toLowerCase();
  const donorType = ct.includes('new') ? 'a new donor' : 'an existing member';
  const isOneTime = isOneTimeDonation(callSetup.type);
  let action = 'make a one-time donation of';
  if (ct.includes('increase')) action = 'increase their sustaining donation to';
  else if (ct.includes('sustaining') || ct.includes('monthly')) action = 'start a new sustaining donation of';
  const donation = callSetup.donation || donations[0] || '';
  const gift = showData && showData[3] ? showData[3] : '';

  return (
    <div className="card card-scenario" data-testid="scenario-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ color: 'var(--border-scenario)', margin: 0 }}>SCENARIO</h3>
        <button className="btn btn-ghost btn-sm" onClick={onRegenerate} data-testid="scenario-regen" title="Re-roll random variables">{'\uD83D\uDD04'} Regenerate</button>
      </div>
      <p style={{ lineHeight: 1.7, marginBottom: 16 }}>
        <b>For this call you will portray {fullName}.</b> {fname} is {donorType} wishing to {action} {donation} to support {callSetup.show}.
      </p>
      <div className="scenario-vars">
        {gift && <div className="scenario-var"><span className="scenario-var-label">Thank You Gift:</span><span className="scenario-var-value scenario-highlight">{gift}</span></div>}
        <div className="scenario-var"><span className="scenario-var-label">Phone Type:</span><span className={`scenario-var-value scenario-highlight ${randFlags.phone === 'Mobile' ? 'scenario-yes' : 'scenario-no'}`}>{randFlags.phone}</span></div>
        {randFlags.phone === 'Mobile' && <div className="scenario-var"><span className="scenario-var-label">Text Messages:</span><span className={`scenario-var-value ${randFlags.sms === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{randFlags.sms}</span></div>}
        <div className="scenario-var"><span className="scenario-var-label">E-Newsletter:</span><span className={`scenario-var-value ${randFlags.enews === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{randFlags.enews}</span></div>
        <div className="scenario-var"><span className="scenario-var-label">Cover $6 Shipping:</span><span className={`scenario-var-value ${randFlags.ship === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{randFlags.ship}</span></div>
        {!isOneTime && <div className="scenario-var"><span className="scenario-var-label">Cover CC Processing Fee:</span><span className={`scenario-var-value ${randFlags.ccfee === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{randFlags.ccfee}</span></div>}
      </div>
    </div>
  );
}

async function evaluateCallRouting(session, modal, onNavigate, apiRef) {
  let passes = [];
  let failCount = 0;
  for (let i = 1; i <= 3; i++) {
    const c = session[`call_${i}`];
    if (c && c.result === 'Pass') passes.push(c.type || '');
    else if (c && c.result === 'Fail') failCount++;
  }

  if (passes.length === 2) {
    const hasNew = passes.some(t => t.toLowerCase().includes('new'));
    const hasExt = passes.some(t => t.toLowerCase().includes('existing'));
    if (!hasNew || !hasExt) {
      const missing = hasNew ? 'Existing Member' : 'New Donor';
      await modal.warning('Call Type Error', `You must pass one New Donor and one Existing Member call.<br><br>Change this call's type to a "${missing}" scenario.`);
      return 'stay';
    }
  }

  if (failCount >= 2) {
    await apiRef.updateSession({ final_status: 'Fail' });
    await modal.warning('Notice', 'The candidate has failed 2 calls. Proceeding to Review.');
    onNavigate('review');
    return 'navigated';
  }

  if (passes.length >= 2) {
    const hasTime = await modal.confirm('Confirm', 'Is there enough time for Supervisor Transfers?');
    if (hasTime) {
      await apiRef.updateSession({ time_for_sup: true });
      onNavigate('suptransfer');
    } else {
      await apiRef.updateSession({ time_for_sup: false });
      onNavigate('newbieshift');
    }
    return 'navigated';
  }

  return 'next';
}

// --- Main Component ---
export default function CallsPage({ onNavigate }) {
  const modal = useModal();
  const [callNum, setCallNum] = useState(1);
  const [result, setResult] = useState(null);
  const [defaults, setDefaults] = useState({});
  const [settings, setSettings] = useState({});
  const [techOpen, setTechOpen] = useState(false);
  const [callSetup, setCallSetup] = useState({ type: '', show: '', caller: '', donation: '' });
  const [coaching, setCoaching] = useState({});
  const [coachNotes, setCoachNotes] = useState('');
  const [fails, setFails] = useState({});
  const [failNotes, setFailNotes] = useState('');
  const [randFlags, setRandFlags] = useState({});
  const [isFinal, setIsFinal] = useState(false);
  const [candidateName, setCandidateName] = useState('');

  const rollRandom = useCallback(() => {
    setRandFlags(generateRandomFlags());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, s] = await Promise.all([api.getDefaults(), api.getSettings()]);
        if (cancelled) return;
        setDefaults(d);
        setSettings(s);
        const types = s.call_types || d.call_types || [];
        const shows = s.shows || d.shows || [];
        if (types.length) setCallSetup(prev => ({ ...prev, type: types[0] }));
        if (shows.length) setCallSetup(prev => ({ ...prev, show: shows[0][0] }));
        const { session } = await api.getCurrentSession();
        if (!cancelled && session) {
          setIsFinal(session.final_attempt || false);
          setCandidateName(session.candidate_name || '');
        }
      } catch (err) {
        // Failed to load defaults/settings — page will render with empty dropdowns
      }
      if (!cancelled) rollRandom();
    })();
    return () => { cancelled = true; };
  }, [rollRandom]);

  const callTypes = settings.call_types || defaults.call_types || [];
  const shows = settings.shows || defaults.shows || [];
  const callers = useMemo(() => getCallersForType(callSetup.type, settings, defaults), [callSetup.type, settings, defaults]);
  const callerIdx = Math.max(0, callers.findIndex(c => `${c[0]} ${c[1]}` === callSetup.caller));
  const currentCaller = useMemo(() => callers[callerIdx] || callers[0] || [], [callers, callerIdx]);
  const showData = shows.find(s => s[0] === callSetup.show);
  const donations = useMemo(() => getDonationsForShow(showData, callSetup.type), [showData, callSetup.type]);

  const resetCall = useCallback(() => {
    setResult(null);
    setCoaching({});
    setCoachNotes('');
    setFails({});
    setFailNotes('');
    rollRandom();
  }, [rollRandom]);

  const handleContinue = useCallback(async () => {
    if (!result) { await modal.warning('Notice', 'You must select PASS or FAIL.'); return; }
    if (result === 'Fail') {
      const hasCheck = Object.values(fails).some(v => v);
      if (!hasCheck) { await modal.warning('Notice', 'You must select at least one Fail Reason.'); return; }
      if (fails['Other'] && !failNotes.trim()) { await modal.warning('Notice', 'You selected "Other" — please provide notes.'); return; }
    }
    // Coaching validation - warn if no coaching selected
    const hasCoaching = Object.values(coaching).some(v => v);
    if (!hasCoaching) {
      const cont = await modal.confirm('No Coaching', 'You did not select any coaching for this call. Continue anyway?');
      if (!cont) return;
    }

    const callData = {
      call_num: callNum, result, type: callSetup.type, show: callSetup.show,
      caller: callSetup.caller || (currentCaller.length ? `${currentCaller[0]} ${currentCaller[1]}` : ''),
      donation: callSetup.donation || donations[0],
      coaching, coach_notes: coachNotes, fails, fail_notes: failNotes,
    };
    await api.saveCall(callData);

    const { session } = await api.getCurrentSession();
    const routeResult = await evaluateCallRouting(session, modal, onNavigate, api);
    if (routeResult === 'next') {
      setCallNum(prev => prev + 1);
      resetCall();
      // Scroll to top so tester sees they moved to next call
      const el = document.querySelector('[data-testid="page-content"]');
      if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [result, fails, failNotes, coaching, callNum, callSetup, currentCaller, donations, coachNotes, modal, onNavigate, resetCall]);

  const handleStoppedResponding = useCallback(async () => {
    const confirmed = await modal.confirm(
      'Confirm Auto-Fail',
      `This will Automatically fail ${candidateName} and mark as Stopped Responding in Chat. Do you want to proceed?`,
      'alert-triangle',
      'warning'
    );
    if (!confirmed) return;
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    onNavigate('review');
  }, [candidateName, modal, onNavigate]);

  return (
    <div data-testid="calls-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <h1 style={{ marginBottom: 0 }}>Call #{callNum}</h1>
        {candidateName && (
          <div className="text-sm text-muted" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
            <b>Candidate:</b> {candidateName}
          </div>
        )}
      </div>
      <div className="split-layout">
        <div className="card setup-card">
          <h3 style={{ marginBottom: 16 }}>Call Setup</h3>
          <div className="form-row"><label>Call Type</label>
            <select value={callSetup.type} onChange={e => { setCallSetup(p => ({ ...p, type: e.target.value })); rollRandom(); }} data-testid="call-type">
              {callTypes.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Show</label>
            <select value={callSetup.show} onChange={e => setCallSetup(p => ({ ...p, show: e.target.value }))} data-testid="call-show">
              {shows.map(s => <option key={s[0]}>{s[0]}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Caller</label>
            <select value={callSetup.caller} onChange={e => { setCallSetup(p => ({ ...p, caller: e.target.value })); rollRandom(); }} data-testid="call-caller">
              {callers.map(c => <option key={`${c[0]}${c[1]}`}>{c[0]} {c[1]}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Donation</label>
            <select value={callSetup.donation} onChange={e => setCallSetup(p => ({ ...p, donation: e.target.value }))} data-testid="call-donation">
              {donations.map(d => <option key={d}>{d}</option>)}
            </select>
          </div>
        </div>
        <ScenarioCard currentCaller={currentCaller} callSetup={callSetup} randFlags={randFlags} donations={donations} onRegenerate={rollRandom} showData={showData} />
      </div>

      <PaymentSimulation />

      {currentCaller.length > 0 && <CallerDemographics caller={currentCaller} />}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginBottom: 8 }}>Call Result</h3>
        <div className="result-btns">
          <button className={`result-btn ${result === 'Pass' ? 'selected-pass' : ''}`} onClick={() => setResult('Pass')} data-testid="call-pass">PASS</button>
          <button className={`result-btn ${result === 'Fail' ? 'selected-fail' : ''}`} onClick={() => setResult('Fail')} data-testid="call-fail">FAIL</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Coaching Given</h3>
        <p className="text-muted text-sm" style={{ marginBottom: 16 }}>One or more may be selected</p>
        <CoachingGrid items={CALL_COACHING} checked={coaching} onChange={setCoaching} />
        <div style={{ marginTop: 16 }}>
          <label className="text-sm font-bold">Other Coaching Notes</label>
          <textarea rows={2} value={coachNotes} onChange={e => setCoachNotes(e.target.value)} disabled={!coaching['Other']} style={{ marginTop: 4 }} data-testid="call-coach-notes" />
        </div>
      </div>

      {result === 'Fail' && (
        <div className="card card-fail" style={{ marginBottom: 16 }}>
          <h3 style={{ color: 'var(--color-danger)' }}>Fail Reasons</h3>
          <p className="text-muted text-sm" style={{ marginBottom: 16 }}>One or more may be selected</p>
          <FailGrid items={CALL_FAILS} checked={fails} onChange={setFails} />
          <div style={{ marginTop: 16 }}>
            <label className="text-sm font-bold">Other Fail Notes</label>
            <textarea rows={2} value={failNotes} onChange={e => setFailNotes(e.target.value)} disabled={!fails['Other']} style={{ marginTop: 4 }} data-testid="call-fail-notes" />
          </div>
        </div>
      )}

      <TechIssueDialog open={techOpen} onClose={() => setTechOpen(false)} isFinalAttempt={isFinal} onNavigate={onNavigate} />

      <div className="footer-bar" data-testid="calls-footer">
        <button className="btn btn-muted btn-sm" onClick={() => { if (callNum > 1) { setCallNum(n => n - 1); resetCall(); } else onNavigate('basics'); }} data-testid="calls-back">Back</button>
        <button className="btn btn-danger btn-sm" onClick={handleStoppedResponding} data-testid="calls-stopped" title="Candidate went silent in Discord during the session">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="calls-tech" title="Log a technical issue">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="calls-continue">Continue</button>
      </div>
    </div>
  );
}

// --- Extracted sub-components to reduce main component size ---
function PaymentSimulation() {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 8 }}>Payment Simulation</h3>
      <div className="payment-grid">
        <div className="payment-card payment-card-cc">
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>AMERICAN EXPRESS</div>
          <div className="font-mono font-bold" style={{ fontSize: 18, letterSpacing: 2 }}>3782 822463 10005</div>
          <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>EXP: 07/2027 &nbsp; CVV: 1928</div>
        </div>
        <div className="payment-card payment-card-eft">
          <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>EFT / BANK DRAFT</div>
          <div className="font-mono font-bold" style={{ fontSize: 15 }}>RTN: 021000021</div>
          <div className="font-mono font-bold" style={{ fontSize: 15 }}>ACC: 1357902468</div>
        </div>
      </div>
    </div>
  );
}

function CallerDemographics({ caller }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginBottom: 8 }}>Caller Demographics</h3>
      <div style={{ textAlign: 'center' }}>
        <b>{caller[0]} {caller[1]}</b><br />
        {caller[2]}{caller[3] ? `, ${caller[3]}` : ''}, {caller[4]}, {caller[5]} {caller[6]}<br />
        Phone: {caller[7]} | Email: {caller[8]}
      </div>
    </div>
  );
}

function CoachingGrid({ items, checked, onChange }) {
  const toggle = (key) => onChange(prev => ({ ...prev, [key]: !prev[key] }));
  const half = Math.ceil(items.length / 2);
  return (
    <div className="coaching-grid">
      <div>{items.slice(0, half).map(item => <CoachingItem key={item.id} item={item} checked={checked} onToggle={toggle} />)}</div>
      <div>{items.slice(half).map(item => <CoachingItem key={item.id} item={item} checked={checked} onToggle={toggle} />)}</div>
    </div>
  );
}

function CoachingItem({ item, checked, onToggle }) {
  const parentChecked = !!checked[item.label];
  return (
    <div className="coaching-group">
      <label className="checkbox-label">
        <input type="checkbox" checked={parentChecked} onChange={() => onToggle(item.label)} />
        <span>{item.label}</span>
      </label>
      {item.helper && <div className="helper-text">{item.helper}</div>}
      {item.children && item.children.map(child => (
        <label key={child} className={`checkbox-label sub-item ${!parentChecked ? 'disabled' : ''}`}>
          <input type="checkbox" disabled={!parentChecked} checked={!!checked[`${item.label}_${child}`]} onChange={() => onToggle(`${item.label}_${child}`)} />
          <span>{child}</span>
        </label>
      ))}
    </div>
  );
}

function FailGrid({ items, checked, onChange }) {
  const toggle = (key) => onChange(prev => ({ ...prev, [key]: !prev[key] }));
  const half = Math.ceil(items.length / 2);
  return (
    <div className="coaching-grid">
      <div>{items.slice(0, half).map(item => (
        <label key={item} className="checkbox-label"><input type="checkbox" checked={!!checked[item]} onChange={() => toggle(item)} /><span>{item}</span></label>
      ))}</div>
      <div>{items.slice(half).map(item => (
        <label key={item} className="checkbox-label"><input type="checkbox" checked={!!checked[item]} onChange={() => toggle(item)} /><span>{item}</span></label>
      ))}</div>
    </div>
  );
}
