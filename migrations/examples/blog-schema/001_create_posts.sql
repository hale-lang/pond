-- 001_create_posts.sql — create the posts table.
--
-- First migration in the blog-schema demo. Holds the core posts
-- record: a row per blog post with title, body, and the timestamp
-- the post was authored. INTEGER PRIMARY KEY auto-yields rowid
-- under SQLite.

CREATE TABLE posts (
    id         INTEGER PRIMARY KEY,
    title      TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
);
