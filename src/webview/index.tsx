import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WebviewErrorBoundary } from './WebviewErrorBoundary';
import { reportWebviewError } from './webviewBridge';

const container = document.getElementById('root');
if (!container) throw new Error('DBV: webview root element is missing');

window.addEventListener('error', (event) => {
  reportWebviewError('runtime', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportWebviewError('unhandledRejection', event.reason);
});

createRoot(container).render(
  <WebviewErrorBoundary>
    <App />
  </WebviewErrorBoundary>,
);
