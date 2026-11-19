// ============================================================
// TempPad — Backend API tests
// ============================================================
// Uses Jest + Supertest to test all API endpoints.
//
// IMPORTANT: These tests require a running PostgreSQL database.
// Set DATABASE_URL in your .env to point to a TEST database
// (e.g., temppad_test). Tests clean up after themselves.
//
// Run with: npm test
// ============================================================

'use strict';

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/db/pool');

// --- Setup and teardown ---

beforeAll(async () => {
    // Run the migration to ensure the table exists in the test DB.
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.resolve(__dirname, '../../database/migrations/001_create_files.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await db.query(sql);
});

afterEach(async () => {
    // Clean up all files after each test to prevent cross-contamination.
    await db.query('DELETE FROM files');
});

afterAll(async () => {
    // Close the database pool so Jest can exit cleanly.
    await db.close();
});

// ============================================================
// POST /api/files/:slug — Create or open a file
// ============================================================

describe('POST /api/files/:slug', () => {
    test('creates a new file and returns 201', async () => {
        const res = await request(app)
            .post('/api/files/testfile')
            .expect(201);

        expect(res.body.slug).toBe('testfile');
        expect(res.body.content).toBe('');
        expect(res.body.revision).toBe(1);
        expect(res.body.created).toBe(true);
        expect(res.body.created_at).toBeDefined();
        expect(res.body.expires_at).toBeDefined();
        expect(res.body.updated_at).toBeDefined();
        expect(res.body.server_time).toBeDefined();
    });

    test('opens an existing file and returns 200 with created: false', async () => {
        // Create the file first
        await request(app).post('/api/files/existing').expect(201);

        // Open it again
        const res = await request(app)
            .post('/api/files/existing')
            .expect(200);

        expect(res.body.slug).toBe('existing');
        expect(res.body.created).toBe(false);
        expect(res.body.revision).toBe(1);
    });

    test('normalizes slug to lowercase', async () => {
        const res = await request(app)
            .post('/api/files/MyFile')
            .expect(201);

        expect(res.body.slug).toBe('myfile');
    });

    test('returns 410 for an expired file', async () => {
        // Create a file, then manually expire it
        await request(app).post('/api/files/expired-test').expect(201);

        // Set expires_at to the past (bypass the trigger by using a direct approach)
        // We need to drop and recreate the trigger temporarily for testing
        await db.query('DROP TRIGGER IF EXISTS trg_prevent_timestamp_change ON files');
        await db.query(
            `UPDATE files SET expires_at = now() - interval '1 hour' WHERE slug = 'expired-test'`
        );
        // Recreate the trigger
        await db.query(`
            CREATE TRIGGER trg_prevent_timestamp_change
                BEFORE UPDATE ON files
                FOR EACH ROW
                EXECUTE FUNCTION prevent_timestamp_change();
        `);

        const res = await request(app)
            .post('/api/files/expired-test')
            .expect(410);

        expect(res.body.error).toBe('expired');
        // Content must NOT be returned
        expect(res.body.content).toBeUndefined();
    });

    test('rejects invalid slugs with 400', async () => {
        const invalidSlugs = [
            'has spaces',
            'has.dots',
            '../traversal',
            'a'.repeat(65),     // too long
            'admin',            // reserved
            'api',              // reserved
            'has/slash',
            '%00nullbyte',
        ];

        for (const slug of invalidSlugs) {
            const res = await request(app)
                .post('/api/files/' + encodeURIComponent(slug))
                .expect(400);

            expect(res.body.error).toBe('invalid_slug');
        }
    });
});

// ============================================================
// GET /api/files/:slug — Read a file
// ============================================================

describe('GET /api/files/:slug', () => {
    test('returns file data for an existing file', async () => {
        await request(app).post('/api/files/readable').expect(201);

        const res = await request(app)
            .get('/api/files/readable')
            .expect(200);

        expect(res.body.slug).toBe('readable');
        expect(res.body.content).toBe('');
        expect(res.body.revision).toBe(1);
        expect(res.body.server_time).toBeDefined();
    });

    test('returns 404 for a non-existent file', async () => {
        const res = await request(app)
            .get('/api/files/nonexistent')
            .expect(404);

        expect(res.body.error).toBe('not_found');
    });

    test('returns 410 for an expired file without leaking content', async () => {
        await request(app).post('/api/files/expired-read').expect(201);

        // Save some content first
        await request(app)
            .put('/api/files/expired-read')
            .send({ content: 'secret data', base_revision: 1 })
            .expect(200);

        // Expire it
        await db.query('DROP TRIGGER IF EXISTS trg_prevent_timestamp_change ON files');
        await db.query(
            `UPDATE files SET expires_at = now() - interval '1 hour' WHERE slug = 'expired-read'`
        );
        await db.query(`
            CREATE TRIGGER trg_prevent_timestamp_change
                BEFORE UPDATE ON files
                FOR EACH ROW
                EXECUTE FUNCTION prevent_timestamp_change();
        `);

        const res = await request(app)
            .get('/api/files/expired-read')
            .expect(410);

        expect(res.body.error).toBe('expired');
        expect(res.body.content).toBeUndefined(); // Content NOT leaked
    });

    test('lightweight poll with since_revision returns changed: false', async () => {
        await request(app).post('/api/files/polltest').expect(201);

        const res = await request(app)
            .get('/api/files/polltest?since_revision=1')
            .expect(200);

        expect(res.body.changed).toBe(false);
    });

    test('lightweight poll with old revision returns changed: true with content', async () => {
        await request(app).post('/api/files/polltest2').expect(201);

        // Save new content
        await request(app)
            .put('/api/files/polltest2')
            .send({ content: 'updated!', base_revision: 1 })
            .expect(200);

        const res = await request(app)
            .get('/api/files/polltest2?since_revision=1')
            .expect(200);

        expect(res.body.changed).toBe(true);
        expect(res.body.content).toBe('updated!');
        expect(res.body.revision).toBe(2);
    });
});

// ============================================================
// PUT /api/files/:slug — Save content
// ============================================================

describe('PUT /api/files/:slug', () => {
    test('saves content and increments revision', async () => {
        await request(app).post('/api/files/saveable').expect(201);

        const res = await request(app)
            .put('/api/files/saveable')
            .send({ content: 'Hello, world!', base_revision: 1 })
            .expect(200);

        expect(res.body.content).toBe('Hello, world!');
        expect(res.body.revision).toBe(2);
    });

    test('saved content is retrievable via GET', async () => {
        await request(app).post('/api/files/roundtrip').expect(201);

        await request(app)
            .put('/api/files/roundtrip')
            .send({ content: 'Saved data', base_revision: 1 })
            .expect(200);

        const res = await request(app)
            .get('/api/files/roundtrip')
            .expect(200);

        expect(res.body.content).toBe('Saved data');
    });

    test('User A saves, User B reads the same content', async () => {
        await request(app).post('/api/files/shared').expect(201);

        // User A saves
        await request(app)
            .put('/api/files/shared')
            .send({ content: 'User A wrote this', base_revision: 1 })
            .expect(200);

        // User B reads
        const res = await request(app)
            .get('/api/files/shared')
            .expect(200);

        expect(res.body.content).toBe('User A wrote this');
    });

    test('returns 409 Conflict on stale base_revision', async () => {
        await request(app).post('/api/files/conflict-test').expect(201);

        // User A saves (revision goes from 1 to 2)
        await request(app)
            .put('/api/files/conflict-test')
            .send({ content: 'User A content', base_revision: 1 })
            .expect(200);

        // User B tries to save with stale revision 1
        const res = await request(app)
            .put('/api/files/conflict-test')
            .send({ content: 'User B content', base_revision: 1 })
            .expect(409);

        expect(res.body.error).toBe('conflict');
        expect(res.body.content).toBe('User A content'); // Server's latest
        expect(res.body.revision).toBe(2);
    });

    test('returns 404 for a non-existent file', async () => {
        const res = await request(app)
            .put('/api/files/ghost')
            .send({ content: 'hello', base_revision: 1 })
            .expect(404);

        expect(res.body.error).toBe('not_found');
    });

    test('returns 410 for an expired file', async () => {
        await request(app).post('/api/files/expired-save').expect(201);

        await db.query('DROP TRIGGER IF EXISTS trg_prevent_timestamp_change ON files');
        await db.query(
            `UPDATE files SET expires_at = now() - interval '1 hour' WHERE slug = 'expired-save'`
        );
        await db.query(`
            CREATE TRIGGER trg_prevent_timestamp_change
                BEFORE UPDATE ON files
                FOR EACH ROW
                EXECUTE FUNCTION prevent_timestamp_change();
        `);

        const res = await request(app)
            .put('/api/files/expired-save')
            .send({ content: 'too late', base_revision: 1 })
            .expect(410);

        expect(res.body.error).toBe('expired');
    });

    test('returns 413 for content that exceeds the limit', async () => {
        await request(app).post('/api/files/toobig').expect(201);

        const hugeContent = 'x'.repeat(200001);

        const res = await request(app)
            .put('/api/files/toobig')
            .send({ content: hugeContent, base_revision: 1 })
            .expect(413);

        expect(res.body.error).toBe('content_too_large');
    });

    test('returns 400 when content is not a string', async () => {
        await request(app).post('/api/files/badcontent').expect(201);

        const res = await request(app)
            .put('/api/files/badcontent')
            .send({ content: 123, base_revision: 1 })
            .expect(400);

        expect(res.body.error).toBe('invalid_body');
    });

    test('returns 400 when base_revision is missing', async () => {
        await request(app).post('/api/files/norev').expect(201);

        const res = await request(app)
            .put('/api/files/norev')
            .send({ content: 'hello' })
            .expect(400);

        expect(res.body.error).toBe('invalid_body');
    });

    test('expires_at is NOT changed by saving (PUT does not extend the timer)', async () => {
        const createRes = await request(app).post('/api/files/no-extend').expect(201);
        const originalExpiresAt = createRes.body.expires_at;

        // Save multiple times
        await request(app)
            .put('/api/files/no-extend')
            .send({ content: 'edit 1', base_revision: 1 })
            .expect(200);

        const saveRes = await request(app)
            .put('/api/files/no-extend')
            .send({ content: 'edit 2', base_revision: 2 })
            .expect(200);

        // expires_at should be unchanged
        expect(saveRes.body.expires_at).toBe(originalExpiresAt);
    });
});

// ============================================================
// Database trigger: blocks changes to created_at and expires_at
// ============================================================

describe('Database trigger (immutable timestamps)', () => {
    test('blocks UPDATE to expires_at', async () => {
        await request(app).post('/api/files/trigger-test').expect(201);

        await expect(
            db.query(`UPDATE files SET expires_at = now() + interval '48 hours' WHERE slug = 'trigger-test'`)
        ).rejects.toThrow(/Cannot modify expires_at/);
    });

    test('blocks UPDATE to created_at', async () => {
        await request(app).post('/api/files/trigger-test2').expect(201);

        await expect(
            db.query(`UPDATE files SET created_at = now() - interval '1 day' WHERE slug = 'trigger-test2'`)
        ).rejects.toThrow(/Cannot modify created_at/);
    });
});

// ============================================================
// GET /api/health — Health check
// ============================================================

describe('GET /api/health', () => {
    test('returns 200 when the database is connected', async () => {
        const res = await request(app)
            .get('/api/health')
            .expect(200);

        expect(res.body.status).toBe('ok');
        expect(res.body.database).toBe('connected');
    });
});

// ============================================================
// Automatic cleanup
// ============================================================

describe('Cleanup job', () => {
    test('deletes expired files and leaves valid ones', async () => {
        // Create two files
        await request(app).post('/api/files/keep-me').expect(201);
        await request(app).post('/api/files/delete-me').expect(201);

        // Expire one of them
        await db.query('DROP TRIGGER IF EXISTS trg_prevent_timestamp_change ON files');
        await db.query(
            `UPDATE files SET expires_at = now() - interval '1 hour' WHERE slug = 'delete-me'`
        );
        await db.query(`
            CREATE TRIGGER trg_prevent_timestamp_change
                BEFORE UPDATE ON files
                FOR EACH ROW
                EXECUTE FUNCTION prevent_timestamp_change();
        `);

        // Run cleanup
        const fileService = require('../src/services/fileService');
        const deletedCount = await fileService.deleteExpired();

        expect(deletedCount).toBe(1);

        // Verify: keep-me still exists, delete-me is gone
        const keepRes = await request(app).get('/api/files/keep-me').expect(200);
        expect(keepRes.body.slug).toBe('keep-me');

        const deleteRes = await request(app).get('/api/files/delete-me').expect(404);
    });
});

// ============================================================
// Slug validation edge cases
// ============================================================

describe('Slug validation', () => {
    test('rejects empty slug', async () => {
        // Can't really test empty path param with supertest the same way,
        // but we can test the utility directly
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('').valid).toBe(false);
    });

    test('rejects slug with backslash', async () => {
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('test\\file').valid).toBe(false);
    });

    test('rejects path traversal attempts', async () => {
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('..').valid).toBe(false);
        expect(validateSlug('../etc/passwd').valid).toBe(false);
    });

    test('rejects slug with spaces', async () => {
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('hello world').valid).toBe(false);
    });

    test('rejects all reserved names', async () => {
        const { validateSlug, RESERVED_NAMES } = require('../src/utils/slug');
        for (const name of RESERVED_NAMES) {
            expect(validateSlug(name).valid).toBe(false);
        }
    });

    test('rejects encoded traversal (%2e%2e)', async () => {
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('%2e%2e').valid).toBe(false); // decodes to ".."
    });

    test('accepts valid slugs', async () => {
        const { validateSlug } = require('../src/utils/slug');
        expect(validateSlug('hello').valid).toBe(true);
        expect(validateSlug('my-file').valid).toBe(true);
        expect(validateSlug('test_123').valid).toBe(true);
        expect(validateSlug('a').valid).toBe(true);
        expect(validateSlug('a'.repeat(64)).valid).toBe(true);
    });
});

// ============================================================
// Invalid slug via HTTP returns 400 (not crash)
// ============================================================

describe('Invalid slug via HTTP', () => {
    test('POST with reserved name returns 400', async () => {
        await request(app)
            .post('/api/files/admin')
            .expect(400);
    });

    test('GET /:slug with invalid characters returns 400 HTML page', async () => {
        const res = await request(app)
            .get('/has%20spaces')
            .expect(400);
        // Should serve the error.html page
        expect(res.headers['content-type']).toMatch(/html/);
    });
});
