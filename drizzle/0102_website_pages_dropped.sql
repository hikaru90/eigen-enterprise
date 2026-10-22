-- Pages are dropped from the product surface (owner decision, 2026-10-22):
-- the website module is apps-first; pages were stray entries that led to
-- nothing openable. This deletes every stored page (kind 'page'). Docs
-- (kind 'doc') are a different feature and stay untouched. The table itself
-- stays: docs live in it, and the chat-side content tools remain registered.

DELETE FROM "website_content" WHERE "kind" = 'page';
