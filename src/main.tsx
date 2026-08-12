import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// The same self-hosted EB Garamond (OFL) the portfolio shell bundles, at the
// same three weights, so 27B keeps a typographic relationship to the suite.
import "@fontsource/eb-garamond/latin-400.css";
import "@fontsource/eb-garamond/latin-500.css";
import "@fontsource/eb-garamond/latin-600.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The portfolio shell's embed contract: an iframe is only "ready" when it
// says so via postMessage (see apps/portfolio/src/lib/embedProtocol.ts) --
// there's no timer-based fallback, so this handshake is required for the
// inline embed to ever leave its loading state. Double rAF waits for the
// address form's first real paint, not just React's commit. No-op outside
// an iframe.
if (window.parent !== window) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.parent.postMessage({ source: "portfolio-embed", type: "ready", id: "27b" }, "*");
    });
  });
}
