import { Viewer, Worker } from '@react-pdf-viewer/core';
import { defaultLayoutPlugin } from '@react-pdf-viewer/default-layout';

// Core styles
import '@react-pdf-viewer/core/lib/styles/index.css';
// Default layout plugin styles (toolbar, sidebar, etc.)
import '@react-pdf-viewer/default-layout/lib/styles/index.css';

import './PdfViewer.css';

interface PdfViewerProps {
  pdfUrl?: string;
}

/**
 * PdfViewer — reusable in-app PDF reader component.
 *
 * Props:
 *   pdfUrl  {string}  — URL (or base64 data URI) of the PDF to display.
 *
 * Features provided by the defaultLayoutPlugin:
 *   • Zoom in / out / fit-page / fit-width
 *   • Page navigation (prev / next / jump-to-page)
 *   • Full-text search
 *   • Thumbnails sidebar
 *   • Bookmarks sidebar
 *   • Full-screen mode
 *   • Download
 *   • Print
 */
const PdfViewer = ({ pdfUrl }: PdfViewerProps) => {
  // Create the default layout plugin instance.
  // All toolbar buttons (zoom, search, navigation, download, print,
  // full-screen) and the sidebar (thumbnails, bookmarks) are enabled by default.
  const defaultLayoutPluginInstance = defaultLayoutPlugin();

  if (!pdfUrl) {
    return (
      <div className="pdf-viewer-empty">
        <span className="pdf-viewer-empty-icon">📄</span>
        <p>Aucun document PDF sélectionné.</p>
      </div>
    );
  }

  return (
    <div className="pdf-viewer-wrapper">
      {/*
        Worker must match the installed pdfjs-dist version.
        We point to the bundled worker from node_modules via the CDN path
        provided by pdfjs-dist itself so Vite can resolve it correctly.
      */}
      <Worker workerUrl="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js">
        <Viewer
          fileUrl={pdfUrl}
          plugins={[defaultLayoutPluginInstance]}
          defaultScale={1}
        />
      </Worker>
    </div>
  );
};

export default PdfViewer;
