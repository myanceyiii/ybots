import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { trackVisualViewport } from './lib/viewport';
// These two are also imported by the parts that use them. Listed here first so they stay in the page's own
// stylesheet, in the same place in the cascade as before those parts were loaded on demand.
import './styles/config.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/cards.css';
import './styles/details.css';
import './styles/modals.css';
import './styles/viewer.css';
import './styles/voice.css';
import './styles/files.css';
import './styles/extras.css';
import './styles/responsive.css';

trackVisualViewport();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>,
);
