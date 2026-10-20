import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if (/Mac/.test(navigator.userAgent)) document.documentElement.classList.add('native-glass');

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
