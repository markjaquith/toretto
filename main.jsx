import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { DemoSite } from "./DemoSite";
import { SourceDialog } from "./SourceDialog";
import { Spatializer } from "./Spatializer";
import "./demo.css";
import "./spatializer.css";

document.documentElement.dataset.theme = "dark";

function ImportedDocument({ markup, label }) {
  return (
    <div className="imported-document" data-toretto-root="" aria-label={label}>
      <div className="imported-document-content" dangerouslySetInnerHTML={{ __html: markup }} />
    </div>
  );
}

function TorettoApp() {
  const [sourceOpen, setSourceOpen] = useState(false);
  const [imported, setImported] = useState(null);
  return (
    <>
      <Spatializer contentKey={imported} sourceOpen={sourceOpen} onOpenSource={() => setSourceOpen(true)}>
        {imported ? <ImportedDocument markup={imported.markup} label={imported.label} /> : <DemoSite />}
      </Spatializer>
      {sourceOpen && <SourceDialog onClose={() => setSourceOpen(false)} onDemo={() => setImported(null)} onLoad={(markup, label) => setImported({ markup, label })} />}
    </>
  );
}

const rootElement = document.getElementById("root");
const appRoot = import.meta.hot?.data.appRoot || ReactDOM.createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.appRoot = appRoot;

appRoot.render(
  <React.StrictMode>
    <TorettoApp />
  </React.StrictMode>,
);
