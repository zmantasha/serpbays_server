-- Indexes added by hand during the Oct 2026 admin-panel work (not managed by Strapi).
-- 2026-10-13: moderation flags list did a sequential scan of publisher_websites per row (7.3 s -> 6 ms).
create index concurrently if not exists idx_pw_marketplace_id on publisher_websites (marketplace_id);
