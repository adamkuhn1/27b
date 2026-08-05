import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// The same self-hosted EB Garamond (OFL) the shell bundles, at the same three
// weights. See apps/portfolio/src/main.tsx.
import "@fontsource/eb-garamond/latin-400.css";
import "@fontsource/eb-garamond/latin-500.css";
import "@fontsource/eb-garamond/latin-600.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
