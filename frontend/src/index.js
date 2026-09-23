import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import NotificationManagerApp from "@/NotificationManagerApp";

const root = ReactDOM.createRoot(document.getElementById("root"));

const isElectronNotificationManager =
  Boolean(window.electronAPI?.isNotificationManager?.());

// Deep Slate redesign / preview support:
// In the packaged Electron apps the renderer is selected via electronAPI or the
// URL hash/query. When running SAM in a plain browser preview (e.g. Emergent),
// REACT_APP_DEFAULT_APP=sam forces the SAM renderer so reviewers see SAM by
// default. This flag is opt-in via env only and never affects production builds
// (where it is unset), so MTS remains the default there.
const forcedDefaultApp = String(process.env.REACT_APP_DEFAULT_APP || '').trim().toLowerCase();
const forceNotificationManager =
  forcedDefaultApp === 'sam' || forcedDefaultApp === 'notification-manager';

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
