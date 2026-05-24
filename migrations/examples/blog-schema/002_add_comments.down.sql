-- 002_add_comments.down.sql — roll back comments + index.

DROP INDEX IF EXISTS comments_by_post;
DROP TABLE comments;
