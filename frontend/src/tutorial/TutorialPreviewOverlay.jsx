import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const TARGET_WAIT_TIMEOUT_MS = 5000;
const STEP_TARGET_TIMEOUT_MS = 1800;
const PREPARE_SELECTOR_TIMEOUT_MS = 1500;
const SCROLL_SETTLE_MS = 180;

function isTargetVisible(selector) {
  if (!selector) return false;
  const element = document.querySelector(selector);
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function waitForTarget(selector, timeoutMs = TARGET_WAIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!selector) {
      resolve(false);
      return;
    }

    const startedAt = Date.now();

    const check = () => {
      if (isTargetVisible(selector)) {
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

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function getResolvedTarget(step) {
  if (!step) return null;
  if (isTargetVisible(step.target)) return step.target;
  if (isTargetVisible(step.fallbackTarget)) return step.fallbackTarget;
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTargetRect(selector) {
  const element = selector ? document.querySelector(selector) : null;
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
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
  const preparedStepRef = useRef('');
  const cleanupTimerRef = useRef(null);
  const [targetOverrides, setTargetOverrides] = useState({});
  const [readyStepId, setReadyStepId] = useState('');
  const [targetRect, setTargetRect] = useState(null);

  useEffect(() => () => {
    mountedRef.current = false;
    if (cleanupTimerRef.current) {
      window.clearTimeout(cleanupTimerRef.current);
    }
  }, []);

  const baseSteps = useMemo(() => ([
    {
      id: 'welcome',
      page: 'home',
      target: '[data-tour="home-header"]',
      fallbackTarget: '[data-testid="home-page"]',
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
      placement: 'bottom',
    },
    {
      id: 'home-workflows',
      page: 'home',
      target: '[data-testid="home-start-btn"]',
      fallbackTarget: '[data-testid="home-page"]',
      content: 'Home is where sessions begin. Start New Session runs the full workflow, Supervisor Transfer Only starts directly at transfer scoring, Smart Resume can continue eligible saved work, and History opens completed sessions.',
      placement: 'bottom',
    },
    {
      id: 'home-tools',
      page: 'home',
      target: '[data-testid="sidebar"]',
      fallbackTarget: '[data-testid="home-page"]',
      content: 'The sidebar keeps workflow pages, Discord posts and screenshots, Settings, Help, and Exit App available without changing the current session.',
      placement: 'right',
    },
    {
      id: 'basics-overview',
      page: 'basics',
      target: '[data-testid="basics-candidate"]',
      fallbackTarget: '[data-testid="basics-page"]',
      content: 'Basics collects candidate details and required pre-checks before scoring starts. Use this page to confirm final attempt status, VPN/browser readiness, and the required setup items.',
      placement: 'bottom',
    },
    {
      id: 'basics-headset',
      page: 'basics',
      target: '[data-testid="basics-headset-lookup"]',
      fallbackTarget: '[data-testid="basics-page"]',
      content: 'The headset section is where you record the candidate headset and use Lookup Approved Headsets to confirm the model. Headset failures route through the app’s fail handling.',
      placement: 'right',
    },
    {
      id: 'basics-auto-fails',
      page: 'basics',
      target: '[data-testid="basics-footer"]',
      fallbackTarget: '[data-testid="basics-footer"]',
      content: 'The red action buttons are grouped auto-fail or exception paths. Use NC/NS, Not Ready, Tech Issue, and related danger actions only when that outcome applies; the app records the reason and routes the session forward.',
      placement: 'top',
    },
    {
      id: 'calls-setup',
      page: 'calls',
      target: '[data-tour="calls-setup"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Calls is where you set up the scenario. Choose the call type, show, caller, and donation details, then use the scenario and payment simulation to run the mock call.',
      placement: 'right',
    },
    {
      id: 'calls-scoring',
      page: 'calls',
      target: '[data-tour="calls-result"]',
      fallbackTarget: '[data-testid="calls-page"]',
      content: 'Call scoring is grouped here. Mark each call Pass or Fail, record coaching checkboxes, select fail reasons when needed, and use Stopped Responding only for the chat auto-fail path.',
      placement: 'bottom',
    },
    {
      id: 'supervisor-transfer',
      page: 'suptransfer',
      target: '[data-tour="sup-discord-banner"]',
      fallbackTarget: '[data-testid="suptransfer-page"]',
      content: 'Supervisor Transfer covers the live transfer portion. Copy the Discord message, choose the transfer setup details, watch the time check, and score whether the transfer passes.',
      placement: 'bottom',
    },
    {
      id: 'review-fill',
      page: 'review',
      pageState: {
        historyRecord: {
          candidate_name: 'Example Candidate',
          tester_name: 'Example Tester',
          final_status: 'Pass',
          call_1: { result: 'Pass' },
          call_2: { result: 'Pass' },
          call_3: { result: '' },
          sup_transfer_1: { result: 'Pass' },
          sup_transfer_2: { result: '' },
          coaching_summary: 'Example coaching summary: confirmed required process steps, documented coaching, and reviewed the session outcome.',
          fail_summary: 'N/A',
          supervisor_only: false,
        },
      },
      target: '[data-testid="review-banner"]',
      fallbackTarget: '[data-testid="review-page"]',
      content: 'Review is the final checkpoint. Confirm the pass/fail result, review coaching and fail summaries, use Fill Form to populate the certification form, then Save & Finish when the session is complete.',
      placement: 'bottom',
    },
    {
      id: 'history-page',
      page: 'history',
      target: '[data-testid="history-page"]',
      content: 'History stores completed sessions for later lookup. From a saved record, you can review the summaries again or run historical Fill Form without changing the active session.',
      placement: 'center',
    },
    {
      id: 'settings-page',
      page: 'settings',
      target: '[data-tour="settings-tabs"]',
      fallbackTarget: '[data-testid="settings-page"]',
      content: 'Settings manages app behavior and integrations: tester identity, form links, sounds, theme, Gemini summaries, Discord posts and screenshots, updates, and ticker speed.',
      placement: 'bottom',
    },
    {
      id: 'help-page',
      page: 'help',
      target: '[data-tour="help-header"]',
      fallbackTarget: '[data-testid="help-page"]',
      content: 'Help is the reference center for workflow guidance, troubleshooting, FAQ content, setup notes, update/about details, and replaying this tutorial later.',
      placement: 'bottom',
    },
  ].map((step) => ({
    disableBeacon: true,
    ...step,
  }))), []);

  const steps = useMemo(() => baseSteps.map((step) => ({
    ...step,
    target: targetOverrides[step.id] || step.target,
  })), [baseSteps, targetOverrides]);

  const refreshTargetRect = useCallback((selector) => {
    const rect = getTargetRect(selector);
    setTargetRect(rect);
    return rect;
  }, []);

  const forceCleanup = useCallback(() => {
    transitionRef.current = false;
    preparedStepRef.current = '';
    setReadyStepId('');
    setTargetRect(null);
    setTargetOverrides({});
    setRun(false);
  }, [setRun]);

  const scheduleTransitionFailsafe = useCallback(() => {
    if (cleanupTimerRef.current) {
      window.clearTimeout(cleanupTimerRef.current);
    }
    cleanupTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current || !transitionRef.current) return;
      forceCleanup();
      onStop?.('failed');
    }, TARGET_WAIT_TIMEOUT_MS);
  }, [forceCleanup, onStop]);

  const clearTransitionFailsafe = useCallback(() => {
    if (cleanupTimerRef.current) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
  }, []);

  const prepareStep = useCallback(async (step, index = stepIndex) => {
    if (!step || transitionRef.current) return false;

    transitionRef.current = true;
    scheduleTransitionFailsafe();
    setReadyStepId('');

    if (step.page !== currentPage) {
      navigate(step.page, step.pageState || null);
    } else if (step.pageState) {
      navigate(step.page, step.pageState);
    }

    if (step.prepareSelector) {
      await waitForTarget(step.prepareSelector, PREPARE_SELECTOR_TIMEOUT_MS);
      document.querySelector(step.prepareSelector)?.click();
    }

    const hasPrimaryTarget = await waitForTarget(step.target, STEP_TARGET_TIMEOUT_MS);
    if (!hasPrimaryTarget && step.fallbackTarget) {
      await waitForTarget(step.fallbackTarget, STEP_TARGET_TIMEOUT_MS);
    }

    if (!mountedRef.current) return false;

    const resolvedTarget = getResolvedTarget(step);
    if (!resolvedTarget) {
      transitionRef.current = false;
      clearTransitionFailsafe();
      preparedStepRef.current = '';

      const nextIndex = index + 1;
      if (nextIndex >= baseSteps.length) {
        forceCleanup();
        onStop?.('failed');
        return false;
      }

      setStepIndex(nextIndex);
      window.setTimeout(() => {
        prepareStep(baseSteps[nextIndex], nextIndex);
      }, 0);
      return false;
    }

    setTargetOverrides((current) => (
      current[step.id] === resolvedTarget ? current : { ...current, [step.id]: resolvedTarget }
    ));
    document.querySelector(resolvedTarget)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await delay(SCROLL_SETTLE_MS);
    if (!mountedRef.current) return false;
    refreshTargetRect(resolvedTarget);
    preparedStepRef.current = step.id;
    setReadyStepId(step.id);
    transitionRef.current = false;
    clearTransitionFailsafe();
    setRun(true);
    return true;
  }, [baseSteps, clearTransitionFailsafe, currentPage, forceCleanup, navigate, onStop, refreshTargetRect, scheduleTransitionFailsafe, setRun, setStepIndex, stepIndex]);

  useEffect(() => {
    if (!run || transitionRef.current) return;
    const step = baseSteps[stepIndex];
    if (!step) return;
    if (preparedStepRef.current === step.id) return;
    prepareStep(step, stepIndex);
  }, [baseSteps, prepareStep, run, stepIndex]);

  const goToStep = useCallback((nextIndex) => {
    preparedStepRef.current = '';
    setReadyStepId('');
    setTargetRect(null);

    if (nextIndex < 0) {
      nextIndex = 0;
    }

    if (nextIndex >= baseSteps.length) {
      forceCleanup();
      onStop?.('completed');
      return;
    }

    const nextStep = baseSteps[nextIndex];
    setStepIndex(nextIndex);
    prepareStep(nextStep, nextIndex);
  }, [baseSteps, forceCleanup, onStop, prepareStep, setStepIndex]);

  const handleBack = useCallback(() => {
    goToStep(stepIndex - 1);
  }, [goToStep, stepIndex]);

  const handleNext = useCallback(() => {
    goToStep(stepIndex + 1);
  }, [goToStep, stepIndex]);

  const handleSkip = useCallback(() => {
    forceCleanup();
    onStop?.('skipped');
  }, [forceCleanup, onStop]);

  useEffect(() => {
    const currentStep = baseSteps[stepIndex];
    if (!run || !currentStep || readyStepId !== currentStep.id) return undefined;

    const selector = targetOverrides[currentStep.id] || currentStep.target;
    const updateRect = () => {
      const rect = refreshTargetRect(selector);
      if (!rect) {
        goToStep(stepIndex + 1);
      }
    };

    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [baseSteps, goToStep, readyStepId, refreshTargetRect, run, stepIndex, targetOverrides]);

  const currentStep = baseSteps[stepIndex];
  const renderedStep = steps[stepIndex];
  if (!run || !currentStep || readyStepId !== currentStep.id || !targetRect) {
    return null;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
  const tooltipWidth = Math.min(380, Math.max(300, viewportWidth - 32));
  const tooltipHeightEstimate = 260;
  const tooltipGap = 14;
  const placement = renderedStep.placement || 'bottom';
  const targetCenterX = targetRect.left + (targetRect.width / 2);
  const targetCenterY = targetRect.top + (targetRect.height / 2);
  const preferredTopByPlacement = {
    top: targetRect.top - tooltipGap - tooltipHeightEstimate,
    bottom: targetRect.bottom + tooltipGap,
    left: targetCenterY - (tooltipHeightEstimate / 2),
    right: targetCenterY - (tooltipHeightEstimate / 2),
    center: (viewportHeight - tooltipHeightEstimate) / 2,
  };
  const preferredLeftByPlacement = {
    top: targetCenterX - (tooltipWidth / 2),
    bottom: targetCenterX - (tooltipWidth / 2),
    left: targetRect.left - tooltipGap - tooltipWidth,
    right: targetRect.right + tooltipGap,
    center: (viewportWidth - tooltipWidth) / 2,
  };
  const tooltipTop = clamp(preferredTopByPlacement[placement] ?? preferredTopByPlacement.bottom, 16, Math.max(16, viewportHeight - tooltipHeightEstimate - 16));
  const tooltipLeft = clamp(preferredLeftByPlacement[placement] ?? preferredLeftByPlacement.bottom, 16, Math.max(16, viewportWidth - tooltipWidth - 16));
  const isLastStep = stepIndex >= baseSteps.length - 1;

  return (
    <div className="tutorial-overlay-root" data-testid="tutorial-overlay">
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9998,
          background: 'rgba(0, 0, 0, 0.48)',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          zIndex: 9999,
          top: Math.max(8, targetRect.top - 8),
          left: Math.max(8, targetRect.left - 8),
          width: targetRect.width + 16,
          height: targetRect.height + 16,
          borderRadius: 12,
          border: '2px solid rgba(56, 189, 248, 0.9)',
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.28), 0 0 24px rgba(56, 189, 248, 0.5)',
          pointerEvents: 'none',
        }}
      />
      <section
        role="dialog"
        aria-modal="false"
        aria-label="App tutorial"
        style={{
          position: 'fixed',
          zIndex: 10000,
          top: tooltipTop,
          left: tooltipLeft,
          width: tooltipWidth,
          maxWidth: 'calc(100vw - 32px)',
          color: '#f8fafc',
          background: '#0b1220',
          border: '1px solid rgba(56, 189, 248, 0.35)',
          borderRadius: 16,
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(56, 189, 248, 0.18)',
          padding: 18,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, color: '#7dd3fc', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0 }}>
          Tutorial {stepIndex + 1} of {baseSteps.length}
        </div>
        <div style={{ color: '#e2e8f0', fontSize: 14, lineHeight: 1.6 }}>
          {renderedStep.content}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 18 }}>
          <button type="button" onClick={handleSkip} className="btn btn-muted btn-sm">
            Skip
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={handleBack} className="btn btn-muted btn-sm" disabled={stepIndex === 0}>
              Back
            </button>
            <button type="button" onClick={handleNext} className="btn btn-primary btn-sm">
              {isLastStep ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
