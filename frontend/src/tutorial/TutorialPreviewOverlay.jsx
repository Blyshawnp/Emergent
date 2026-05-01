import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Joyride, ACTIONS, EVENTS, STATUS } from 'react-joyride';

const TARGET_WAIT_TIMEOUT_MS = 5000;

function resolveTarget(step) {
  return step.fallbackTarget || step.target;
}

function waitForTarget(selector, timeoutMs = TARGET_WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!selector) {
      resolve(false);
      return;
    }

    const startedAt = Date.now();

    const check = () => {
      if (document.querySelector(selector)) {
        resolve(true);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }

      window.setTimeout(check, 80);
    };

    check();
  });
}

export default function TutorialPreviewOverlay({
  run,
  stepIndex,
  setStepIndex,
  setRun,
  navigate,
  currentPage,
  onStop,
}) {
  const transitionRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const steps = useMemo(() => ([
    {
      id: 'welcome',
      page: 'home',
      target: 'body',
      content: (
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 10, color: '#ffffff' }}>
            Welcome to Mock Testing Suite
          </div>
          <div style={{ lineHeight: 1.65, color: '#e2e8f0' }}>
            This walkthrough highlights the main workflow without changing your session data.
            You can skip it at any time, and replay it later from Help.
          </div>
        </div>
      ),
      placement: 'center',
    },
    {
      id: 'home-header',
      page: 'home',
      target: '[data-tour="home-header"]',
      fallbackTarget: '[data-testid="home-page"]',
      content: 'Home is the main dashboard for starting sessions and checking recent activity.',
      placement: 'bottom',
    },
    {
      id: 'home-start',
      page: 'home',
      target: '[data-testid="home-start-btn"]',
      content: 'Start New Session begins the standard flow: Basics, Calls, Supervisor Transfer, then Review.',
      placement: 'bottom',
    },
    {
      id: 'home-sup-only',
      page: 'home',
      target: '[data-testid="home-sup-only-btn"]',
      content: 'Supervisor Transfer Only is for candidates who already completed mock calls and only need the transfer portion.',
      placement: 'bottom',
    },
    {
      id: 'home-history',
      page: 'home',
      target: '[data-testid="home-history-btn"]',
      content: 'Session History lets you review saved sessions and reopen historical summaries without changing active work.',
      placement: 'bottom',
    },
    {
      id: 'sidebar',
      page: 'home',
      target: '[data-testid="sidebar"]',
      content: 'The sidebar keeps the main tools reachable at all times: workflow pages, settings, help, Discord tools, and Exit App.',
      placement: 'right',
    },
    {
      id: 'sidebar-discord',
      page: 'home',
      target: '[data-tour="sidebar-discord"]',
      content: 'Discord Post opens saved templates and screenshots used during live tester communication.',
      placement: 'right',
    },
    {
      id: 'basics-candidate',
      page: 'basics',
      target: '[data-testid="basics-candidate"]',
      content: 'The Basics page collects candidate and session setup information before any scoring begins.',
      placement: 'bottom',
    },
    {
      id: 'basics-final-attempt',
      page: 'basics',
      target: '[data-tour="basics-final-attempt"]',
      content: 'Final Attempt should only be marked Yes when this is the candidate’s last allowed mock session.',
      placement: 'bottom',
    },
    {
      id: 'basics-headset',
      page: 'basics',
      target: '[data-tour="basics-headset-section"]',
      content: 'Headset rules are strict: the candidate must use a USB headset with a noise-cancelling microphone.',
      placement: 'right',
    },
    {
      id: 'basics-vpn',
      page: 'basics',
      target: '[data-tour="basics-vpn-section"]',
      content: 'VPN use must be checked here. If the candidate has a VPN and cannot turn it off, the session fails.',
      placement: 'left',
    },
    {
      id: 'basics-browser',
      page: 'basics',
      target: '[data-tour="basics-browser-section"]',
      content: 'Browser requirements are verified here: Chrome or the required browser must be default, extensions off, and pop-ups allowed.',
      placement: 'left',
    },
    {
      id: 'basics-danger',
      page: 'basics',
      target: '[data-testid="basics-ncns"]',
      content: 'The red footer actions are immediate session outcomes. NC/NS, Not Ready, and Stopped Responding are danger-path buttons. Tech Issue opens troubleshooting instead of ending the session immediately.',
      placement: 'top',
    },
    {
      id: 'basics-continue',
      page: 'basics',
      target: '[data-testid="basics-continue"]',
      content: 'Continue validates the Basics requirements, applies any automatic fail rules, and then routes into Calls or Supervisor Transfer Only.',
      placement: 'left',
    },
    {
      id: 'calls-setup',
      page: 'calls',
      target: '[data-tour="calls-setup"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Calls is where the tester configures the scenario and scores the candidate’s mock call performance.',
      placement: 'right',
    },
    {
      id: 'calls-scenario',
      page: 'calls',
      target: '[data-testid="scenario-card"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'The scenario card tells you who to portray and what variables apply to the call.',
      placement: 'left',
    },
    {
      id: 'calls-payment',
      page: 'calls',
      target: '[data-tour="calls-payment"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Payment Simulation provides the card and EFT details used during mock call testing.',
      placement: 'top',
    },
    {
      id: 'calls-result',
      page: 'calls',
      target: '[data-testid="call-pass"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Each mock call is marked Pass or Fail. A candidate needs 2 passed calls, and those passes must include 1 New Member pass and 1 Existing Member pass.',
      placement: 'bottom',
    },
    {
      id: 'calls-coaching',
      page: 'calls',
      target: '[data-tour="calls-coaching"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Record coaching given during the call here. These selections feed the final review summary later.',
      placement: 'top',
    },
    {
      id: 'calls-fails',
      page: 'calls',
      target: '[data-tour="calls-fail-reasons"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'If a call fails, select the specific fail reasons so Review can document the result accurately.',
      placement: 'top',
    },
    {
      id: 'calls-continue',
      page: 'calls',
      target: '[data-testid="calls-continue"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Continue saves the current call and applies the routing rules for the next call, Supervisor Transfer, or Review.',
      placement: 'left',
    },
    {
      id: 'sup-banner',
      page: 'suptransfer',
      target: '[data-tour="sup-discord-banner"]',
      fallbackTarget: '[data-testid="suptransfer-page"]',
      content: 'Supervisor Transfer uses the transfer number and the required Discord message to set up the live transfer test.',
      placement: 'bottom',
    },
    {
      id: 'sup-copy',
      page: 'suptransfer',
      target: '[data-testid="sup-copy-discord"]',
      fallbackTarget: '[data-testid="suptransfer-page"]',
      content: 'Use Copy to place the transfer message on the clipboard before posting it in Discord.',
      placement: 'left',
    },
    {
      id: 'sup-setup',
      page: 'suptransfer',
      target: '[data-tour="sup-setup"]',
      fallbackTarget: '[data-testid="suptransfer-page"]',
      content: 'Choose the caller, show, and supervisor reason here before scoring the transfer.',
      placement: 'right',
    },
    {
      id: 'sup-result',
      page: 'suptransfer',
      target: '[data-testid="sup-pass"]',
      fallbackTarget: '[data-testid="suptransfer-page"]',
      content: 'At least 1 passing supervisor transfer is required to complete the session successfully.',
      placement: 'bottom',
    },
    {
      id: 'newbie-form',
      page: 'newbieshift',
      target: '[data-tour="newbie-form"]',
      fallbackTarget: '[data-testid="newbieshift-page"]',
      content: 'Newbie Shift is used when the candidate needs a scheduled follow-up instead of a final pass outcome.',
      placement: 'bottom',
    },
    {
      id: 'newbie-date',
      page: 'newbieshift',
      target: '[data-testid="newbie-date"]',
      fallbackTarget: '[data-testid="newbieshift-page"]',
      content: 'Set the follow-up date, time, and timezone here for the next session.',
      placement: 'bottom',
    },
    {
      id: 'newbie-gcal',
      page: 'newbieshift',
      target: '[data-testid="newbie-gcal"]',
      fallbackTarget: '[data-testid="newbieshift-page"]',
      content: 'Add to Google Calendar opens a prefilled calendar link so the follow-up can be scheduled quickly.',
      placement: 'top',
    },
    {
      id: 'review-banner',
      page: 'review',
      target: '[data-testid="review-banner"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Review is the final checkpoint for the session outcome before anything is saved or sent onward.',
      placement: 'bottom',
    },
    {
      id: 'review-coaching',
      page: 'review',
      target: '[data-testid="review-coaching"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Check the coaching summary carefully. If Gemini is enabled, review the generated wording before using it.',
      placement: 'top',
    },
    {
      id: 'review-fail',
      page: 'review',
      target: '[data-testid="review-fail"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Review the fail summary as well so the documented reasons match the actual session result.',
      placement: 'top',
    },
    {
      id: 'review-fill',
      page: 'review',
      target: '[data-testid="review-fill-form"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Fill Form opens the Microsoft certification form with your data mapped in. It helps prefill fields, but it does not auto-submit the form for you.',
      placement: 'top',
    },
    {
      id: 'review-finish',
      page: 'review',
      target: '[data-testid="review-finish"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Save & Finish Session writes the session to history and clears the active draft.',
      placement: 'top',
    },
    {
      id: 'settings-tabs',
      page: 'settings',
      target: '[data-tour="settings-tabs"]',
      fallbackTarget: '[data-testid="settings-page"]',
      content: 'Settings is where you manage application behavior, reference data, and integrations.',
      placement: 'bottom',
    },
    {
      id: 'settings-general',
      page: 'settings',
      target: '[data-testid="settings-general"]',
      fallbackTarget: '[data-testid="settings-page"]',
      content: 'General settings include tester identity, form links, sounds, and theme options.',
      placement: 'top',
    },
    {
      id: 'settings-gemini',
      page: 'settings',
      target: '[data-testid="settings-gemini"]',
      fallbackTarget: '[data-testid="settings-page"]',
      prepareSelector: '[data-testid="settings-tab-gemini"]',
      content: 'Gemini settings control AI-generated coaching and fail summaries. These summaries should always be reviewed before use.',
      placement: 'top',
    },
    {
      id: 'settings-discord',
      page: 'settings',
      target: '[data-testid="settings-discord"]',
      fallbackTarget: '[data-testid="settings-page"]',
      prepareSelector: '[data-testid="settings-tab-discord"]',
      content: 'Discord settings let you manage templates and screenshots used from the sidebar Discord Post panel.',
      placement: 'top',
    },
    {
      id: 'settings-updates',
      page: 'settings',
      target: '[data-testid="settings-update-panel"]',
      fallbackTarget: '[data-testid="settings-page"]',
      content: 'The update panel is where desktop update checks and deferred installs are managed.',
      placement: 'top',
    },
    {
      id: 'settings-save',
      page: 'settings',
      target: '[data-testid="settings-save"]',
      fallbackTarget: '[data-testid="settings-page"]',
      content: 'Save Settings commits your configuration changes. Use this after updating sounds, Gemini, Discord, or other settings.',
      placement: 'top',
    },
    {
      id: 'help-header',
      page: 'help',
      target: '[data-tour="help-header"]',
      fallbackTarget: '[data-testid="help-page"]',
      content: 'Help collects workflow guidance, setup references, FAQs, and support details.',
      placement: 'bottom',
    },
    {
      id: 'help-replay',
      page: 'help',
      target: '[data-testid="help-tutorial"]',
      fallbackTarget: '[data-testid="help-page"]',
      content: 'Replay App Tutorial lets you run this walkthrough again any time.',
      placement: 'left',
    },
    {
      id: 'sidebar-exit',
      page: 'help',
      target: '[data-tour="sidebar-exit"]',
      content: 'Exit App is always available from the sidebar when you are done.',
      placement: 'top',
    },
  ].map((step) => ({
    disableBeacon: true,
    ...step,
  }))), []);

  const prepareStep = useCallback(async (step) => {
    if (!step || transitionRef.current) return;

    transitionRef.current = true;
    setRun(false);

    if (step.page !== currentPage) {
      navigate(step.page, null);
    }

    if (step.prepareSelector) {
      await waitForTarget(step.prepareSelector, 1500);
      document.querySelector(step.prepareSelector)?.click();
    }

    await waitForTarget(resolveTarget(step));

    if (!mountedRef.current) return;

    transitionRef.current = false;
    setRun(true);
  }, [currentPage, navigate, setRun]);

  useEffect(() => {
    if (!run || transitionRef.current) return;

    const step = steps[stepIndex];
    if (!step) return;

    if (!document.querySelector(resolveTarget(step))) {
      prepareStep(step);
    }
  }, [currentPage, prepareStep, run, stepIndex, steps]);

  const handleJoyrideCallback = useCallback((data) => {
    const { action, index, status, type } = data;

    if (status === STATUS.FINISHED) {
      onStop?.('completed');
      return;
    }

    if (status === STATUS.SKIPPED) {
      onStop?.('dismissed');
      return;
    }

    if (type === EVENTS.TARGET_NOT_FOUND) {
      const currentStep = steps[index];
      const fallbackTarget = currentStep?.fallbackTarget;
      if (fallbackTarget && document.querySelector(fallbackTarget)) {
        return;
      }
    }

    if (type === EVENTS.STEP_AFTER) {
      const delta = action === ACTIONS.PREV ? -1 : 1;
      const nextIndex = index + delta;

      if (nextIndex < 0) {
        setStepIndex(0);
        return;
      }

      if (nextIndex >= steps.length) {
        onStop?.('completed');
        return;
      }

      setStepIndex(nextIndex);
    }
  }, [onStop, setStepIndex, steps]);

  return (
    <Joyride
      steps={steps}
      run={run}
      stepIndex={stepIndex}
      callback={handleJoyrideCallback}
      disableBeacon
      continuous
      showProgress
      showSkipButton
      scrollToFirstStep
      disableOverlayClose
      spotlightPadding={8}
      locale={{
        back: 'Back',
        close: 'Close',
        last: 'Finish',
        next: 'Next',
        skip: 'Skip',
      }}
      styles={{
        options: {
          zIndex: 10000,
          primaryColor: '#38bdf8',
          textColor: '#f8fafc',
          backgroundColor: '#0b1220',
          arrowColor: '#0b1220',
          overlayColor: 'rgba(0, 0, 0, 0.45)',
        },
        tooltip: {
          borderRadius: 18,
          padding: 20,
          border: '1px solid rgba(56, 189, 248, 0.28)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(56, 189, 248, 0.25)',
        },
        tooltipContainer: {
          padding: 4,
        },
        tooltipContent: {
          color: '#e2e8f0',
          fontSize: 14,
          lineHeight: 1.6,
        },
        buttonNext: {
          borderRadius: 10,
          padding: '10px 16px',
          fontWeight: 700,
          backgroundColor: '#38bdf8',
          color: '#08111f',
          border: '1px solid rgba(125, 211, 252, 0.8)',
          boxShadow: '0 10px 24px rgba(56, 189, 248, 0.24)',
        },
        buttonBack: {
          color: '#cbd5e1',
          marginRight: 8,
        },
        buttonSkip: {
          color: '#94a3b8',
        },
        buttonClose: {
          color: '#94a3b8',
        },
        spotlight: {
          borderRadius: 12,
          boxShadow: '0 0 0 3px rgba(56, 189, 248, 0.35), 0 0 24px rgba(56, 189, 248, 0.35)',
        },
      }}
    />
  );
}
