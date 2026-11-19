# TempPad — Temporary Public Plain-Text Notepad

TempPad is a minimal, fast, and secure web application that allows anyone to create and share plain-text files simply by typing a filename into the URL (e.g. `https://yourdomain.com/notes`).

Every file expires **EXACTLY 24 hours** after creation. Edits, views, and refreshes never reset or extend the 24-hour countdown.

---

## Architecture Overview

```
                      +-----------------------------+
                      |       Client Browser        |
                      |  Vanilla HTML5 / CSS3 / JS  |
                      +--------------+--------------+
                                     |
               HTTP (GET /:slug shell, REST API on /api)
                                     |
                                     v
                      +-----------------------------+
                      |    Express.js Web Server    |
                      |  - Helmet / CSP             |
                      |  - express-rate-limit       |
                      |  - In-process Scheduler     |
                      |  - Static File Delivery     |
                      +--------------+--------------+
                                     |
                         pg Pool (Parameterized SQL)
                                     |
                                     v
                      +-----------------------------+
                      |         PostgreSQL          |
                      |  - Table: files             |
                      |  - Check constraints        |
                      |  - Immutability trigger     |
                      |  - Index on expires_at      |
                      +-----------------------------+
```

---

## Features

- **Zero-Friction File Creation:** Visiting any unused URL (e.g., `/:slug`) opens an empty plain-text pad.
- **Strict 24-Hour Expiration:** Enforced at the database level (`expires_at > now()`) across all queries.
- **Atomic Compare-and-Swap Concurrency:** Detects conflicts on save (`409 Conflict`) with interactive three-way resolution.
- **Smart Autosave & Polling:** Keystroke debouncing (1.5s), single in-flight request management, and lightweight revision polling (`?since_revision=N`).
- **Clock Drift Protection:** Computes `clockOffset = server_time - local_time` so client device inaccuracies do not skew the timer.
- **XSS & Injection Immune:** Content is always treated strictly as plain text (using `.value` and `textContent`); SQL uses parameterized queries.
- **Accessible & Responsive:** Full dark/light mode toggle with system preference fallback, WCAG-compliant contrast, and zero external runtime CDNs.

---

## Directory Structure

```
temppad/
├── backend/
│   ├── src/
│   │   ├── config/env.js          # Environment variable validation & defaults
│   │   ├── db/pool.js             # PostgreSQL connection pool with SSL & health check
│   │   ├── middleware/
│   │   │   ├── errorHandler.js    # Sanitized central error handler
│   │   │   ├── rateLimiters.js    # Per-IP rate limiting (creation, read, write)
│   │   │   ├── security.js        # Helmet & Content Security Policy (CSP)
│   │   │   └── validateSlug.js    # Slug normalization & safety verification
│   │   ├── routes/
│   │   │   ├── files.js           # REST API endpoints for files
│   │   │   └── health.js          # Health check endpoint
│   │   ├── services/fileService.js# All SQL queries & transaction logic
│   │   ├── utils/slug.js          # Shared slug validation rules & regex
│   │   ├── jobs/cleanup.js        # In-process scheduled cleanup worker
│   │   ├── app.js                 # Express app initialization & route assembly
│   │   └── server.js              # Server bootstrapper & graceful shutdown handler
│   └── tests/
│       ├── api.test.js            # Comprehensive backend integration tests
│       └── frontend.test.js       # JSDOM tests for client-side behaviors
├── database/
│   └── migrations/
│       └── 001_create_files.sql   # Schema, check constraints, indexes, triggers
├── frontend/
│   └── public/
│       ├── css/style.css          # Design system, responsive layout & themes
│       ├── js/
│       │   ├── editor.js          # Autosave, conflict, countdown & action handlers
│       │   ├── landing.js         # Landing page live slug validator & redirect
│       │   └── theme.js           # Dark/Light theme manager
│       ├── editor.html            # Editor interface shell
│       ├── error.html             # Clean 400 Bad Request error view
│       └── index.html             # Clean landing homepage
├── scripts/
│   ├── cleanup.js                 # Standalone script for cron/worker cleanup
│   └── migrate.js                 # Schema migration runner
├── .env.example                   # Environment variable template
├── .gitignore                     # Git ignore definitions
├── package.json                   # Project metadata, scripts, and dependencies
├── render.yaml                    # Infrastructure-as-code specification for Render
└── README.md                      # Complete system documentation
```

