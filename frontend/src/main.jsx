import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Reset browser defaults
const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; width: 100%; overflow: hidden; }
  body { background: #0f1117; }
  ::-webkit-scrollbar { width: 4px; height: 4px; background: #0f1117; }
  ::-webkit-scrollbar-thumb { background: #2a2d3a; border-radius: 2px; }
  select, input, button { font-family: inherit; }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);