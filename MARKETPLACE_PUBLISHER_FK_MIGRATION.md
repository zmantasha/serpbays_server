# Marketplace → Publisher Ownership Migration

**Status:** Applied to staging on 2026-05-25. Not yet applied to production.

## TL;DR

Marketplace ownership used to be a soft pointer (`marketplaces.publisher_email` string column) with no database-level enforcement. Deleting a publisher would silently leave their listings ownerless. This migration replaces that with:

1. A **required FK** (`marketplaces.publisher` → `up_users.id`) — Strapi enforces at the entityService/API layer
2. A **DB-level `ON DELETE RESTRICT`** on `marketplaces_publisher_lnk.user_id` — Postgres blocks publisher deletion if marketplaces exist
3. A **Strapi lifecycle hook** (`beforeDelete` on user) — friendly error message in the admin panel before the DB rejects
4. A **second lifecycle hook** (`afterUpdate`) — keeps `marketplaces.publisher_email` in sync as a denormalized cache when a user changes their email

After this, deleting a user who owns marketplaces is **structurally impossible** at three independent layers.

---

## Background — what went wrong

Before this migration:

```
marketplaces.publisher_email  : VARCHAR, required        ← ownership "lived" here
marketplaces.publisher (FK)    : optional, mostly NULL    ← supposed to be canonical, wasn't
```

The Strapi schema declared `publisher` as an optional `manyToOne` relation. In practice, the email-string column held real ownership data while the FK relation was empty — 0 of 205 marketplaces on staging had the FK populated. The frontend and several backend code paths read `publisher_email` and never checked the FK.

During a Clerk-orphan cleanup on staging (2026-05-25), an FK-based safety check passed for 62 "local" user rows that had zero references in `marketplaces_publisher_lnk` — and so they were deleted. They actually owned ~190 marketplaces via the email-string column. The marketplaces stayed in the database, but they pointed at users that no longer existed.

The core lesson: **column-name doesn't imply FK target, and FK metadata doesn't catch string-based soft references.** A safety check that only consults `information_schema` will miss this class of pointer.

---

## What this migration does

### 1. Schema change

`src/api/marketplace/content-types/marketplace/schema.json`:

```json
"publisher": {
  "type": "relation",
  "relation": "manyToOne",
  "target": "plugin::users-permissions.user",
  "required": true,
  "description": "Publisher who owns this marketplace listing. Required FK (DB-level ON DELETE RESTRICT). publisher_email is a denormalized cache, kept in sync via lifecycle hook."
}
```

Effect: creating or updating a marketplace via the Strapi entityService or REST/GraphQL API requires `publisher` to be set. Direct `db.query` calls bypass this (by design — `db.query` is a low-level ORM API).

### 2. DB-level constraint

`src/index.js` bootstrap (Postgres-only, idempotent):

```js
ALTER TABLE marketplaces_publisher_lnk DROP CONSTRAINT marketplaces_publisher_lnk_ifk;
ALTER TABLE marketplaces_publisher_lnk
  ADD CONSTRAINT marketplaces_publisher_lnk_ifk
  FOREIGN KEY (user_id) REFERENCES up_users(id) ON DELETE RESTRICT;
```

The bootstrap reads the current `delete_rule` from `information_schema.referential_constraints` and only alters when it's not already `RESTRICT`. Safe to run every startup.

### 3. Strapi `beforeDelete` lifecycle (friendly error)

`src/extensions/users-permissions/strapi-server.js` — inside the `plugin.contentTypes.user.lifecycles` object:

```js
async beforeDelete(event) {
  await blockUserDeleteIfOwnsMarketplaces(event.params.where);
},
async beforeDeleteMany(event) {
  await blockUserDeleteIfOwnsMarketplaces(event.params.where);
},
```

The helper resolves the delete's `where` clause to concrete user IDs, queries `marketplaces_publisher_lnk` for ownership counts, and throws:

```
Cannot delete user — they own marketplaces: email@x.com (7 marketplaces).
Reassign or archive these marketplaces before deleting the user.
```

The hook fires only for Strapi-mediated deletes (`strapi.db.query().delete()`, `entityService.delete`, admin panel, REST API). Raw SQL `DELETE FROM up_users` bypasses it — but the DB constraint catches that case.

**Important — Strapi 5 specifics:** For users-permissions content type, lifecycle hooks must be added inside `strapi-server.js` via `plugin.contentTypes.user.lifecycles = {...}`. A standalone `lifecycles.js` at `src/extensions/users-permissions/content-types/user/lifecycles.js` is **silently ignored**. We tried that path first and the hook didn't fire — see `test-marketplace-publisher-restrict.js` for the verification.

### 4. Strapi `afterUpdate` lifecycle (email cache sync)

Same file (`strapi-server.js`), same lifecycles object:

