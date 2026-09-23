import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import NotificationManagerApp from "@/NotificationManagerApp";

const root = ReactDOM.createRoot(document.getElementById("root"));

const isElectronNotificationManager =
  Boolean(window.electronAPI?.isNotificationManager?.());

// Deep Slate redesign / preview support:
// In the packaged Electron apps the renderer is selected via electronAPI (SAM vs
// MTS) or the URL hash/query. When running SAM in a plain browser preview (e.g.
// Emergent), REACT_APP_DEFAULT_APP=sam forces the SAM renderer so reviewers see
// SAM by default.
//
// SAFETY: this force is gated on NOT running inside Electron. Even if the env var
// were ever present in a packaged build, Electron always exposes window.electronAPI,
// so the flag is ignored there and each Electron app keeps its own selection. The
// flag therefore only affects a plain browser preview and can never change MTS
// production behavior.
const runningInElectron = Boolean(window.electronAPI);
const forcedDefaultApp = String(process.env.REACT_APP_DEFAULT_APP || '').trim().toLowerCase();
const forceNotificationManager =
  !runningInElectron &&
  (forcedDefaultApp === 'sam' || forcedDefaultApp === 'notification-manager');

const isNotificationManager =
  isElectronNotificationManager ||
  forceNotificationManager ||
  Boolean(
    window.location.hash.startsWith("#/notification-manager") ||
    window.location.search.includes("notification-manager=1")
  );

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unknown renderer error.",
    };
  }

  componentDidCatch(error, info) {
    console.error("[APP] Renderer crashed:", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const appName = this.props.appName || "App";
    const reloadLabel = appName === "SAM" ? "Reload SAM" : "Reload MTS";

    return (
      <div className="nm-app">
        <div className="nm-shell">
          <section className="nm-status-card is-warning" style={{ margin: "24px" }}>
            <strong>{appName} encountered an error loading this section.</strong>
            <span>{appName} could not finish loading this section. Reload {appName} to try again.</span>
            <div style={{ marginTop: 16 }}>
              <button type="button" className="nm-btn nm-btn-primary" onClick={this.handleReload}>
                {reloadLabel}
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }
}

root.render(isNotificationManager ? (
  <AppErrorBoundary appName="SAM">
    <NotificationManagerApp />
  </AppErrorBoundary>
) : (
  <AppErrorBoundary appName="MTS">
    <App />
  </AppErrorBoundary>
));
