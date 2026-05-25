import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import NotificationManagerApp from "@/NotificationManagerApp";

const root = ReactDOM.createRoot(document.getElementById("root"));

const isElectronNotificationManager =
  Boolean(window.electronAPI?.isNotificationManager?.());

const isNotificationManager =
  isElectronNotificationManager ||
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

    return (
      <div className="nm-app">
        <div className="nm-shell">
          <section className="nm-status-card is-warning" style={{ margin: "24px" }}>
            <strong>SAM encountered an error loading this section.</strong>
            <span>{this.state.message || "Reload the app to try again."}</span>
            <div style={{ marginTop: 16 }}>
              <button type="button" className="nm-btn nm-btn-primary" onClick={this.handleReload}>
                Reload SAM
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }
}

root.render(isNotificationManager ? (
  <AppErrorBoundary>
    <NotificationManagerApp />
  </AppErrorBoundary>
) : (
  <App />
));
