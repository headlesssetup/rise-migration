import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// The review page is the second half of the Creator flow — same look.
import '../creator/style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
