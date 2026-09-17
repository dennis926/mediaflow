import React from 'react';
import ReactDOM from 'react-dom/client';
import { Popup } from './Popup';
import './popup.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
