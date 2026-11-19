-- ============================================================
-- TempPad — Database Migration 001: Create the "files" table
-- ============================================================
-- Run this once against your PostgreSQL database to set up the schema.
-- Requires PostgreSQL 13+ (gen_random_uuid() is built-in since PG13;
-- on PG12 or older, uncomment the pgcrypto line below).
-- ============================================================

-- Uncomment the next line ONLY if you are on PostgreSQL 12 or older:
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- TABLE: files
-- Each row is one temporary text file identified by a URL-safe "slug".
-- ============================================================
CREATE TABLE IF NOT EXISTS files (

    -- Unique identifier (UUID v4). Generated automatically by PostgreSQL.
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The URL-safe name that appears in the browser address bar.
    -- Lowercase only, 1-64 chars, letters/digits/hyphens/underscores.
    -- The CHECK constraint mirrors the validation in the app code so
    -- even a direct SQL INSERT cannot violate the rules.
    slug TEXT NOT NULL UNIQUE
        CONSTRAINT slug_format CHECK (
            slug ~ '^[a-z0-9_-]{1,64}$'
        ),

    -- The plain-text content of the file.
    -- Default is empty string so a newly created file is blank.
    -- Max 200,000 characters to prevent abuse.
    content TEXT NOT NULL DEFAULT ''
        CONSTRAINT content_max_length CHECK (
            length(content) <= 200000
        ),

    -- Optimistic-concurrency version number.
    -- Starts at 1 and increments on every successful save.
    -- The client sends its known revision with each save request;
    -- if it doesn't match, someone else saved first -> 409 Conflict.
    revision INTEGER NOT NULL DEFAULT 1,

    -- When this file was first created (never changes after INSERT).
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- When this file expires. Set ONCE at INSERT as now() + 24h.
    -- The cleanup job and every query use this to enforce expiry.
    -- NEVER updated after the initial INSERT.
    expires_at TIMESTAMPTZ NOT NULL,

    -- When the content was last saved. Updated on every PUT.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- INDEX: fast lookups for the cleanup DELETE query
-- (The UNIQUE constraint on slug already creates an index for slug.)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files (expires_at);

-- ============================================================
-- TRIGGER: prevent any UPDATE from changing created_at or expires_at
-- This enforces the "24-hour window is immutable" rule at the
-- database level, so even buggy app code cannot extend the expiry.
-- ============================================================
CREATE OR REPLACE FUNCTION prevent_timestamp_change()
RETURNS TRIGGER AS $$
BEGIN
    -- OLD is the row before the update, NEW is the proposed row.
    -- If either immutable timestamp was changed, raise an error.
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Cannot modify created_at after insert';
    END IF;
    IF NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'Cannot modify expires_at after insert';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if present (makes re-running safe)
DROP TRIGGER IF EXISTS trg_prevent_timestamp_change ON files;

CREATE TRIGGER trg_prevent_timestamp_change
    BEFORE UPDATE ON files
    FOR EACH ROW
    EXECUTE FUNCTION prevent_timestamp_change();

-- ============================================================
-- Done. The "files" table is ready.
-- ============================================================
