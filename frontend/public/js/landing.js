// ============================================================
// TempPad — Landing page JavaScript
// ============================================================
// Handles the filename input, live validation, and navigation
// to the editor page.
// ============================================================

'use strict';

(function () {
    // --- Slug validation (duplicated from backend/src/utils/slug.js) ---
    // This MUST match the backend rules exactly. The backend is the
    // source of truth; this is a convenience for instant feedback.
    var SLUG_REGEX = /^[a-z0-9_-]{1,64}$/;
    var RESERVED_NAMES = [
        'admin', 'api', 'assets', 'favicon.ico', 'health',
        'index', 'new', 'robots.txt', 'static'
    ];

    function validateSlug(raw) {
        if (typeof raw !== 'string' || raw.length === 0) {
            return { valid: false, error: 'Filename cannot be empty.' };
        }

        var slug = raw.toLowerCase();

        if (slug.length > 64) {
            return { valid: false, error: 'Filename must be 1–64 characters long.' };
        }

        if (!SLUG_REGEX.test(slug)) {
            return {
                valid: false,
                error: 'Only letters, numbers, hyphens, and underscores are allowed.'
            };
        }

        if (RESERVED_NAMES.indexOf(slug) !== -1) {
            return { valid: false, error: '"' + slug + '" is a reserved name. Please choose another.' };
        }

        return { valid: true, slug: slug };
    }

    // --- DOM Elements ---
    var form = document.getElementById('createForm');
    var input = document.getElementById('filenameInput');
    var btn = document.getElementById('createBtn');
    var msg = document.getElementById('validationMsg');

    // --- Live validation ---
    input.addEventListener('input', function () {
        var value = input.value.trim();

        if (value.length === 0) {
            msg.textContent = '';
            msg.className = 'validation-msg';
            input.classList.remove('invalid');
            btn.disabled = true;
            return;
        }

        var result = validateSlug(value);

        if (result.valid) {
            msg.textContent = '✓ "' + result.slug + '" is available to create.';
            msg.className = 'validation-msg success';
            input.classList.remove('invalid');
            btn.disabled = false;
        } else {
            msg.textContent = result.error;
            msg.className = 'validation-msg error';
            input.classList.add('invalid');
            btn.disabled = true;
        }
    });

    // --- Form submission ---
    form.addEventListener('submit', function (e) {
        e.preventDefault();

        var value = input.value.trim();
        var result = validateSlug(value);

        if (!result.valid) {
            msg.textContent = result.error;
            msg.className = 'validation-msg error';
            return;
        }

        // Navigate to the editor page. The editor will call POST /api/files/:slug
        // to create the file (or open it if it already exists).
        window.location.href = '/' + encodeURIComponent(result.slug);
    });
})();
