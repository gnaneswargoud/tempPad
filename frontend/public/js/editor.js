// ============================================================
// TempPad — Editor page JavaScript
// ============================================================
// Handles: loading files, autosave with debounce, manual save,
// conflict resolution, polling for other users' edits,
// expiry countdown, copy/download/clear, keyboard shortcuts,
// and all error states.
//
// Key design decisions explained:
//   - The editor calls POST /api/files/:slug on load to create
//     or open the file. The HTML shell (GET /:slug) does NOT
//     touch the database — this prevents crawlers from creating
//     junk rows.
//   - Autosave debounces at 1.5s after the last keystroke,
//     with only one save in flight at a time.
//   - Polling checks every 7 seconds using ?since_revision=N
//     to minimize server load. Paused when hidden or unsaved.
//   - Expiry countdown uses server_time to compute a clock
//     offset, so a wrong device clock doesn't matter.
// ============================================================

'use strict';

(function () {

    // ============================================================
    // SLUG VALIDATION (must match backend exactly)
    // Source of truth: backend/src/utils/slug.js
    // ============================================================
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
            return { valid: false, error: 'Only letters, numbers, hyphens, and underscores are allowed.' };
        }
        if (RESERVED_NAMES.indexOf(slug) !== -1) {
            return { valid: false, error: '"' + slug + '" is reserved.' };
        }
        return { valid: true, slug: slug };
    }

    // ============================================================
    // STATE
    // ============================================================
    var slug = '';                // Current file slug (from URL)
    var currentRevision = 0;     // Last known revision from the server
    var expiresAt = null;        // When the file expires (Date object, server time)
    var clockOffset = 0;         // server_time - Date.now() (ms)
    var isSaving = false;        // Is a save request in flight?
    var pendingSave = false;     // Should we save again after the current save?
    var hasUnsavedChanges = false;
    var lastSavedContent = '';   // Content as of the last successful save
    var isExpired = false;       // Has the file expired?
    var debounceTimer = null;
    var pollTimer = null;
    var countdownTimer = null;
    var retryCount = 0;          // For exponential backoff on save failure
    var maxRetries = 5;

    // ============================================================
    // DOM ELEMENTS
    // ============================================================
    var filenameDisplay = document.getElementById('filenameDisplay');
    var textarea = document.getElementById('editorTextarea');
    var saveStatusEl = document.getElementById('saveStatus');
    var charCountEl = document.getElementById('charCount');
    var wordCountEl = document.getElementById('wordCount');
    var lineCountEl = document.getElementById('lineCount');
    var lastSavedEl = document.getElementById('lastSaved');
    var expiryEl = document.getElementById('expiryCountdown');
    var unsavedEl = document.getElementById('unsavedIndicator');
    var saveBtn = document.getElementById('saveBtn');
    var clearBtn = document.getElementById('clearBtn');
    var copyTextBtn = document.getElementById('copyTextBtn');
    var downloadBtn = document.getElementById('downloadBtn');
    var copyLinkBtn = document.getElementById('copyLinkBtn');
    var newFileBtn = document.getElementById('newFileBtn');

    // Modals
    var newFileModal = document.getElementById('newFileModal');
    var newFileInput = document.getElementById('newFileInput');
    var newFileValidation = document.getElementById('newFileValidation');
    var newFileCreateBtn = document.getElementById('newFileCreateBtn');
    var newFileCancelBtn = document.getElementById('newFileCancelBtn');
    var conflictModal = document.getElementById('conflictModal');
    var conflictLoadBtn = document.getElementById('conflictLoadBtn');
    var conflictOverwriteBtn = document.getElementById('conflictOverwriteBtn');
    var conflictCopyBtn = document.getElementById('conflictCopyBtn');
    var expiredOverlay = document.getElementById('expiredOverlay');
    var expiredRecreateBtn = document.getElementById('expiredRecreateBtn');
    var errorOverlay = document.getElementById('errorOverlay');
    var errorTitle = document.getElementById('errorTitle');
    var errorMessage = document.getElementById('errorMessage');
    var errorIcon = document.getElementById('errorIcon');
    var errorRetryBtn = document.getElementById('errorRetryBtn');

    // ============================================================
    // INITIALIZATION
    // ============================================================

    // Extract slug from the URL path (e.g., "/hello" -> "hello")
    var pathSlug = window.location.pathname.slice(1);
    var slugResult = validateSlug(pathSlug);

    if (!slugResult.valid) {
        showError('Invalid Filename', slugResult.error, '🚫');
    } else {
        slug = slugResult.slug;
        filenameDisplay.textContent = slug;
        document.title = slug + ' — TempPad';
        openOrCreateFile();
    }

    // ============================================================
    // API CALLS
    // ============================================================

    /**
     * Open or create the file by calling POST /api/files/:slug.
     * This is the first API call when the editor loads.
     */
    function openOrCreateFile() {
        setSaveStatus('Loading...', 'saving');
        textarea.disabled = true;

        fetch('/api/files/' + encodeURIComponent(slug), { method: 'POST' })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (result) {
                var status = result.status;
                var data = result.data;

                updateClockOffset(data.server_time);

                if (status === 201 || status === 200) {
                    // File opened/created successfully
                    loadFileData(data);
                    textarea.disabled = false;
                    textarea.focus();
                    setSaveStatus('Ready', '');
                    startPolling();
                    startCountdown();
                } else if (status === 410) {
                    // Expired
                    showExpired();
                } else if (status === 400) {
                    showError('Invalid Filename', data.message, '🚫');
                } else if (status === 429) {
                    showError('Rate Limited', 'Too many requests. Please wait a moment and try again.', '⏳');
                } else if (status === 503) {
                    showError('Service Unavailable', 'The database is not reachable. Please try again later.', '🔌');
                } else {
                    showError('Error', data.message || 'Could not open this file.', '❌');
                }
            })
            .catch(function (err) {
                showError('Network Error', 'Could not reach the server. Check your internet connection.', '📡');
            });
    }

    /**
     * Load file data into the editor state and UI.
     */
    function loadFileData(data) {
        currentRevision = data.revision;
        lastSavedContent = data.content;
        expiresAt = new Date(data.expires_at);

        // Set textarea content using .value (never innerHTML — XSS prevention)
        textarea.value = data.content;
        updateCounts();
        updateLastSaved(data.updated_at);
        setUnsaved(false);
    }

    /**
     * Save content to the server via PUT /api/files/:slug.
     * Uses optimistic concurrency control with base_revision.
     */
    function saveContent() {
        if (isSaving) {
            // Another save is in flight — queue this one.
            pendingSave = true;
            return;
        }

        if (isExpired) return;

        var content = textarea.value;
        isSaving = true;
        setSaveStatus('Saving...', 'saving');

        fetch('/api/files/' + encodeURIComponent(slug), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: content,
                base_revision: currentRevision,
            }),
        })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (result) {
                var status = result.status;
                var data = result.data;

                isSaving = false;
                updateClockOffset(data.server_time);

                if (status === 200) {
                    // Save succeeded
                    currentRevision = data.revision;
                    lastSavedContent = data.content;
                    expiresAt = new Date(data.expires_at);
                    updateLastSaved(data.updated_at);
                    setSaveStatus('Saved ✓', 'saved');
                    setUnsaved(false);
                    retryCount = 0;

                    // If the user typed while we were saving, save again.
                    if (pendingSave) {
                        pendingSave = false;
                        saveContent();
                    }
                } else if (status === 409) {
                    // Conflict! Someone else saved first.
                    showConflict(data, content);
                } else if (status === 410) {
                    showExpired();
                } else if (status === 413) {
                    setSaveStatus('Error: content too large', 'error');
                } else if (status === 429) {
                    setSaveStatus('Rate limited — retrying...', 'error');
                    retryWithBackoff();
                } else {
                    setSaveStatus('Error saving', 'error');
                    retryWithBackoff();
                }
            })
            .catch(function (err) {
                isSaving = false;
                setSaveStatus('Network error — retrying...', 'error');
                retryWithBackoff();
            });
    }

    /**
     * Retry save with exponential backoff.
     * Caps at maxRetries, then waits for manual retry.
     */
    function retryWithBackoff() {
        if (retryCount >= maxRetries) {
            setSaveStatus('Save failed. Click Retry.', 'error');
            return;
        }

        retryCount++;
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        var delay = Math.pow(2, retryCount) * 1000;

        setTimeout(function () {
            if (hasUnsavedChanges && !isExpired) {
                pendingSave = false;
                saveContent();
            }
        }, delay);
    }

    /**
     * Poll for changes from other users.
     * Uses GET /api/files/:slug?since_revision=N for lightweight checks.
     * Only polls when the tab is visible and there are no unsaved changes.
     */
    function startPolling() {
        stopPolling();

        pollTimer = setInterval(function () {
            // Don't poll if the tab is hidden, we have unsaved changes,
            // a save is in flight, or the file is expired.
            if (document.hidden || hasUnsavedChanges || isSaving || isExpired) {
                return;
            }

            fetch('/api/files/' + encodeURIComponent(slug) + '?since_revision=' + currentRevision)
                .then(function (res) {
                    return res.json().then(function (data) {
                        return { status: res.status, data: data };
                    });
                })
                .then(function (result) {
                    var status = result.status;
                    var data = result.data;

                    updateClockOffset(data.server_time);

                    if (status === 200 && data.changed) {
                        // Someone else saved — update the editor
                        loadFileData(data);
                    } else if (status === 410) {
                        showExpired();
                    }
                    // 404, errors, or changed:false → do nothing
                })
                .catch(function () {
                    // Network error during polling — ignore silently
                });
        }, 7000); // Poll every 7 seconds
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // ============================================================
    // CLOCK OFFSET & EXPIRY COUNTDOWN
    // ============================================================

    /**
     * Compute the offset between the server clock and the local clock.
     * clockOffset = serverTime - localTime
     *
     * This is re-computed on every API response so a wrong device
     * clock doesn't affect the countdown accuracy.
     */
    function updateClockOffset(serverTimeStr) {
        if (!serverTimeStr) return;
        var serverMs = new Date(serverTimeStr).getTime();
        clockOffset = serverMs - Date.now();
    }

    /**
     * Get the "server now" using the local clock + offset.
     * This is only used for the countdown display.
     * The server independently enforces expiry in every query.
     */
    function serverNow() {
        return Date.now() + clockOffset;
    }

    /**
     * Start the expiry countdown timer (updates every second).
     */
    function startCountdown() {
        stopCountdown();

        countdownTimer = setInterval(function () {
            if (!expiresAt || isExpired) {
                expiryEl.textContent = 'Expires in: —';
                return;
            }

            var remaining = expiresAt.getTime() - serverNow();

            if (remaining <= 0) {
                // The countdown hit zero!
                // Immediately disable editing, hide content, and verify with the server.
                handleClientSideExpiry();
                return;
            }

            expiryEl.textContent = 'Expires in: ' + formatDuration(remaining);
        }, 1000);
    }

    function stopCountdown() {
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }

    /**
     * Format milliseconds into "Xh Ym Zs".
     */
    function formatDuration(ms) {
        var totalSeconds = Math.floor(ms / 1000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;

        if (hours > 0) {
            return hours + 'h ' + pad(minutes) + 'm ' + pad(seconds) + 's';
        }
        if (minutes > 0) {
            return minutes + 'm ' + pad(seconds) + 's';
        }
        return seconds + 's';
    }

    function pad(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    /**
     * When the client-side countdown reaches zero:
     * 1. Disable the textarea
     * 2. Clear the content from the screen
     * 3. Show the expired overlay
     * 4. Confirm with the server (which will return 410)
     *
     * Note: The browser timer is only a display. The server
     * independently refuses access to expired files in every query.
     */
    function handleClientSideExpiry() {
        isExpired = true;
        textarea.disabled = true;
        textarea.value = '';
        stopPolling();
        stopCountdown();
        showExpired();

        // Confirm with the server
        fetch('/api/files/' + encodeURIComponent(slug))
            .catch(function () { /* ignore */ });
    }

    // ============================================================
    // AUTOSAVE
    // ============================================================

    /**
     * Called on every keystroke in the textarea.
     * Debounces: waits 1.5 seconds after the last keystroke,
     * then triggers a save.
     */
    textarea.addEventListener('input', function () {
        updateCounts();

        // Mark as unsaved if content differs from last save
        if (textarea.value !== lastSavedContent) {
            setUnsaved(true);
            setSaveStatus('Typing...', 'typing');
        } else {
            setUnsaved(false);
            setSaveStatus('Saved ✓', 'saved');
        }

        // Debounce: restart the timer on every keystroke
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
            if (hasUnsavedChanges && !isExpired) {
                saveContent();
            }
        }, 1500); // 1.5 second debounce
    });

    // ============================================================
    // UI HELPERS
    // ============================================================

    function setSaveStatus(text, className) {
        saveStatusEl.textContent = text;
        saveStatusEl.className = 'statusbar-item save-status';
        if (className) {
            saveStatusEl.classList.add(className);
        }
    }

    function setUnsaved(unsaved) {
        hasUnsavedChanges = unsaved;
        unsavedEl.style.display = unsaved ? 'inline-flex' : 'none';
    }

    function updateCounts() {
        var text = textarea.value;
        var chars = text.length;
        var words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
        var lines = text.split('\n').length;

        charCountEl.textContent = chars.toLocaleString() + ' chars';
        wordCountEl.textContent = words.toLocaleString() + ' words';
        lineCountEl.textContent = lines.toLocaleString() + (lines === 1 ? ' line' : ' lines');
    }

    function updateLastSaved(isoString) {
        if (!isoString) return;
        var d = new Date(isoString);
        lastSavedEl.textContent = 'Saved: ' + d.toLocaleTimeString();
    }

    // ============================================================
    // ERROR STATES
    // ============================================================

    function showError(title, message, icon) {
        errorTitle.textContent = title;
        errorMessage.textContent = message;
        errorIcon.textContent = icon || '❌';
        errorOverlay.classList.add('active');
        textarea.disabled = true;
        stopPolling();
    }

    function hideError() {
        errorOverlay.classList.remove('active');
    }

    function showExpired() {
        isExpired = true;
        textarea.disabled = true;
        textarea.value = '';
        expiredOverlay.classList.add('active');
        expiryEl.textContent = 'Expired';
        stopPolling();
        stopCountdown();
    }

    // ============================================================
    // CONFLICT RESOLUTION
    // ============================================================

    var conflictServerData = null;
    var conflictLocalText = '';

    function showConflict(serverData, localText) {
        conflictServerData = serverData;
        conflictLocalText = localText;
        conflictModal.classList.add('active');
        isSaving = false;
    }

    // Option 1: Load the latest version (discard local changes)
    conflictLoadBtn.addEventListener('click', function () {
        loadFileData(conflictServerData);
        conflictModal.classList.remove('active');
        setSaveStatus('Loaded latest version', 'saved');
    });

    // Option 2: Keep my version and overwrite the server's
    conflictOverwriteBtn.addEventListener('click', function () {
        // Update our revision to the server's latest, then save our text
        currentRevision = conflictServerData.revision;
        expiresAt = new Date(conflictServerData.expires_at);
        textarea.value = conflictLocalText;
        conflictModal.classList.remove('active');
        saveContent();
    });

    // Option 3: Copy my text to clipboard, then load latest
    conflictCopyBtn.addEventListener('click', function () {
        copyToClipboard(conflictLocalText).then(function () {
            loadFileData(conflictServerData);
            conflictModal.classList.remove('active');
            setSaveStatus('Your text copied. Loaded latest.', 'saved');
        });
    });

    // ============================================================
    // BUTTON HANDLERS
    // ============================================================

    // --- Manual Save ---
    saveBtn.addEventListener('click', function () {
        if (!isExpired && hasUnsavedChanges) {
            clearTimeout(debounceTimer);
            retryCount = 0;
            saveContent();
        }
    });

    // --- Clear (with confirmation) ---
    clearBtn.addEventListener('click', function () {
        if (isExpired) return;

        var confirmed = window.confirm(
            'Clear all content? This will save an empty file.'
        );
        if (confirmed) {
            textarea.value = '';
            updateCounts();
            setUnsaved(true);
            clearTimeout(debounceTimer);
            retryCount = 0;
            saveContent();
        }
    });

    // --- Copy text to clipboard ---
    copyTextBtn.addEventListener('click', function () {
        copyToClipboard(textarea.value).then(function () {
            var original = copyTextBtn.textContent;
            copyTextBtn.textContent = '📋 Copied ✓';
            setTimeout(function () {
                copyTextBtn.innerHTML = '📋 Copy';
            }, 2000);
        });
    });

    // --- Copy link ---
    copyLinkBtn.addEventListener('click', function () {
        var url = window.location.origin + '/' + encodeURIComponent(slug);
        copyToClipboard(url).then(function () {
            var original = copyLinkBtn.textContent;
            copyLinkBtn.textContent = '🔗 Copied ✓';
            setTimeout(function () {
                copyLinkBtn.innerHTML = '🔗 <span class="btn-label">Copy Link</span>';
            }, 2000);
        });
    });

    // --- Download as .txt ---
    downloadBtn.addEventListener('click', function () {
        var text = textarea.value;
        var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');
        a.href = url;
        a.download = slug + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // --- Error retry ---
    errorRetryBtn.addEventListener('click', function () {
        hideError();
        openOrCreateFile();
    });

    // --- Expired: recreate file ---
    expiredRecreateBtn.addEventListener('click', function () {
        // The server's POST endpoint will see the expired row and return 410.
        // We need to tell the server to delete the expired row and create a new one.
        // We call POST, and if it returns 410, we try creating fresh.
        fetch('/api/files/' + encodeURIComponent(slug), { method: 'POST' })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (result) {
                if (result.status === 410) {
                    // Expected: the expired row still exists. The cleanup hasn't
                    // run yet. We need to wait for cleanup or reload.
                    // For simplicity, reload the page — the POST endpoint handles
                    // the race: if cleanup runs between now and reload, the new
                    // POST will create fresh. If not, it'll return 410 again and
                    // the user can try once more.
                    // A better UX: we retry after a short delay.
                    setTimeout(function () {
                        window.location.reload();
                    }, 2000);
                } else if (result.status === 201 || result.status === 200) {
                    // Cleanup already ran, and POST created/opened the file.
                    isExpired = false;
                    expiredOverlay.classList.remove('active');
                    textarea.disabled = false;
                    updateClockOffset(result.data.server_time);
                    loadFileData(result.data);
                    startPolling();
                    startCountdown();
                    textarea.focus();
                    setSaveStatus('Ready', '');
                }
            })
            .catch(function () {
                showError('Network Error', 'Could not reach the server.', '📡');
            });
    });

    // ============================================================
    // NEW FILE MODAL
    // ============================================================

    newFileBtn.addEventListener('click', openNewFileModal);

    function openNewFileModal() {
        newFileInput.value = '';
        newFileValidation.textContent = '';
        newFileValidation.className = 'modal-validation';
        newFileCreateBtn.disabled = true;
        newFileModal.classList.add('active');
        newFileInput.focus();
    }

    function closeNewFileModal() {
        newFileModal.classList.remove('active');
    }

    newFileCancelBtn.addEventListener('click', closeNewFileModal);

    // Close modal on Escape
    newFileModal.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeNewFileModal();
    });

    // Close modal on overlay click
    newFileModal.addEventListener('click', function (e) {
        if (e.target === newFileModal) closeNewFileModal();
    });

    // Live validation in the new file modal
    newFileInput.addEventListener('input', function () {
        var value = newFileInput.value.trim();

        if (value.length === 0) {
            newFileValidation.textContent = '';
            newFileValidation.className = 'modal-validation';
            newFileCreateBtn.disabled = true;
            return;
        }

        var result = validateSlug(value);

        if (result.valid) {
            newFileValidation.textContent = '';
            newFileCreateBtn.disabled = false;
        } else {
            newFileValidation.textContent = result.error;
            newFileValidation.className = 'modal-validation error';
            newFileCreateBtn.disabled = true;
        }
    });

    // Create new file
    newFileCreateBtn.addEventListener('click', function () {
        var value = newFileInput.value.trim();
        var result = validateSlug(value);

        if (!result.valid) return;

        newFileCreateBtn.disabled = true;
        newFileValidation.textContent = 'Checking...';
        newFileValidation.className = 'modal-validation';

        // Check if the file already exists
        fetch('/api/files/' + encodeURIComponent(result.slug))
            .then(function (res) {
                return res.json().then(function (data) {
                    return { status: res.status, data: data };
                });
            })
            .then(function (checkResult) {
                if (checkResult.status === 200) {
                    // File exists and is not expired
                    newFileValidation.textContent = 'That name is already in use.';
                    newFileValidation.className = 'modal-validation error';
                    newFileCreateBtn.disabled = false;

                    // Add an "Open it instead?" option
                    newFileValidation.innerHTML = '';
                    var text = document.createTextNode('That name is already in use. ');
                    var link = document.createElement('a');
                    link.href = '/' + encodeURIComponent(result.slug);
                    link.textContent = 'Open it instead?';
                    newFileValidation.appendChild(text);
                    newFileValidation.appendChild(link);
                    newFileValidation.className = 'modal-validation error';
                } else if (checkResult.status === 404 || checkResult.status === 410) {
                    // File doesn't exist or is expired — navigate to create it
                    window.location.href = '/' + encodeURIComponent(result.slug);
                } else {
                    newFileValidation.textContent = 'Error checking filename. Try again.';
                    newFileValidation.className = 'modal-validation error';
                    newFileCreateBtn.disabled = false;
                }
            })
            .catch(function () {
                newFileValidation.textContent = 'Network error. Try again.';
                newFileValidation.className = 'modal-validation error';
                newFileCreateBtn.disabled = false;
            });
    });

    // Submit on Enter in the new file modal
    newFileInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !newFileCreateBtn.disabled) {
            newFileCreateBtn.click();
        }
    });

    // ============================================================
    // KEYBOARD SHORTCUTS
    // ============================================================

    document.addEventListener('keydown', function (e) {
        // Ctrl+S / Cmd+S — Save
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault(); // Prevent browser's "Save Page" dialog
            if (!isExpired && hasUnsavedChanges) {
                clearTimeout(debounceTimer);
                retryCount = 0;
                saveContent();
            }
        }

        // Ctrl+Shift+N / Cmd+Shift+N — New file
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
            e.preventDefault();
            openNewFileModal();
        }
    });

    // ============================================================
    // WARN ON TAB CLOSE (only if unsaved changes)
    // ============================================================

    window.addEventListener('beforeunload', function (e) {
        if (hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // ============================================================
    // PAUSE POLLING WHEN TAB IS HIDDEN
    // ============================================================

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            stopPolling();
        } else if (!isExpired) {
            startPolling();
        }
    });

    // ============================================================
    // CLIPBOARD HELPER
    // ============================================================

    /**
     * Copy text to the clipboard using the Clipboard API.
     * Falls back to a textarea-based approach on non-HTTPS origins.
     *
     * Note: navigator.clipboard requires HTTPS or localhost.
     * If the page is served over plain HTTP (not localhost),
     * the Clipboard API will fail. The fallback handles this.
     */
    function copyToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }

        // Fallback for non-HTTPS origins
        return new Promise(function (resolve, reject) {
            var tempTextarea = document.createElement('textarea');
            tempTextarea.value = text;
            tempTextarea.style.position = 'fixed';
            tempTextarea.style.left = '-9999px';
            document.body.appendChild(tempTextarea);
            tempTextarea.select();

            try {
                var ok = document.execCommand('copy');
                document.body.removeChild(tempTextarea);
                if (ok) resolve();
                else reject(new Error('Copy failed'));
            } catch (err) {
                document.body.removeChild(tempTextarea);
                reject(err);
            }
        });
    }

})();
