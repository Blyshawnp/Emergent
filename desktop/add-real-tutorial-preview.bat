@echo off
setlocal

echo ==========================================
echo Adding Real Tutorial Preview System
echo ==========================================

if not exist package.json (
  echo ERROR: package.json not found.
  echo Run this from the desktop folder.
  pause
  exit /b 1
)

if not exist src (
  echo ERROR: src folder not found.
  pause
  exit /b 1
)

echo Installing react-joyride...
call npm install react-joyride

if not exist src\tutorial mkdir src\tutorial

echo Creating tutorial files...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"@'
export const tutorialSteps = [
  {
    target: '[data-tour=\"app-title\"]',
    content: 'This is the main Mock Testing Suite app area. The tutorial will guide testers through the workflow without changing the session data.',
    placement: 'bottom',
    disableBeacon: true,
  },
  {
    target: '[data-tour=\"candidate-name\"]',
    content: 'Enter the trainee or candidate name here. This is used throughout the testing session and review.',
    placement: 'bottom',
  },
  {
    target: '[data-tour=\"final-attempt\"]',
    content: 'Use this area to mark whether this is the candidate’s final attempt.',
    placement: 'bottom',
  },
  {
    target: '[data-tour=\"equipment-section\"]',
    content: 'Confirm the required technical setup here, including headset, Chrome, and VPN readiness.',
    placement: 'right',
  },
  {
    target: '[data-tour=\"continue-button\"]',
    content: 'Use Continue when the basics are complete and the session is ready to begin.',
    placement: 'top',
  },
  {
    target: '[data-tour=\"review-summary\"]',
    content: 'The Review screen summarizes the evaluation before the Microsoft Form is filled.',
    placement: 'bottom',
  },
  {
    target: '[data-tour=\"fill-form-button\"]',
    content: 'This opens the Microsoft Form prefilled for review. It should not auto-submit.',
    placement: 'top',
  },
];
'@ | Set-Content -Encoding UTF8 src\tutorial\tutorialSteps.js"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"@'
import React, { useState } from 'react';
import Joyride, { STATUS, EVENTS } from 'react-joyride';
import { tutorialSteps } from './tutorialSteps';

export default function TutorialPreviewOverlay() {
  const [run, setRun] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const handleCallback = (data) => {
    const { status, type, index } = data;

    if (type === EVENTS.STEP_AFTER || type === EVENTS.TARGET_NOT_FOUND) {
      setStepIndex(index + 1);
    }

    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      setRun(false);
      setStepIndex(0);
    }
  };

  return (
    <>
      <Joyride
        callback={handleCallback}
        continuous
        run={run}
        stepIndex={stepIndex}
        steps={tutorialSteps}
        showProgress
        showSkipButton
        scrollToFirstStep
        disableOverlayClose
        styles={{
          options: {
            zIndex: 10000,
            primaryColor: '#2563eb',
            textColor: '#111827',
            backgroundColor: '#ffffff',
            arrowColor: '#ffffff',
          },
          tooltip: {
            borderRadius: 14,
            padding: 16,
            boxShadow: '0 12px 30px rgba(0,0,0,0.20)',
          },
          buttonNext: {
            borderRadius: 8,
            padding: '8px 14px',
          },
          buttonBack: {
            marginRight: 8,
          },
          buttonSkip: {
            color: '#6b7280',
          },
        }}
        locale={{
          back: 'Back',
          close: 'Close',
          last: 'Finish',
          next: 'Next',
          skip: 'Skip',
        }}
      />

      <button
        type='button'
        onClick={() => {
          setStepIndex(0);
          setRun(true);
        }}
        style={{
          position: 'fixed',
          right: 18,
          bottom: 18,
          zIndex: 9999,
          border: 'none',
          borderRadius: 999,
          padding: '12px 18px',
          background: '#2563eb',
          color: 'white',
          fontWeight: 700,
          boxShadow: '0 10px 25px rgba(0,0,0,0.25)',
          cursor: 'pointer',
        }}
      >
        Preview Tutorial
      </button>
    </>
  );
}
'@ | Set-Content -Encoding UTF8 src\tutorial\TutorialPreviewOverlay.jsx"

echo.
echo Tutorial files created.
echo.
echo NEXT STEP:
echo You still need to import and place TutorialPreviewOverlay in your App file.
echo Run patch-app-with-tutorial-preview.bat next.
pause