import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import api, { findDiscordTemplateMessage } from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import { buildBasicsFromRecord, findBestBasicsRecord, mergeBasicsIntoSession, sessionIdOf } from '../utils/sessionBasics';
const SUP_ONLY_MODE_KEY = 'mts_sup_transfer_only_mode';
const HEADSET_HELPER_TEXT = 'Search approved headsets by brand or model number, such as Logitech, H390, or H650e.';
const HEADSET_DETAIL_BULLETS = [
  'If the brand/model is not listed, confirm it is USB and has a noise-cancelling microphone.',
  'Unsure? Post in Discord Tester Room.',
  'If confirmed USB and it has a noise-cancelling microphone, type it in the field.',
  'Headsets not listed, but approved, will be added to the list every 7-10 days.',
];
const VPN_CHECK_URLS = [
  'https://www.ip2location.com/',
  'https://ip.teoh.io/vpn-detection',
  'https://nodedata.io/vpn-detection-test',
];

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isStrongCandidateLookupQuery(value) {
  const normalized = normalizeName(value);
  const parts = normalized.split(' ').filter(Boolean);
  return parts.length >= 2 && normalized.length >= 5 && (parts[1].length >= 1 || normalized.length >= 7);
}

function getCandidateDate(record) {
  return record?.completed_at || record?.created_at || record?.displayDate || '';
}

function candidateHasFinalAttemptUsed(record) {
  return String(record?.status || '').trim().toUpperCase() === 'FAIL-FINAL ATTEMPT';
}

function sheetTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  return ['true', '1', 'yes', 'y', 'on', 'checked'].includes(String(value).trim().toLowerCase());
}

function candidateIsWithdrawn(record) {
  return sheetTruthy(record?.withdrawn) || String(record?.status || '').trim().toUpperCase() === 'WITHDREW FROM CERTIFICATION';
}

function candidateIsNcns(record) {
  return String(record?.status || record?.final_status || '').trim().toUpperCase() === 'NC/NS'
    || String(record?.auto_fail_reason || '').trim().toUpperCase().startsWith('NC');
}

function selectedHeadsetLabel(group, model) {
  return `${group.brand || ''} ${model || ''}`.trim();
}

function normalizeLookupValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeHeadsetSearchValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function compactHeadsetSearchValue(value) {
  return normalizeHeadsetSearchValue(value).replace(/\s+/g, '');
}

function headsetSearchTokens(value) {
  return normalizeHeadsetSearchValue(value).split(' ').filter(Boolean);
}

function headsetOptionMatchesQuery(option, query) {
  const normalizedOption = normalizeHeadsetSearchValue(option);
  const normalizedQuery = normalizeHeadsetSearchValue(query);
  if (!normalizedQuery) return true;
  if (normalizedOption.includes(normalizedQuery)) return true;

  const compactOption = compactHeadsetSearchValue(option);
  const compactQuery = compactHeadsetSearchValue(query);
  if (compactQuery && compactOption.includes(compactQuery)) return true;

  const tokens = headsetSearchTokens(query);
  return tokens.length > 0 && tokens.every((token) => normalizedOption.includes(token) || compactOption.includes(token));
}

function headsetModelTokenMatches(modelText, query) {
  const normalizedQuery = normalizeHeadsetSearchValue(query);
  if (!normalizedQuery) return false;
  const compactQuery = compactHeadsetSearchValue(query);
  return headsetSearchTokens(modelText)
    .filter((token) => /\d/.test(token))
    .some((token) => token === normalizedQuery || token === compactQuery);
}

function isMissingHeadsetValue(value) {
  const normalized = normalizeLookupValue(value);
  return !normalized || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'unknown';
}

function booleanOrCurrent(value, current) {
  if (value === undefined || value === null || value === '') return current;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return current;
}

function findMostRecentHeadset(matches, candidateName) {
  const normalized = normalizeName(candidateName).toLowerCase();
  const match = (matches || []).find((record) => (
    normalizeName(record?.candidate_name).toLowerCase() === normalized &&
    !isMissingHeadsetValue(buildBasicsFromRecord(record).headset_brand)
  ));
  return String(buildBasicsFromRecord(match).headset_brand || '').trim();
}

function hasUsableBasicsInfo(record) {
  return buildBasicsFromRecord(record).usable;
}

function sortedCandidateRecords(records, candidateName) {
  const normalized = normalizeName(candidateName).toLowerCase();
  return (records || [])
    .filter((record) => normalizeName(record?.candidate_name || record?.candidate).toLowerCase() === normalized)
    .sort((a, b) => String(getCandidateDate(b) || '').localeCompare(String(getCandidateDate(a) || '')));
}

function findUsableBasicsRecord(records, candidateName, excludeSessionId = '') {
  const result = findBestBasicsRecord(
    sortedCandidateRecords(records, candidateName).filter((record) => (
      String(sessionIdOf(record)) !== String(excludeSessionId || '') && !candidateIsNcns(record)
    )),
    candidateName
  );
  return result?.record || null;
}

