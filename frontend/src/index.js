import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import NotificationManagerApp from "@/NotificationManagerApp";

const root = ReactDOM.createRoot(document.getElementById("root"));

const isElectronNotificationManager =
  Boolean(window.electronAPI?.isNotificationManager?.());

const isNotificationManager =
  isElectronNotificationManager &&
  (
    window.location.hash.startsWith("#/notification-manager") ||
    window.location.search.includes("notification-manager=1")
  );

root.render(isNotificationManager ? <NotificationManagerApp /> : <App />);