```js
async afterUpdate(event) {
  const { result, params } = event;
  if (!params?.data?.email || !result?.id) return;

  await strapi.db.connection('marketplaces')
    .whereIn('id',
      strapi.db.connection('marketplaces_publisher_lnk')
        .select('marketplace_id').where({ user_id: result.id })
    )
    .update({ publisher_email: result.email });
}
```

Only runs when the update payload included an `email` field. Updates `publisher_email` on every marketplace the user owns (via the FK junction table). Idempotent — re-running with the same email is a no-op at the DB level.

---

## How to verify it's working

### One-shot smoke tests

Two test scripts live in `scripts/`:

```bash
node scripts/test-marketplace-publisher-restrict.js
# Verifies: lifecycle hook fires + entityService rejects missing publisher

node scripts/test-email-cascade.js
# Verifies: email change cascades to publisher_email; reverts before exit
```

Both are safe — neither mutates persistent state. The cascade test changes user 260's email temporarily and reverts in a `finally` block.

### Manual checks (SQL)

```sql
-- 1. FK constraint should be ON DELETE RESTRICT (not CASCADE)
SELECT constraint_name, delete_rule
FROM information_schema.referential_constraints
WHERE constraint_name = 'marketplaces_publisher_lnk_ifk';

-- 2. Every marketplace should have a valid publisher FK
SELECT COUNT(*) FROM marketplaces m
WHERE NOT EXISTS (
  SELECT 1 FROM marketplaces_publisher_lnk WHERE marketplace_id = m.id
);
-- Expected: 0

-- 3. Every marketplace's publisher_email should match its publisher's email
SELECT m.id, m.publisher_email, u.email
FROM marketplaces m
JOIN marketplaces_publisher_lnk l ON l.marketplace_id = m.id
JOIN up_users u ON u.id = l.user_id
WHERE m.publisher_email <> u.email;
-- Expected: 0 rows (cache is in sync)
```

### Manual test (admin panel)

In Strapi admin → Content Manager → Users → pick a user who owns marketplaces → Delete. You should see the friendly error message, not a raw FK violation.

---

## Operations

### "I need to delete a user, but they own marketplaces"

The system will refuse. To proceed:

1. **Reassign their marketplaces** to a different publisher first (preferred for real customers):

   ```sql
   -- Find the new owner's id
   SELECT id, email FROM up_users WHERE email = 'new-owner@example.com';

   -- Reassign — UPDATE the junction AND the cache column
   UPDATE marketplaces_publisher_lnk SET user_id = <new_id> WHERE user_id = <old_id>;
   UPDATE marketplaces SET publisher_email = '<new-owner-email>'
   WHERE id IN (SELECT marketplace_id FROM marketplaces_publisher_lnk WHERE user_id = <new_id>);
   ```

   Then delete the user normally.

2. **Or archive the marketplaces** (if you want to preserve the data but stop them appearing):

   Add a `status='archived'` (or whatever your hide-from-listings field is — check the schema for the active field name). Note that **archived marketplaces still hold the FK**, so this alone doesn't allow user deletion. You'd still need to reassign them off the user or hard-delete the archived rows.

