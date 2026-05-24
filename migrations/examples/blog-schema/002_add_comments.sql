-- 002_add_comments.sql — comments on posts.
--
-- Second migration in the blog-schema demo. Adds a comments table
-- with a FK reference back to posts.id. Each comment carries an
-- author handle, body text, and a timestamp.

CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author     TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX comments_by_post ON comments(post_id);
