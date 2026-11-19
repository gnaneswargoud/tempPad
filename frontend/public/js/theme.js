// ============================================================
// TempPad — Theme toggle (light/dark mode)
// ============================================================
// Two sources of truth for the theme:
//   1. prefers-color-scheme media query (OS/browser preference)
//   2. localStorage key "temppad-theme" (manual override)
//
// The manual override wins if set. The toggle button switches
// between light and dark and saves the choice to localStorage.
//
// localStorage is used ONLY for the theme preference —
// file content and state are never stored locally.
// ============================================================

'use strict';

(function () {
    var STORAGE_KEY = 'temppad-theme';

    /**
     * Determine the active theme and apply it to the <html> element.
     * Called once on page load and again when the toggle is clicked.
     */
    function applyTheme() {
        var saved = localStorage.getItem(STORAGE_KEY);
        var theme;

        if (saved === 'dark' || saved === 'light') {
            // User has manually chosen a theme
            theme = saved;
        } else {
            // No manual choice — follow the OS preference
            theme = window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';
        }

        document.documentElement.setAttribute('data-theme', theme);
        updateToggleButton(theme);
    }

    /**
     * Update the toggle button's icon and aria-label.
     */
    function updateToggleButton(theme) {
        var btn = document.getElementById('themeToggle');
        if (!btn) return;

        if (theme === 'dark') {
            btn.textContent = '☀️';
            btn.setAttribute('aria-label', 'Switch to light mode');
            btn.setAttribute('title', 'Switch to light mode');
        } else {
            btn.textContent = '🌙';
            btn.setAttribute('aria-label', 'Switch to dark mode');
            btn.setAttribute('title', 'Switch to dark mode');
        }
    }

    /**
     * Toggle the theme and save the choice.
     */
    function toggleTheme() {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'dark' ? 'light' : 'dark';

        localStorage.setItem(STORAGE_KEY, next);
        document.documentElement.setAttribute('data-theme', next);
        updateToggleButton(next);
    }

    // Apply the theme immediately (before the page paints).
    applyTheme();

    // Attach the toggle handler after the DOM is ready.
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.getElementById('themeToggle');
        if (btn) {
            btn.addEventListener('click', toggleTheme);
        }
    });

    // Listen for OS theme changes (when no manual override is set).
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (!localStorage.getItem(STORAGE_KEY)) {
            applyTheme();
        }
    });
})();
