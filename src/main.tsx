// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { LanguageProvider } from './i18n/react.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider><App /></LanguageProvider>
  </StrictMode>,
);