3. **Or hard-delete the marketplaces** (if they're truly junk):

   ```sql
   DELETE FROM marketplaces WHERE id IN (
     SELECT marketplace_id FROM marketplaces_publisher_lnk WHERE user_id = <user_id>
   );
   -- The publisher_lnk rows cascade-delete with the marketplaces.
   -- Now the user can be deleted.
   ```

Whichever path: **DON'T disable the RESTRICT to "just delete the user."** That's the whole protection.

### "I accidentally deleted a user — recover the rows"

The DB rejected it if marketplaces exist. If it succeeded, you deleted a user with zero marketplaces — no marketplace harm. If the marketplaces somehow lost their FK link anyway (e.g., from a manual junction-table DELETE), restore from `pg_dump`. Backups under `serpbays_server/backups/`.

### "publisher_email and publisher don't agree on some rows"

The cache drifted. One-shot resync:

```sql
UPDATE marketplaces m
SET publisher_email = u.email
FROM marketplaces_publisher_lnk l
JOIN up_users u ON u.id = l.user_id
WHERE l.marketplace_id = m.id
  AND m.publisher_email <> u.email;
```

Then investigate why the `afterUpdate` hook didn't fire (was the user updated via raw SQL? a controller that bypasses lifecycles?).

---

## Production migration checklist

When taking this to prod, follow this exact order. Each step must succeed before the next.

- [ ] **1. Audit production data**

  ```sql
  -- How many marketplaces lack a publisher FK?
  SELECT COUNT(*) FROM marketplaces m
  WHERE NOT EXISTS (
    SELECT 1 FROM marketplaces_publisher_lnk WHERE marketplace_id = m.id
  );

  -- Of those, how many have a publisher_email that matches a live user?
  SELECT m.publisher_email, COUNT(*) AS marketplaces,
         CASE WHEN u.id IS NOT NULL THEN 'alive (id=' || u.id || ')' ELSE 'orphan' END AS state
  FROM marketplaces m
  LEFT JOIN up_users u ON u.email = m.publisher_email
  LEFT JOIN marketplaces_publisher_lnk l ON l.marketplace_id = m.id
  WHERE l.marketplace_id IS NULL
  GROUP BY m.publisher_email, u.id
  ORDER BY 2 DESC;
  ```

- [ ] **2. Take a `pg_dump` backup.** Save the file off-host. Verify it restores to a scratch DB.

- [ ] **3. Backfill the FK for live publishers** (matching their email):

  ```sql
  INSERT INTO marketplaces_publisher_lnk (marketplace_id, user_id)
  SELECT m.id, u.id
  FROM marketplaces m
  JOIN up_users u ON u.email = m.publisher_email
  LEFT JOIN marketplaces_publisher_lnk l ON l.marketplace_id = m.id
  WHERE l.marketplace_id IS NULL
  ON CONFLICT (marketplace_id, user_id) DO NOTHING;
  ```

- [ ] **4. Decide what to do with the still-orphaned marketplaces** (those whose `publisher_email` doesn't match any live user). For production, **archive is safer than delete** — you may lose real customer history if you delete:

  ```sql
  -- Recommended for prod: tag them but keep the data
  UPDATE marketplaces SET status = 'archived'  -- check actual field name
  WHERE id IN (
    SELECT m.id FROM marketplaces m
    LEFT JOIN marketplaces_publisher_lnk l ON l.marketplace_id = m.id
    WHERE l.marketplace_id IS NULL
  );
  ```

  **Note:** archived marketplaces still hold no FK. To make the `publisher` relation truly required on EVERY row, you'd need to assign them to a "system" admin user — OR — temporarily delay the schema's `required: true` change until they're either reassigned or hard-deleted.

- [ ] **5. Once every marketplace has an FK (verify with the count query from step 1)**, deploy the code:
  - Pull the latest `serpbays_server` branch
  - `pm2 restart backend-server`
  - Check logs for: `[BOOTSTRAP] Changed marketplaces_publisher_lnk_ifk delete rule: CASCADE → RESTRICT`

- [ ] **6. Smoke-test**: run `node scripts/test-marketplace-publisher-restrict.js` on prod. Should pass.

- [ ] **7. Monitor** for 24 hours: any unexpected `[LIFECYCLE afterUpdate]` log lines should match real user email changes. Any `Cannot delete user` errors point to admins trying to do the right thing — investigate before bypassing.

---

## Future work

This migration fixed `marketplaces`. The same problem exists in `publisher_websites`:

- `publisher_websites.publisherEmail` (camelCase) — string-based ownership, same pattern
- `publisher_websites.currentPublisherId` — relation, weakly enforced
- Heavy code in `src/api/publisher-website/lifecycles.js` and `controllers/publisher-website.js` reads the email column

Staging has zero `publisher_websites` rows, so it didn't bite us. Production likely has data. **Schedule a parallel migration with the same playbook**: required FK, ON DELETE RESTRICT, lifecycle guard, cache sync.

Other potentially affected entities — audit when convenient: `orders` (looks healthy, uses real FK already), `transactions`, `withdrawal_requests`, `invoices`. Check for any "email" or "name" column that's also held in a relation.

---

## Lessons learned

1. **Column-name does not imply FK target.** `admin_users_roles_lnk.user_id` is named `user_id` but FK's `admin_users.id`, not `up_users.id`. An audit query that scans `information_schema.columns WHERE column_name='user_id'` will give false positives. Use `information_schema.referential_constraints` and check the actual referenced table.

2. **String-based ownership is invisible to FK-based safety checks.** Any audit looking for "is this user safe to delete" must inspect both FK references AND string columns that might hold the user's email/username/etc. as a soft reference.

3. **Strapi schemas don't expose `ON DELETE` behavior.** Relations are declared with just `target` and `relation`. The actual delete behavior defaults to CASCADE in the generated junction table. To get RESTRICT (or any other behavior), use raw SQL — and put it in a bootstrap hook so it survives schema regeneration.

4. **Strapi 5 plugin extension lifecycles must go in `strapi-server.js`, not `content-types/user/lifecycles.js`.** This is the opposite of api content types, where the standalone file works. We burned a verification cycle on this.

5. **Denormalized caches need explicit sync.** Two columns holding "the same fact" (publisher_email and publisher.email) will drift unless a lifecycle hook keeps them aligned. If you can't write the hook, don't denormalize — use the FK only.

6. **Run audits before destructive cleanups, especially on string columns.** The safety check that should have been run before deleting users in this codebase:

   ```sql
   -- Does this user (by email) own any marketplaces by email-string?
   SELECT COUNT(*) FROM marketplaces WHERE publisher_email = '<email>';
   -- Same question for publisher_websites
   SELECT COUNT(*) FROM publisher_websites WHERE publisher_email = '<email>';
   ```

   This sits alongside, not in place of, the FK-based check.
