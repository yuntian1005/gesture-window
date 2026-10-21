import './styles.css';

import { createHandWindowApp } from './app/hand-window-app.js';

createHandWindowApp({
  root: document.documentElement,
  video: document.querySelector('#camera-feed'),
  mount: document.querySelector('#renderer'),
});
