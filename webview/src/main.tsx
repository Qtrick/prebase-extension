import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPreviewMock } from './preview-mock';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('PreBase webview root element missing');
}

if (import.meta.env.DEV) {
  // Install before React mounts so acquireVsCodeApi is available to the bridge.
  installPreviewMock();
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