---

## Quickstart (Local Development)

### 1. Prerequisites
- **Node.js** >= 20.x LTS
- **PostgreSQL** >= 13

### 2. Setup Database
```sql
CREATE USER temppad_user WITH PASSWORD 'password123';
CREATE DATABASE temppad OWNER temppad_user;
```

### 3. Install & Configure
```bash
# Clone and enter workspace
git clone <repo-url>
cd temppad

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

Edit `.env`:
```ini
DATABASE_URL=postgresql://temppad_user:password123@localhost:5432/temppad
PORT=3000
NODE_ENV=development
FILE_TTL_SECONDS=86400
```

### 4. Migrate & Run
```bash
# Run schema migration
npm run migrate

# Start local server with hot reloading
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) or navigate directly to [http://localhost:3000/my-notes](http://localhost:3000/my-notes).

---

## API Reference

### 1. Open or Create File
`POST /api/files/:slug`

**Response (`201 Created` or `200 OK`):**
```json
{
  "slug": "meeting-notes",
  "content": "",
  "revision": 1,
  "created_at": "2026-11-19T13:00:00.000Z",
  "expires_at": "2026-11-20T13:00:00.000Z",
  "updated_at": "2026-11-19T13:00:00.000Z",
  "created": true,
  "server_time": "2026-11-19T13:00:00.000Z"
}
```

### 2. Read File
`GET /api/files/:slug`  
Optional Query: `?since_revision=1`

- If revision unchanged: `200 OK` with `{"changed": false, "server_time": "..."}`
- If changed or full read: `200 OK` with full file object.
- If expired: `410 Gone`.

### 3. Save File
`PUT /api/files/:slug`

**Request Body:**
```json
{
  "content": "Updated content here",
  "base_revision": 1
}
```

- **Success:** `200 OK` with updated file record and incremented `revision`.
- **Conflict:** `409 Conflict` returning the current server content and revision.
- **Expired:** `410 Gone`.

### 4. Health Check
`GET /api/health`

**Response (`200 OK`):**
```json
{
  "status": "ok",
  "database": "connected"
}
```

---

## Expiration System (3-Layer Defense)

1. **Layer 1 (Database Enforcement):** All read and write queries execute with `WHERE expires_at > now()`. Expired files are inaccessible even if they still exist in the table. An update trigger forbids any modification to `created_at` or `expires_at`.
2. **Layer 2 (In-Process Scheduler):** Express runs a scheduled job immediately on boot and every 5 minutes executing `DELETE FROM files WHERE expires_at <= now()`.
3. **Layer 3 (External Cron / CLI):** `node scripts/cleanup.js` runs independently via OS cron or platform job schedulers, guaranteeing cleanup even if web instances sleep or cycle.

---

## Security Model

- **Content-Security-Policy (CSP):** `default-src 'self'`. Disallows inline scripts, external script injection, framing, and unauthorized connections.
- **Rate Limiting:** Granular rate limiting on creation (10/15m), reads (120/1m), and writes (30/1m) with `Retry-After` headers.
- **Strict Slugs:** Only `^[a-z0-9_-]{1,64}$`. Path traversal (`..`), null bytes, slash characters, and system route collisions are strictly rejected with `400 Bad Request`.
- **Resource Constraints:** Request bodies capped at 300KB; content max length capped at 200,000 characters by both application logic and PostgreSQL `CHECK` constraint.

---

## Extensibility Guide

Where to add future features without architectural refactoring:

| Feature | Primary Location | Strategy |
|---|---|---|
| **Password Protection** | `001_create_files.sql` & `fileService.js` | Add `password_hash TEXT` column; add middleware verifying `bcrypt.compare`. |
| **Custom Expirations** | `routes/files.js` & `fileService.js` | Accept optional `ttl` body param on creation capped at 7 days. |
| **Real-time WebSockets** | `backend/src/server.js` | Attach `ws` or `Socket.io` server; broadcast diffs on save. |
| **Version History** | Schema & `fileService.js` | Add `file_revisions` table storing previous snapshots. |
| **API Authentication** | `backend/src/middleware/auth.js` | Add Bearer token inspection middleware with API key storage. |

---

## License
MIT