function headsetIsApproved(value, approvedHeadsets) {
  const normalized = normalizeHeadsetSearchValue(value);
  const compact = compactHeadsetSearchValue(value);
  if (!normalized) return true;
  return (approvedHeadsets || []).some((group) => {
    const brand = String(group?.brand || '').trim();
    return (group?.models || []).some((model) => {
      const modelText = String(model || '').trim();
      return normalizeHeadsetSearchValue(`${brand} ${modelText}`) === normalized
        || normalizeHeadsetSearchValue(modelText) === normalized
        || compactHeadsetSearchValue(`${brand} ${modelText}`) === compact
        || compactHeadsetSearchValue(modelText) === compact
        || headsetModelTokenMatches(modelText, value);
    });
  });
}

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
  const [defaults, setDefaults] = useState({});
  const [techOpen, setTechOpen] = useState(false);
  const [supervisorOnlyMode, setSupervisorOnlyMode] = useState(false);
  const [headsetLookupOpen, setHeadsetLookupOpen] = useState(false);
  const [headsetQuery, setHeadsetQuery] = useState('');
  const [approvedHeadsets, setApprovedHeadsets] = useState([]);
  const [headsetLookupError, setHeadsetLookupError] = useState('');
  const [headsetLookupLoading, setHeadsetLookupLoading] = useState(true);
  const [candidateLookup, setCandidateLookup] = useState({ loading: false, skipped: false, matches: [], error: '', finalAttempt: false, finalAttemptUsed: false, withdrawn: false, extraAttemptGranted: false });
  const [confirmedCandidateMatch, setConfirmedCandidateMatch] = useState(null);
  const [previousSessionOpen, setPreviousSessionOpen] = useState(false);
  const [finalAttemptNoticeShownFor, setFinalAttemptNoticeShownFor] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const dropdownRef = useRef(null);
  const containerRef = useRef(null);
  const itemRefs = useRef([]);
  const [copiedVpnUrl, setCopiedVpnUrl] = useState('');
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
        const [currentSettings, sessionResponse, headsetResponse, defaultsResponse] = await Promise.all([
          api.getSettings(),
          api.getCurrentSession(),
          api.getApprovedHeadsets().catch((error) => ({ groups: [], error: error.message || 'Unable to load the approved headset list right now.' })),
          api.getDefaults(8000).catch(() => ({})),
        ]);
        if (cancelled) return;

        const session = sessionResponse?.session || null;
        const storedSupervisorOnly = Boolean(session?.supervisor_only) || window.sessionStorage.getItem(SUP_ONLY_MODE_KEY) === '1';
        setSupervisorOnlyMode(storedSupervisorOnly);
        setSettings(currentSettings);
        setDefaults(defaultsResponse || {});
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

  useEffect(() => {
    const candidateName = form.candidate_name.trim();
    if (!hydratedRef.current) {
      return undefined;
    }

    if (confirmedCandidateMatch && normalizeName(confirmedCandidateMatch.candidate_name).toLowerCase() !== normalizeName(candidateName).toLowerCase()) {
      setConfirmedCandidateMatch(null);
    }

    if (!isStrongCandidateLookupQuery(candidateName)) {
      setCandidateLookup({ loading: false, skipped: Boolean(candidateName), matches: [], error: '', finalAttempt: false, finalAttemptUsed: false, withdrawn: false, extraAttemptGranted: false });
      return undefined;
    }

    setCandidateLookup((current) => ({ ...current, loading: true, skipped: false, error: '' }));
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.lookupSharedCandidate(candidateName);
        setCandidateLookup({
          loading: false,
          skipped: false,
          matches: Array.isArray(response?.matches) ? response.matches : [],
          error: response?.ok === false ? 'Shared candidate lookup unavailable. Using local session mode.' : '',
          finalAttempt: Boolean(response?.finalAttempt),
          finalAttemptUsed: Boolean(response?.finalAttemptUsed),
          withdrawn: Boolean(response?.withdrawn),
          extraAttemptGranted: Boolean(response?.extraAttemptGranted),
        });
      } catch (error) {
        setCandidateLookup({
          loading: false,
          skipped: false,
          matches: [],
          error: 'Shared candidate lookup unavailable. Using local session mode.',
          finalAttempt: false,
          finalAttemptUsed: false,
          withdrawn: false,
          extraAttemptGranted: false,
        });
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [confirmedCandidateMatch, form.candidate_name]);

  useEffect(() => {
    const candidateName = normalizeName(form.candidate_name).toLowerCase();
    if (!confirmedCandidateMatch || !candidateLookup.finalAttempt || !candidateName || finalAttemptNoticeShownFor === candidateName) {
      return;
    }
    setForm((current) => ({ ...current, final_attempt: true }));
    setFinalAttemptNoticeShownFor(candidateName);
    modal.warning(
      'Final Attempt Detected',
      'Shared records show two prior qualifying failures for this candidate. Final Attempt has been set to Yes.'
    );
  }, [candidateLookup.finalAttempt, confirmedCandidateMatch, finalAttemptNoticeShownFor, form.candidate_name, modal]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const currentHeadsetIsApproved = useMemo(() => {
    const value = String(form.headset_brand || '').trim();
    return Boolean(value) && headsetIsApproved(value, approvedHeadsets);
  }, [approvedHeadsets, form.headset_brand]);

  const allApprovedHeadsetOptions = useMemo(() => {
    return approvedHeadsets.flatMap((group) =>
      (group.models || []).map((model) => selectedHeadsetLabel(group, model))
    );
  }, [approvedHeadsets]);

  const filteredDropdownOptions = useMemo(() => {
    const typed = String(form.headset_brand || '').trim();
    if (!typed) {
      return allApprovedHeadsetOptions;
    }
    return allApprovedHeadsetOptions.filter(option => headsetOptionMatchesQuery(option, typed));
  }, [allApprovedHeadsetOptions, form.headset_brand]);

  // Reset highlighted item when filtered options change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [filteredDropdownOptions]);

  // Click outside to close dropdown
  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, []);

  const handleInputChange = (e) => {
    const val = e.target.value;
    setForm((current) => {
      const next = { ...current, headset_brand: val };
      if (String(val || '').trim() && headsetIsApproved(val, approvedHeadsets)) {
        next.headset_usb = true;
        next.noise_cancel = true;
      } else {
        next.headset_usb = null;
        next.noise_cancel = null;
      }
      return next;
    });
    setDropdownOpen(true);
    setHighlightedIndex(-1);
  };

  const handleInputFocus = () => {
    setDropdownOpen(true);
    setHighlightedIndex(-1);
  };

  const handleArrowClick = (e) => {
    e.stopPropagation();
    setDropdownOpen((prev) => !prev);
    setHighlightedIndex(-1);
  };

  const handleSelectOption = (value) => {
    setForm((current) => ({
      ...current,
      headset_brand: value,
      headset_usb: true,
      noise_cancel: true,
    }));
    setDropdownOpen(false);
  };

  const copyDiscordTemplate = useCallback(async (templateTitle, label) => {
    const message = findDiscordTemplateMessage(settings, defaults, templateTitle);
    if (!String(message || '').trim()) {
      await modal.warning('Discord Post Unavailable', `${label} is not available from Discord posts right now.`);
      return false;
    }
    try {
      await navigator.clipboard.writeText(message);
      return true;
    } catch (_error) {
      await modal.warning('Copy Failed', 'Unable to copy this Discord post automatically. Please open Discord Post and copy it manually.');
      return false;
    }
  }, [defaults, modal, settings]);

  const showFailDiscordModal = useCallback(async ({ title, body, templateTitle, helperText }) => {
    let copied = false;
    while (true) {
      const choice = await modal.showModal({
        type: 'confirm',
        title,
        body: `${body}<div class="fail-discord-copy-helper"><b>${helperText}</b>${copied ? '<span>Copied to clipboard.</span>' : ''}</div>`,
        graphic: 'warning',
        buttons: [
          { label: copied ? 'Copied' : 'Copy', cls: 'discord-copy', value: 'copy-discord' },
          { label: 'Yes', cls: 'btn-primary', value: true },
          { label: 'No', cls: 'btn-muted', value: false },
        ],
      });
      if (choice !== 'copy-discord') return choice;
      copied = await copyDiscordTemplate(templateTitle, helperText);
    }
  }, [copyDiscordTemplate, modal]);

  const scrollIntoView = (index) => {
    const el = itemRefs.current[index];
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  };

  const handleKeyDown = (e) => {
    if (!dropdownOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setDropdownOpen(true);
        setHighlightedIndex(0);
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const next = prev + 1 >= filteredDropdownOptions.length ? 0 : prev + 1;
        scrollIntoView(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => {
        const next = prev - 1 < 0 ? filteredDropdownOptions.length - 1 : prev - 1;
        scrollIntoView(next);
        return next;
      });
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && highlightedIndex < filteredDropdownOptions.length) {
        e.preventDefault();
        const selectedValue = filteredDropdownOptions[highlightedIndex];
        handleSelectOption(selectedValue);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDropdownOpen(false);
    }
  };

  const mostRecentPreviousSession = candidateLookup.matches[0] || null;

  const copyVpnUrl = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedVpnUrl(url);
      window.setTimeout(() => {
        setCopiedVpnUrl((current) => (current === url ? '' : current));
      }, 3000);
    } catch (_error) {
      await modal.warning('Copy Failed', 'Unable to copy this website automatically. Please select and copy the URL manually.');
    }
  };

  const discardWithoutConfirmation = async () => {
    await api.discardSession();
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    onNavigate('home');
  };

  const handleCandidateBlockOrOverride = async (match) => {
    if (form.candidate_override_used) {
      return { allowed: true, override: true };
    }
    const candidateName = match?.candidate_name || form.candidate_name.trim() || 'This candidate';
    const extraAttemptGranted = sheetTruthy(candidateLookup.extraAttemptGranted) || sheetTruthy(match?.extra_attempt_granted);
    if (candidateIsWithdrawn(match) && !extraAttemptGranted) {
      await modal.showModal({
        type: 'warning',
        title: 'Candidate Withdrawn',
        body: `<b>${candidateName}</b> is marked withdrawn from certification. Testing cannot continue unless an admin restores the candidate or grants an extra attempt in SAM. This session will be discarded.`,
        graphic: 'warning',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
      });
      await discardWithoutConfirmation();
      return { allowed: false };
    }

    if ((candidateLookup.finalAttemptUsed || candidateHasFinalAttemptUsed(match)) && !extraAttemptGranted) {
      const choice = await modal.showModal({
        type: 'warning',
        title: 'Final Attempt Already Used',
        body: `${candidateName} has already used their last attempt and is no longer able to continue. Please have the candidate email certification@acddirect.com if there are any issues. You can also post in the Discord Tester Room for further assistance. This session will be discarded.`,
        graphic: 'warning',
        buttons: [
          { label: 'OK', cls: 'btn-primary', value: 'discard' },
          { label: 'Override', cls: 'btn-danger', value: 'override' },
        ],
      });
      if (choice !== 'override') {
        await discardWithoutConfirmation();
        return { allowed: false };
      }
      const confirmed = await modal.showModal({
        type: 'confirm',
        title: 'Confirm Override',
        body: `Are you sure that you want to continue testing ${candidateName} with an additional attempt?`,
        graphic: 'warning',
        buttons: [
          { label: 'Yes', cls: 'btn-danger', value: true },
          { label: 'No', cls: 'btn-muted', value: false },
        ],
      });
      if (!confirmed) return { allowed: false };
      await modal.warning(
        'Override Logged',
        'Override should only be used if there is an error or with permission from the Admin. If you have not yet done so, please notify Admin in the Discord Tester Room that an override was used for this candidate. This session will be logged as an override.'
      );
      return { allowed: true, override: true };
    }

    return { allowed: true, override: false };
  };

  const logUnknownHeadsetIfNeeded = async (sessionData) => {
    const headsetModel = String(sessionData?.headset_brand || '').trim();
    if (!headsetModel || headsetIsApproved(headsetModel, approvedHeadsets)) return;
    try {
      await api.logHeadsetReview({
        headset_model: headsetModel,
        candidate_name: sessionData?.candidate_name || '',
        tester_name: sessionData?.tester_name || '',
      });
    } catch (_error) {
      // Headset review logging is non-blocking; certification workflow continues.
    }
  };

  const buildBasicsRecoveredForm = (source, candidateName, finalAttempt, blockResult) => ({
    ...mergeBasicsIntoSession(form, buildBasicsFromRecord(source)),
    candidate_name: candidateName || form.candidate_name,
    tester_name: form.tester_name || settings.tester_name || source?.tester_name || '',
    final_attempt: finalAttempt,
    headset_brand: isMissingHeadsetValue(buildBasicsFromRecord(source).headset_brand)
      ? (findMostRecentHeadset(candidateLookup.matches, candidateName) || form.headset_brand)
      : buildBasicsFromRecord(source).headset_brand,
    candidate_override_used: Boolean(blockResult.override),
    candidate_override_reason: blockResult.override ? 'Tester override after shared final-attempt block.' : '',
  });

  const startConfirmedCandidate = async (match) => {
    if (!match) return;
    const candidateName = match.candidate_name || form.candidate_name.trim();
    const confirmed = await modal.confirm(
      'Correct Candidate?',
      `Use shared records for <b>${candidateName || 'this candidate'}</b> and start testing?`
    );
    if (!confirmed) return;

    const blockResult = await handleCandidateBlockOrOverride(match);
    if (!blockResult.allowed) return;

    const finalAttempt = sheetTruthy(candidateLookup.finalAttempt) || sheetTruthy(match.final_attempt) || sheetTruthy(form.final_attempt);
    let basicsSource = match;
    if (candidateIsNcns(match) || !hasUsableBasicsInfo(match)) {
      let history = [];
      try {
        history = await api.getHistory();
      } catch (_error) {
        history = [];
      }
      const basicsResult = findBestBasicsRecord([...history, ...candidateLookup.matches], candidateName, match);
      basicsSource = basicsResult?.record || findUsableBasicsRecord([...history, ...candidateLookup.matches], candidateName, match.session_id || match.history_id || '');
      console.info('[MTS] Basics recovery', {
        candidate: candidateName,
        selectedSession: match.session_id || match.history_id || '',
        basicsFound: Boolean(basicsSource),
        source: basicsResult?.basics?.source || '',
      });
      if (!basicsSource) {
        const linkedForm = {
          ...form,
          candidate_name: candidateName || form.candidate_name,
          tester_name: form.tester_name || settings.tester_name || match.tester_name || '',
          final_attempt: finalAttempt,
          candidate_override_used: Boolean(blockResult.override),
          candidate_override_reason: blockResult.override ? 'Tester override after shared final-attempt block.' : '',
        };
        setConfirmedCandidateMatch(match);
        setForm(linkedForm);
        await api.updateSession({ ...linkedForm, supervisor_only: supervisorOnlyMode, status: 'In Progress' }).catch(() => {});
        await modal.warning(
          'Basics Required',
          'No previous Basics information exists for this candidate. Please complete the Basics screen before continuing.'
        );
        return;
      }
    }

    const nextForm = buildBasicsRecoveredForm(basicsSource, candidateName, finalAttempt, blockResult);
    setConfirmedCandidateMatch(match);
    setForm(nextForm);
    if (finalAttempt && finalAttemptNoticeShownFor !== normalizeName(nextForm.candidate_name).toLowerCase()) {
      setFinalAttemptNoticeShownFor(normalizeName(nextForm.candidate_name).toLowerCase());
      await modal.warning(
        'Final Attempt Detected',
        'Shared records indicate this candidate is on a final attempt. Final Attempt has been set to Yes.'
      );
    }
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await logUnknownHeadsetIfNeeded(nextForm);
    await api.startSession({ ...nextForm, supervisor_only: supervisorOnlyMode, time_for_sup: supervisorOnlyMode ? true : null });
    onNavigate(supervisorOnlyMode ? 'suptransfer' : 'calls');
  };

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
    const confirmed = await modal.confirmDanger('Discard Session', 'Discard the current session draft and lose all progress? This cannot be undone.');
    if (!confirmed) return;
    await discardWithoutConfirmation();
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
    await logUnknownHeadsetIfNeeded(data);
    await api.startSession(data);
    onNavigate('review');
  };

  const handleContinue = async () => {
    const headsetApproved = Boolean(String(form.headset_brand || '').trim()) && headsetIsApproved(form.headset_brand, approvedHeadsets);
    const d = headsetApproved
      ? { ...form, headset_usb: true, noise_cancel: true }
      : form;
    let candidateBlockResult = { allowed: true, override: false };
    if (!d.candidate_name.trim()) { await modal.warning('Missing Info', 'Candidate Name is required.'); return; }
    if (confirmedCandidateMatch) {
      candidateBlockResult = await handleCandidateBlockOrOverride(confirmedCandidateMatch);
      if (!candidateBlockResult.allowed) return;
      if (candidateBlockResult.override) {
        set('candidate_override_used', true);
      }
    } else if (candidateLookup.withdrawn || candidateLookup.finalAttemptUsed) {
      candidateBlockResult = await handleCandidateBlockOrOverride({ candidate_name: d.candidate_name });
      if (!candidateBlockResult.allowed) return;
    }
    if (!d.headset_brand.trim()) { await modal.warning('Missing Info', 'Headset brand/model is required.'); return; }
    if (!headsetApproved && (d.headset_usb === null || d.noise_cancel === null)) { await modal.warning('Missing Info', 'USB and Noise Cancelling answers are required for headsets that are not on the approved list.'); return; }
    if (d.vpn_on === null) { await modal.warning('Missing Info', 'VPN question must be answered.'); return; }
    if (d.vpn_on && d.vpn_off === null) { await modal.warning('Missing Info', 'Please confirm if the candidate can turn off their VPN.'); return; }
    if (d.chrome_default === null || d.extensions_disabled === null || d.popups_allowed === null) { await modal.warning('Missing Info', 'All Browser questions must be answered.'); return; }

    if (!d.headset_usb || !d.noise_cancel) {
      const reasons = [];
      if (!d.headset_usb) reasons.push('Wrong headset (not USB)');
      if (!d.noise_cancel) reasons.push('Wrong headset (not noise cancelling)');
      const yes = await showFailDiscordModal({
        title: 'Headset Issue',
        body: `To contract with ACD, a USB headset with a noise cancelling microphone must be used.<br><br>Fail session for: <b>${reasons.join(' and ')}</b>?`,
        templateTitle: 'Wrong Headset',
        helperText: 'Headset Fail Discord Post',
      });
      if (yes) {
        const failData = { ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: reasons.join(' and '), final_status: 'Fail' };
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await logUnknownHeadsetIfNeeded(failData);
        await api.startSession(failData);
        onNavigate('review');
      }
      return;
    }
    if (d.vpn_on && d.vpn_off === false) {
      const yes = await showFailDiscordModal({
        title: 'VPN Issue',
        body: 'Using a VPN is not accepted when contracting with ACD. The candidate cannot turn it off.<br><br>Fail this session?',
        templateTitle: 'VPN Fail',
        helperText: 'VPN Fail Discord Post',
      });
      if (yes) {
        const failData = { ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Unable to turn off VPN', final_status: 'Fail' };
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await logUnknownHeadsetIfNeeded(failData);
        await api.startSession(failData);
        onNavigate('review');
      }
      return;
    }
    if (d.chrome_default === false) {
      const fixed = await modal.confirm('Browser Issue', 'The browser must be set as default so that DTE login functions properly.<br><br>Were they able to fix it?');
      if (!fixed) {
        const failData = { ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' };
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await logUnknownHeadsetIfNeeded(failData);
        await api.startSession(failData);
        onNavigate('review');
        return;
      }
    }
    if (d.extensions_disabled === false) {
      const fixed = await modal.confirm('Browser Issue', 'Browser extensions must be disabled so they do not interfere with the script.<br><br>Were they able to fix it?');
      if (!fixed) {
        const failData = { ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' };
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await logUnknownHeadsetIfNeeded(failData);
        await api.startSession(failData);
        onNavigate('review');
        return;
      }
    }
    if (d.popups_allowed === false) {
      const fixed = await modal.confirm('Browser Issue', 'Necessary pop-ups must be allowed so the script can pop correctly.<br><br>Were they able to fix it?');
      if (!fixed) {
        const failData = { ...d, supervisor_only: supervisorOnlyMode, auto_fail_reason: 'Not ready for session (incorrect settings)', final_status: 'Fail' };
        window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
        await logUnknownHeadsetIfNeeded(failData);
        await api.startSession(failData);
        onNavigate('review');
        return;
      }
    }
    const startData = {
      ...d,
      candidate_override_used: Boolean(d.candidate_override_used || candidateBlockResult.override),
      candidate_override_reason: d.candidate_override_reason || (candidateBlockResult.override ? 'Tester override after shared final-attempt block.' : ''),
      supervisor_only: supervisorOnlyMode,
      time_for_sup: supervisorOnlyMode ? true : null,
    };
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await logUnknownHeadsetIfNeeded(startData);
    await api.startSession(startData);
    onNavigate(supervisorOnlyMode ? 'suptransfer' : 'calls');
  };

  const RadioGroup = ({ name, value, onChange, disabled = false }) => (
    <div className="radio-group">
      <label className={`radio-label ${disabled ? 'disabled' : ''}`}><input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} disabled={disabled} /> Yes</label>
      <label className={`radio-label ${disabled ? 'disabled' : ''}`}><input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} disabled={disabled} /> No</label>
    </div>
  );

  return (
    <div className="page-with-sticky-actions" data-testid="basics-page">
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
        {candidateLookup.loading && (
          <div className="text-xs text-muted" style={{ marginTop: 10 }}>Checking shared candidate records...</div>
        )}
        {candidateLookup.skipped && (
          <div className="text-xs text-muted" style={{ marginTop: 10 }}>
            Shared lookup starts after a stronger candidate name is entered, such as first name plus part of last name.
          </div>
        )}
        {candidateLookup.error && (
          <div className="text-xs" style={{ marginTop: 10, color: 'var(--color-warning)' }}>{candidateLookup.error}</div>
        )}
        {candidateLookup.matches.length > 0 && (
          <div className="card" style={{ marginTop: 12, padding: 14, background: 'var(--bg-card-hover)' }} data-testid="candidate-lookup-prompt">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontWeight: 800 }}>Previous session found for this candidate.</div>
                <div className="text-xs text-muted">
                  Candidate: <b>{mostRecentPreviousSession?.candidate_name || form.candidate_name}</b> - Tester: {mostRecentPreviousSession?.tester_name || 'Unknown tester'} - Status: {mostRecentPreviousSession?.status || 'Unknown'} - Date: {getCandidateDate(mostRecentPreviousSession)}
                </div>
                <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                  Attempt: {mostRecentPreviousSession?.attempt_number || mostRecentPreviousSession?.attempt_count || 'Unknown'}
                  {candidateLookup.finalAttempt ? ' - final attempt now' : ''}
                  {candidateLookup.finalAttemptUsed || candidateHasFinalAttemptUsed(mostRecentPreviousSession) ? ' - final attempt already used' : ''}
                  {candidateLookup.extraAttemptGranted ? ' - extra attempt granted' : ''}
                  {candidateLookup.withdrawn ? ' - withdrew from certification' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-muted btn-sm" onClick={() => setPreviousSessionOpen(true)}>Review Previous Session</button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => startConfirmedCandidate(mostRecentPreviousSession)}>Correct Candidate</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCandidateLookup((current) => ({ ...current, matches: [] }))}>Ignore</button>
              </div>
            </div>
          </div>
        )}
        {confirmedCandidateMatch && candidateLookup.finalAttempt && (
          <div className="banner banner-fail" style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', padding: 12 }}>
            Shared records indicate this is the candidate&apos;s final attempt.
          </div>
        )}
        {candidateLookup.extraAttemptGranted && !candidateLookup.finalAttempt && (
          <div className="banner banner-incomplete" style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', padding: 12 }}>
            Shared records show an additional attempt was granted.
          </div>
        )}
        {confirmedCandidateMatch && candidateLookup.withdrawn && (
          <div className="banner banner-fail" style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', padding: 12 }}>
            This candidate withdrew from certification and cannot be resumed or started unless reversed by an admin.
          </div>
        )}
      </div>
      <div className="card basics-headset-card" data-tour="basics-headset-section">
        <h3 style={{ marginBottom: 12 }}>Headset Requirements</h3>
        <div className="basics-headset-layout">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="basics-headset-brand-row">
              <label className="text-sm font-bold" style={{ minWidth: 160 }}>Brand / Model</label>
              <div ref={containerRef} className="headset-autocomplete-container" style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
                <input
                  type="text"
                  value={form.headset_brand}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onFocus={handleInputFocus}
                  placeholder="e.g. Logitech H390"
                  data-testid="basics-brand"
                  autoComplete="off"
                  style={{ width: '100%', paddingRight: '32px' }}
                />
                <button
                  type="button"
                  className="headset-dropdown-arrow-btn"
                  onClick={handleArrowClick}
                  onMouseDown={e => e.preventDefault()}
                  style={{
                    position: 'absolute',
                    right: '8px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-secondary, #888)'
                  }}
                  aria-label="Toggle Headset List"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
                {dropdownOpen && (
                  <ul
                    ref={dropdownRef}
                    className="dropdown-menu headset-dropdown-menu"
                  >
                    {filteredDropdownOptions.length === 0 ? (
                      <li className="headset-dropdown-empty-item">
                        No matching approved headsets
                      </li>
                    ) : (
                      filteredDropdownOptions.map((label, index) => {
                        const isHighlighted = index === highlightedIndex;
                        return (
                          <li
                            key={label}
                            ref={el => { itemRefs.current[index] = el; }}
                            onClick={() => handleSelectOption(label)}
                            onMouseDown={e => e.preventDefault()}
                            className={`headset-dropdown-item ${isHighlighted ? 'highlighted' : ''}`}
                          >
                            {label}
                          </li>
                        );
                      })
                    )}
                  </ul>
                )}
              </div>
            </div>
            <div className="basics-headset-note">
              {HEADSET_HELPER_TEXT}
            </div>
            {currentHeadsetIsApproved && (
              <div className="basics-headset-auto-note">
                Approved headset selected. USB and Noise Cancelling are marked Yes automatically.
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 160 }}>Is the headset USB?</label>
              <RadioGroup name="b-usb" value={form.headset_usb} onChange={v => set('headset_usb', v)} disabled={currentHeadsetIsApproved} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label className="text-sm font-bold" style={{ minWidth: 160 }}>Noise Cancelling Mic?</label>
              <RadioGroup name="b-noise" value={form.noise_cancel} onChange={v => set('noise_cancel', v)} disabled={currentHeadsetIsApproved} />
            </div>
          </div>
          <div className="basics-headset-info-panel">
            <ul>
              {HEADSET_DETAIL_BULLETS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
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
            <div className="text-xs text-muted vpn-help-links">
              If checking for VPN or proxy is necessary, more than one check is recommended because some databases do not update as often as others. You can have the candidate navigate to one or more of the following websites:
              <div className="vpn-copy-helper">Click a website to copy it to your clipboard. Then paste it into Discord.</div>
              <div className="vpn-copy-list">
                {VPN_CHECK_URLS.map((url) => (
                  <button
                    key={url}
                    type="button"
                    className="vpn-copy-link"
                    onClick={() => copyVpnUrl(url)}
                    title={`Copy ${url}`}
                  >
                    <span>{url}</span>
                    <strong>{copiedVpnUrl === url ? 'Copied' : 'Copy'}</strong>
                  </button>
                ))}
              </div>
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
                style={{ marginBottom: 6 }}
              />
              <div className="text-xs text-muted headset-lookup-update-note">
                This list is updated every 1-2 weeks.
              </div>
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
                                handleSelectOption(`${group.brand} ${model}`);
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

      {previousSessionOpen && (
        <PreviousSessionModal
          matches={candidateLookup.matches}
          candidateName={form.candidate_name}
          onClose={() => setPreviousSessionOpen(false)}
        />
      )}

      <div className="footer-bar sticky-action-footer" data-testid="basics-footer">
        <div className="action-safety-group">
          <button className="btn btn-muted btn-sm" onClick={() => onNavigate('home')} data-testid="basics-back">Back</button>
          <button className="btn btn-danger-outline btn-sm" onClick={handleDiscardSession} data-testid="basics-discard" title="Discard the current session draft and lose all progress">Discard Session</button>
        </div>
        <span className="action-divider" aria-hidden="true" />
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

function PreviousSessionModal({ matches, candidateName, onClose }) {
  const [expanded, setExpanded] = useState(0);
  const sessions = Array.isArray(matches) ? matches : [];
  return (
    <div className="modal-overlay open" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 760, maxWidth: '94vw', maxHeight: '86vh' }}>
        <div className="modal-header">
          <h2>Previous Candidate Sessions</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {sessions.map((session, index) => {
            const isOpen = expanded === index;
            const recovered = findBestBasicsRecord(sessions, candidateName || session.candidate_name, session)?.basics || buildBasicsFromRecord(session);
            return (
              <div key={`${session.session_id || index}`} className="card" style={{ marginBottom: 12, padding: 16 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'space-between' }}
                  onClick={() => setExpanded(isOpen ? -1 : index)}
                >
                  <span>{session.candidate_name || 'Unknown'} - {session.status || 'Unknown'} - {session.tester_name || 'Unknown tester'}</span>
                  <span>{isOpen ? 'Hide' : 'Details'}</span>
                </button>
                {isOpen && (
                  <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                    <div className="text-sm"><b>Candidate:</b> {session.candidate_name || 'Unknown'}</div>
                    <div className="text-sm"><b>Tester:</b> {session.tester_name || 'Unknown tester'}</div>
                    <div className="text-sm"><b>Status:</b> {session.status || 'Unknown'}</div>
                    <div className="text-sm"><b>Date:</b> {getCandidateDate(session)}</div>
                    <div className="text-sm"><b>Completed:</b> {session.completed_at || session.created_at || 'Unknown'}</div>
                    <div className="text-sm"><b>Attempt:</b> {session.attempt_number || session.attempt_count || 'Unknown'}</div>
                    <div className="text-sm"><b>Final attempt:</b> {session.final_attempt ? 'Yes' : 'No'}</div>
                    <div className="text-sm"><b>Headset USB:</b> {recovered.headset_usb === true ? 'Yes' : recovered.headset_usb === false ? 'No' : 'N/A'}</div>
                    <div className="text-sm"><b>Noise Cancelling Mic:</b> {recovered.noise_cancel === true ? 'Yes' : recovered.noise_cancel === false ? 'No' : 'N/A'}</div>
                    <div className="text-sm"><b>Headset:</b> {recovered.headset_brand || 'N/A'}</div>
                    <div className="text-sm"><b>VPN:</b> {recovered.vpn_on === true ? 'Yes' : recovered.vpn_on === false ? 'No' : 'N/A'}</div>
                    {recovered.vpn_on === true && <div className="text-sm"><b>VPN Can Turn Off:</b> {recovered.vpn_off === true ? 'Yes' : recovered.vpn_off === false ? 'No' : 'N/A'}</div>}
                    <div className="text-sm"><b>Default Browser:</b> {recovered.chrome_default === true ? 'Yes' : recovered.chrome_default === false ? 'No' : 'N/A'}</div>
                    <div className="text-sm"><b>Extensions Off:</b> {recovered.extensions_disabled === true ? 'Yes' : recovered.extensions_disabled === false ? 'No' : 'N/A'}</div>
                    <div className="text-sm"><b>Pop-ups Allowed:</b> {recovered.popups_allowed === true ? 'Yes' : recovered.popups_allowed === false ? 'No' : 'N/A'}</div>
                    <div className="text-sm"><b>Pending supervisor transfer:</b> {session.needs_sup_transfer ? 'Yes' : 'No'}</div>
                    <div className="text-sm"><b>Calls:</b> {[session.call_1_result, session.call_2_result, session.call_3_result].filter(Boolean).join(', ') || 'None recorded'}</div>
                    <div className="text-sm"><b>Supervisor transfers:</b> {[session.sup_transfer_1_result, session.sup_transfer_2_result].filter(Boolean).join(', ') || 'None recorded'}</div>
                    <div>
                      <div className="text-sm font-bold">Coaching Summary</div>
                      <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>{session.coaching_summary || 'None recorded'}</div>
                    </div>
                    <div>
                      <div className="text-sm font-bold">Reason for Fail Summary</div>
                      <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>{session.fail_summary || 'N/A'}</div>
                    </div>
                    <div>
                      <div className="text-sm font-bold">Notes</div>
                      <div className="text-sm text-muted" style={{ whiteSpace: 'pre-wrap' }}>{session.notes || session.review_notes || 'None recorded'}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
