import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { startOffline } from './offline/registration';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/**
 * After render, never before.
 *
 * Registering the worker first would let it start answering requests while the bundle is
 * still coming down, and the first thing a driver did — load today's route — could then be
 * served by a worker that had not yet cached anything. The queue also has nothing to drain
 * until the app has asked for a day, so there is nothing lost by waiting.
 */
startOffline();
