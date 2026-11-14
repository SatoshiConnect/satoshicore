'use client';

import { useEffect, useState } from 'react';
import { pushThemeForCurrentUser, THEME_KEY } from '../lib/themeSync';

// One switch for the whole site. The palette itself is only tokens, so this
// flips an attribute — no component knows which theme it is in.
//
// The first paint is decided by a tiny inline script in app/layout.js (before
// hydration) so a light-mode visitor never sees a dark flash; this button then
// reads that decision and writes the next one.
function remember(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode / storage blocked: the theme still applies to this page */
  }
  // Off unless the signed-in account opted in; a failure here never blocks the
  // local theme change the click already made.
  void pushThemeForCurrentUser(theme).catch(() => {});
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export default function ThemeToggle() {
  // null until mounted: server and first client render must agree.
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  const next = theme === 'light' ? 'dark' : 'light';
  const label = next === 'light' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        remember(next);
        setTheme(next);
      }}
      aria-label={label}
      title={label}
    >
      {theme === 'light' ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}
