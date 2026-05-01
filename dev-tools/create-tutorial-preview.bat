@echo off
setlocal

echo ==========================================
echo Creating Tutorial Preview
echo ==========================================

if not exist package.json (
  echo ERROR: package.json not found.
  echo Put this .bat file in your React app root folder.
  pause
  exit /b 1
)

echo Installing react-joyride...
call npm install react-joyride

if not exist src (
  echo ERROR: src folder not found.
  pause
  exit /b 1
)

echo Creating src\TutorialPreview.jsx...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"@'
import React, { useState } from \"react\";
import Joyride from \"react-joyride\";

export default function TutorialPreview() {
  const [run, setRun] = useState(false);

  const steps = [
    {
      target: '[data-tour=\"candidate-name\"]',
      content: \"Enter the trainee's full name here.\",
      placement: \"bottom\",
      disableBeacon: true,
    },
    {
      target: '[data-tour=\"final-attempt\"]',
      content: \"Select Yes if this is the candidate's final certification attempt.\",
      placement: \"bottom\",
    },
    {
      target: '[data-tour=\"equipment-section\"]',
      content: \"Confirm headset, Chrome, and VPN requirements here.\",
      placement: \"right\",
    },
    {
      target: '[data-tour=\"continue-button\"]',
      content: \"Click Continue when the session is ready to begin.\",
      placement: \"top\",
    },
  ];

  return (
    <div style={{ padding: 30, maxWidth: 900, margin: \"0 auto\", fontFamily: \"Arial, sans-serif\" }}>
      <Joyride
        steps={steps}
        run={run}
        continuous
        showProgress
        showSkipButton
        scrollToFirstStep
        styles={{
          options: {
            zIndex: 10000,
            primaryColor: \"#2563eb\",
            textColor: \"#111827\",
          },
          tooltip: {
            borderRadius: 14,
          },
        }}
      />

      <h1>Mock Testing Suite Tutorial Preview</h1>
      <p>This is a safe preview page so you can see the tutorial before wiring it into the real app.</p>

      <button onClick={() => setRun(true)} style={buttonStyle}>
        Start Tutorial
      </button>

      <div style={{ marginTop: 30, display: \"grid\", gap: 20 }}>
        <div data-tour=\"candidate-name\" style={cardStyle}>
          <label><strong>Candidate Name</strong></label>
          <input placeholder=\"Enter full name\" style={inputStyle} />
        </div>

        <div data-tour=\"final-attempt\" style={cardStyle}>
          <strong style={{ color: \"#b91c1c\" }}>Final Attempt</strong>
          <div style={{ marginTop: 10 }}>
            <label>
              <input type=\"radio\" name=\"finalAttempt\" /> Yes
            </label>
            <label style={{ marginLeft: 15 }}>
              <input type=\"radio\" name=\"finalAttempt\" /> No
            </label>
          </div>
        </div>

        <div data-tour=\"equipment-section\" style={cardStyle}>
          <h2>Technical Requirements</h2>
          <label><input type=\"checkbox\" /> USB Headset</label><br />
          <label><input type=\"checkbox\" /> Noise-Canceling Microphone</label><br />
          <label><input type=\"checkbox\" /> Chrome Browser</label><br />
          <label><input type=\"checkbox\" /> VPN Capability</label>
        </div>

        <button data-tour=\"continue-button\" style={buttonStyle}>
          Continue
        </button>
      </div>
    </div>
  );
}

const cardStyle = {
  background: \"white\",
  padding: 20,
  borderRadius: 14,
  boxShadow: \"0 8px 22px rgba(0,0,0,0.12)\",
};

const inputStyle = {
  display: \"block\",
  marginTop: 8,
  padding: 10,
  width: \"100%\",
  boxSizing: \"border-box\",
};

const buttonStyle = {
  padding: \"12px 18px\",
  borderRadius: 10,
  border: \"none\",
  background: \"#2563eb\",
  color: \"white\",
  fontWeight: \"bold\",
  cursor: \"pointer\",
};
'@ | Set-Content -Encoding UTF8 src\TutorialPreview.jsx"

echo Looking for App file...

if exist src\App.jsx (
  if not exist src\App.jsx.before-tutorial-preview.bak copy src\App.jsx src\App.jsx.before-tutorial-preview.bak
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "'import TutorialPreview from \"./TutorialPreview\";' + [Environment]::NewLine + [Environment]::NewLine + 'export default function App() {' + [Environment]::NewLine + '  return <TutorialPreview />;' + [Environment]::NewLine + '}' | Set-Content -Encoding UTF8 src\App.jsx"
  goto done
)

if exist src\App.js (
  if not exist src\App.js.before-tutorial-preview.bak copy src\App.js src\App.js.before-tutorial-preview.bak
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "'import TutorialPreview from \"./TutorialPreview\";' + [Environment]::NewLine + [Environment]::NewLine + 'export default function App() {' + [Environment]::NewLine + '  return <TutorialPreview />;' + [Environment]::NewLine + '}' | Set-Content -Encoding UTF8 src\App.js"
  goto done
)

echo ERROR: Could not find src\App.js or src\App.jsx.
pause
exit /b 1

:done
echo.
echo Tutorial preview created.
echo Run:
echo npm start
echo.
pause