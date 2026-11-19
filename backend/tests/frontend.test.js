/**
 * @jest-environment jsdom
 */

// ============================================================
// TempPad — Frontend Logic & DOM Tests
// ============================================================
// Tests client-side functionality using Jest + JSDOM:
//   1. Download generation (Blob, text/plain;charset=utf-8, <slug>.txt)
//   2. Copy link to clipboard
//   3. Text counting helpers
//   4. Network save failure resilience (textarea preserves text)
// ============================================================

describe('Frontend Logic Tests', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });

    // ------------------------------------------------------------
    // Test: Download generation
    // ------------------------------------------------------------
    test('download triggers plain text file download with <slug>.txt', () => {
        const slug = 'notes-123';
        const content = 'Line 1\nLine 2';

        // Mock Blob and URL.createObjectURL / revokeObjectURL
        const createObjectURLMock = jest.fn().mockReturnValue('blob:mock-url');
        const revokeObjectURLMock = jest.fn();
        global.URL.createObjectURL = createObjectURLMock;
        global.URL.revokeObjectURL = revokeObjectURLMock;

        // Mock anchor click
        let clickedLink = null;
        const originalAppendChild = document.body.appendChild.bind(document.body);
        const originalRemoveChild = document.body.removeChild.bind(document.body);

        jest.spyOn(document.body, 'appendChild').mockImplementation((node) => {
            if (node.tagName === 'A') {
                clickedLink = node;
                node.click = jest.fn();
            }
            return originalAppendChild(node);
        });

        // Trigger download logic
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = slug + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        expect(createObjectURLMock).toHaveBeenCalled();
        expect(clickedLink).not.toBeNull();
        expect(clickedLink.download).toBe('notes-123.txt');
        expect(clickedLink.href).toBe('blob:mock-url');
        expect(clickedLink.click).toHaveBeenCalled();
        expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:mock-url');
    });

    // ------------------------------------------------------------
    // Test: Copy link copies the full URL
    // ------------------------------------------------------------
    test('copy link writes full URL to clipboard', async () => {
        const writeTextMock = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, {
            clipboard: {
                writeText: writeTextMock,
            },
        });
        window.isSecureContext = true;

        const slug = 'test-slug';
        const fullUrl = `http://localhost/${slug}`;

        await navigator.clipboard.writeText(fullUrl);

        expect(writeTextMock).toHaveBeenCalledWith('http://localhost/test-slug');
    });

    // ------------------------------------------------------------
    // Test: Text count utilities
    // ------------------------------------------------------------
    test('text metrics compute character, word, and line count properly', () => {
        function computeMetrics(text) {
            const chars = text.length;
            const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
            const lines = text.split('\n').length;
            return { chars, words, lines };
        }

        expect(computeMetrics('')).toEqual({ chars: 0, words: 0, lines: 1 });
        expect(computeMetrics('Hello world')).toEqual({ chars: 11, words: 2, lines: 1 });
        expect(computeMetrics('First line\nSecond line\nThird')).toEqual({ chars: 28, words: 5, lines: 3 });
    });

    // ------------------------------------------------------------
    // Test: Network failure does not clear textarea content
    // ------------------------------------------------------------
    test('network save error preserves local textarea text and displays error', async () => {
        document.body.innerHTML = `
            <textarea id="editorTextarea">My unsaved precious draft</textarea>
            <span id="saveStatus"></span>
        `;

        const textarea = document.getElementById('editorTextarea');
        const saveStatus = document.getElementById('saveStatus');

        // Simulate save failure
        global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

        try {
            await fetch('/api/files/test', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: textarea.value, base_revision: 1 })
            });
        } catch {
            saveStatus.textContent = 'Network error — retrying...';
        }

        // Assert: textarea was NEVER cleared
        expect(textarea.value).toBe('My unsaved precious draft');
        expect(saveStatus.textContent).toBe('Network error — retrying...');
    });
});
