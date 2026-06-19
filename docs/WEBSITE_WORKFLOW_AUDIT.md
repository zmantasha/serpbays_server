# Website Workflow Audit — Prioritized Fix Plan

**Date:** 2026-06-12
**Scope:** Website submission + inventory management (approval/rejection out of scope by request)
**Method:** 14-lens multi-agent review (4 senior devs + 3 DevOps + 4 QA + 3 security) → 97 raw findings → adversarial verification + dedupe → final plan.

## Shipped status (last updated 2026-06-15)

| # | Title | Status | Notes |
|---|---|---|---|
| 1 | submissionStatus enum mismatch | ✅ shipped | enum extended; `scripts/test-submission-status-enum.js` (21/21) |
| 2 | Duplicate `async delete` handlers | ✅ shipped | dead handler removed; `scripts/test-delete-handler.js` (14/14) |
| 3 | POST overwrites approved listing | ✅ shipped | 409 + no overwrite; covered by `test-duplicate-prevention.js` |
| 4 | Wizard fallback duplicate rows | ✅ shipped | client narrow query + advisory lock; `scripts/test-duplicate-prevention.js` (15/15) |
| 5 | `update()` ownership check | ✅ shipped | `isPublisherWebsiteOwner` helper; `scripts/test-publisher-website-ownership.js` (12/12) |
| 6 | Admin filters `$or` overwrite | ⏳ pending | |
| 7 | Claim/update TOCTOU | ✅ shipped | `SELECT … FOR UPDATE` + fresh re-read in `claimOwnership` and `update()`; `scripts/test-toctou-claim.js` (15/15); race reproducer `/tmp/repro-toctou.js` no longer reproduces (1 winner + 1 race-loser, no orphan). |
| 8 | Paused listing keeps marketplaceId | ⏳ pending | |
| 9 | JWT_SECRET fallback | ⏳ pending | |
| 10 | JWT logged to browser console | ⏳ pending | |
| 11 (stage 1) | tokenVersion revocation | ✅ shipped | `scripts/test-token-version.js` (14/14) |
| 11 (stage 2) | JWT BFF migration | 📝 design only | `docs/JWT_CUSTODY_MIGRATION.md` — not implemented per user instruction |
| 12 | admin gscVerified mass-assignment | ⏳ pending | |
| 13 | Submit-for-Review error UX | ⏳ pending | |
| 14 | admin audit fields schema | ⏳ pending | |

**Must-fix progress:** 7 of 14 shipped; 7 pending; 1 design-only.
**Regression suite:** 142/142 assertions green across 7 test scripts.

## Summary

This audit reviewed 97 findings across the publisher-website submission and inventory-management workflow in the SerpBays Strapi backend, the Next.js publisher client, and the panel20 admin app. Adversarial verification of every HIGH severity item and ~55% of MEDIUMs confirmed the audit is largely sound — most reviewers cited correct file:line locations and the failure modes are reproducible by reading the code. The dominant risk themes are (1) a **submissionStatus enum mismatch** that bricks four recovery/admin paths, (2) **mass-assignment and ownership-check inconsistencies** in the publisher-website controller, (3) **race conditions** around concurrent claim/approve and double-submit POST, and (4) **secret-handling weaknesses** (hardcoded JWT fallback, JWT in JS-readable cookie + localStorage, JWT logged to browser console). Several reviewer findings duplicate fixes already applied this session and were excluded.

## Verification stats

| | |
|---|---|
| Input findings | 97 |
| Confirmed (after dedupe + adversarial verify) | 71 |
| Refuted / already fixed | 26 |
| After verification — high | 22 |
| medium | 36 |
| low | 13 |

## Must-fix (HIGH severity + auth/data-integrity mediums)

### 1. submissionStatus enum mismatch — four code paths write values not in the schema
- **File:** `serpbays_server/src/api/publisher-website/content-types/publisher-website/schema.json:276-290` (enum) vs `controllers/publisher-website.js:821, 936, 978` and `lifecycles.js:105`
- **Merges:** dev-lifecycle-hooks-1, dev-data-model-1, qa-edge-cases-races-5, qa-ux-error-handling-2
- **Risk:** Strapi rejects `'verified_pending_review'`, `'requires_changes'`, `'under_review'`. The marketplace-creation-failure revert in `approve()` always throws, leaving rows stuck `approved` with `marketplaceId=null` and triggering the `wasJustApproved` lifecycle on every subsequent edit (loop risk). Admin `requestChanges` and `markUnderReview` are 100% broken — every call returns 500.
- **Fix:** Add the three missing values to the schema enum + ship a Strapi migration. Lower-blast-radius than retiring the broken admin actions.
- **Effort:** S
- **Regression risk:** Low.

### 2. Duplicate `async delete` handlers — marketplace cascade is dead code
- **File:** `controllers/publisher-website.js:1258` and `:1772`
- **Merges:** dev-backend-controllers-2, sec-authz-rbac-4, devops-observability-6
- **Risk:** JS object-literal duplicate keys → second wins. The L1258 handler cascades-deletes the marketplace row; the surviving L1772 handler does NOT and refuses anything past `stepCompleted=1`.
- **Fix:** Delete L1258-1317. Merge ownership rules into L1772 and add an explicit marketplace cascade for approved rows.
- **Effort:** S

### 3. POST /api/publisher-websites overwrites approved listing, wipes GSC proof
- **File:** `controllers/publisher-website.js:130-187`
- **Merges:** dev-backend-controllers-1, sec-mass-assignment-2
- **Risk:** A second POST on the same URL by the same publisher (stale tab, retry, hijacked JWT) silently regresses a live GSC-verified listing back to step 1 — forces `gscVerified:false`, `gscVerifiedAt:null`, `gscRefreshToken:null`, `verificationMethod:null`, `submissionStatus='pending_verification'`. The reseller-code use counter burns again.
- **Fix:** Refuse the update branch when status is not in `PUBLISHER_SETTABLE_STATUSES` (409). Don't include verification-reset fields on update. Gate `useCode()` so idempotent retries don't burn uses.
- **Effort:** S

### 4. Wizard fallback creates duplicate publisher-website rows when publisher has >20 listings
- **File:** `serpbays_client/app/(dashboard)/publisher/add-website/page.tsx:651, 674`
- **Merges:** dev-frontend-flow-1, qa-edge-cases-races-3
- **Risk:** GET filter has no `pagination[pageSize]` (default 20). `.find(w => w.url === cleanUrl)` returns undefined past 20; fall-through POST creates a duplicate. Double-clicks have same effect because no DB UNIQUE on `(url, currentPublisherId)`.
- **Fix:** (a) Client: add `'pagination[pageSize]': 100` + `'filters[url][$eq]'` filter; fail closed when wizard loses websiteId. (b) Server: unique DB constraint on `(url, currentPublisherId)`.
- **Effort:** M
- **Regression risk:** Medium — audit `publisher_websites` for existing duplicates before applying the migration.

### 5. update() ownership check missing `!currentPublisherId` guard — cross-user edit on email collision
- **File:** `controllers/publisher-website.js:480-486` (also list-scope L219-258, L308-317)
- **Merges:** sec-authz-rbac-1, sec-authz-rbac-2
- **Risk:** `isOwner = (cur && cur.id===uid) || (email===userEmail)` — email leg fires even when `currentPublisherId` is set. Email recycle → new user can PUT victim's rows and queue admin-approvable update-requests against the live marketplace listing.
- **Fix:** Mirror the strict predicate from findOne/delete/pause/resume/claim. Extract `isPublisherWebsiteOwner(existing, user)`. Apply the same `currentPublisherId: null` clause to the email leg of `find()`'s `$or`.
- **Effort:** S

### 6. Admin /api/admin/websites filters silently overwrites `$or` — userId scope dropped
- **File:** `serpbays_server/src/api/admin/controllers/websites.js:217-326`
- **Merges:** dev-backend-controllers-3
- **Risk:** `filters.$or = ...` is reassigned at L219, L276/L288, L313, L322. Filtering "User 188's sites priced ≥ $50" silently drops the user scope. `$lte` maxPrice also lives at the wrong nesting depth and is silently ignored.
- **Fix:** Use the existing `addAndFilter({ $or: [...] })` helper consistently. Push each multi-clause filter into `filters.$and`. Fix maxPrice `$lte` nesting.
- **Effort:** S

### 7. Concurrent claimOwnership + publisher-update TOCTOU
- **File:** `controllers/publisher-website.js:1446-1647` (claim) and `:465-581` (update)
- **Merges:** qa-edge-cases-races-1, qa-edge-cases-races-2
- **Risk:** (a) Two claimants pass idempotency, both consume proofs, both enter transaction — original row's `claimedBy`/`newOwnerWebsiteId` is last-writer-wins; loser's claim row orphaned. (b) Publisher PUT + admin Approve interleaving lands stale pricing on a now-approved row while skipping the update-request queue.
- **Fix:** Inside each TX, re-fetch with `SELECT ... FOR UPDATE` and abort if status / claimedBy no longer matches. Alternative: honour `claimingInProgress` as a soft-mutex. For update, wrap read+write in a TX with a status predicate on the UPDATE.
- **Effort:** M
- **Regression risk:** Medium — surfaces latent serialization conflicts under bursty load.

### 8. Paused listing keeps marketplaceId pointing at a marketplace transferred to a new owner
- **File:** `lifecycles.js:118-188` and `controllers/publisher-website.js:1381-1440`
- **Merges:** qa-edge-cases-races-4, qa-edge-cases-races-6
- **Risk:** `otherWebsitesToTransfer` filter excludes `listing_paused`. Paused publisher's `marketplaceId` is never nulled when someone else claims their URL. Subsequent `resumeListing` flips that marketplace row back to `status='active'` even though the new owner now owns it. Both publishers can toggle the same listing.
- **Fix:** Widen the lifecycle filter to include `listing_paused`. On every claim approval, NULL `marketplaceId` on every other publisher_website row pointing at the same URL. Add a defensive precondition in `resumeListing`.
- **Effort:** S

### 9. JWT_SECRET falls back to literal hardcoded string
- **File:** `serpbays_server/config/plugins.js:10`
- **Merges:** sec-session-csrf-2, devops-env-config-4
- **Risk:** `env('JWT_SECRET', 'your-secret-key-here')` signs admin and publisher JWTs with the literal default if the env var is unset. Anyone with code-read access can forge a JWT for any user id.
- **Fix:** Hard-fail at boot — throw if `JWT_SECRET` unset or <32 chars. Same for `ADMIN_JWT_SECRET`, `API_TOKEN_SALT`, `TRANSFER_TOKEN_SALT`, `GSC_VERIFY_SHARED_SECRET`, `AUTOSEND_API_KEY`, `CLERK_JWKS_URL`, `CLERK_JWT_ISSUER`. Wire in `src/index.js` bootstrap.
- **Effort:** S
- **Regression risk:** Medium — coordinate with #11 (env.example rewrite) and audit pm2/systemd env first.

### 10. Strapi admin overlay logs full jwtToken to browser console
- **File:** `serpbays_server/src/admin/app.js:268, 280, 301, 321` and `src/admin/app.jsx:270`
- **Merges:** sec-session-csrf-3
- **Risk:** `console.log('Found jwtToken cookie:', jwtTokenCookie)` runs unguarded. DevTools, extensions with debugger permission, screen shares, support sessions all capture a live admin token in plaintext.
- **Fix:** Replace token-touching `console.log` with boolean-presence logs or delete outright. Update both `app.js` AND `app.jsx`. Rebuild admin.
- **Effort:** S

### 11. Strapi JWT stored in JS-readable cookie + localStorage with 7-day TTL, no server revocation
- **File:** `serpbays_client/lib/store/auth.ts:31`, `auth-clerk.ts:38`, `config/plugins.js:7-9`
- **Merges:** sec-session-csrf-1, sec-session-csrf-5, sec-session-csrf-6
- **Risk:** Publisher JWT written to `document.cookie` (not HttpOnly) AND persisted to `localStorage` under `auth-storage`. Any XSS yields a 7-day-valid token. No server-side revocation.
- **Fix:** Move JWT custody to the server (BFF in HttpOnly `__Host-` cookie) OR (preferred — Clerk owns auth) replace long-lived Strapi JWT with short-lived API tokens minted per request. Add `tokenVersion` to `up_users` + embed in JWT. Stage 1: 1-day expiry + tokenVersion + blocklist. Stage 2: BFF migration.
- **Effort:** L
- **Regression risk:** High if rushed.

### 12. Admin create + replaceWebsite let admin set `gscVerified=true` via request-body publisherType
- **File:** `admin/controllers/websites.js:1493-1496, 2663-2666`
- **Merges:** sec-mass-assignment-1
- **Risk:** Admin create/replace reads `publisherType` from body and flips `gscVerified`, `gscVerifiedAt`, `verificationMethod` with no Google round-trip. Stolen admin session can mint fabricated GSC-verified rows.
- **Fix:** Restrict admin to the `reseller` branch for verification-method assignment, OR remove `gscVerified`/`gscVerifiedAt`/`verificationMethod` from these payloads. Add `verifiedBy='admin:<userId>'` so admin-injected verification is auditable.
- **Effort:** S

### 13. Submit-for-Review wizard step swallows backend errors and shows success
- **File:** `serpbays_client/app/(dashboard)/publisher/add-website/page.tsx:664-686`
- **Merges:** qa-ux-error-handling-1, qa-ux-error-handling-3
- **Risk:** `submitForReview()`'s try/catch only `console.error`s the failure; `_handleNextInner` advances to step 4 ("Done") regardless. Publisher sees celebration even though submission never entered the moderation queue.
- **Fix:** Treat PUT as blocking — surface a toast extracting `error.response?.data?.error?.message`, leave `currentStep=3` with Retry, refetch the row to confirm `submissionStatus==='approval_pending'` before showing step 4. Centralise error extractor in `lib/api/client.ts`; replace `alert()` with toast variants.
- **Effort:** S

### 14. Admin approve/reject writes audit fields that don't exist in the schema
- **File:** `admin/controllers/websites.js:1042-1050, 1365-1373, 3759-3765, 3859-3866`
- **Merges:** devops-observability-1, devops-observability-2
- **Risk:** Handlers write `approvedBy`, `rejectedAt`, `rejectedBy`, `adminNotes`, `pausedBy`, `resumedBy` — none exist as schema attributes. Strapi silently strips. The actor of an approve/reject is never persisted on the row.
- **Fix:** Either (a) add the columns with a migration, OR (b) consolidate on the existing `reviewedBy`/`reviewedAt`/`reviewNotes` and remove writes of phantom columns. (b) is the smaller change.
- **Effort:** S–M

## Should-fix (24 items, condensed)

15. Marketplace url uniqueness — schema `unique:true` conflicts with partial canonical index.
16. Approved row with missing marketplaceId silently bypasses the pending-update gate.
17. Update-request approve drops description/publicationLocation back-sync; TAT round/ceil mismatch.
18. Publisher PUT diffs the whole row vs marketplace — sweeps pre-existing drift into update-request.
19. Publisher PUT with resellerCode consumes the counter without setting workflow flags.
20. Resume after pause skips price/metric sync and accepts zeroed prices.
21. Admin general PUT can flip approved→rejected, leaving marketplace live.
22. Admin direct edits write to live data with no per-field before/after captured.
23. `checkClaimable` non-deterministic + allows claiming rejected / pending rows.
24. Whitelist silently drops fields with no client-side signal.
25. publisher-website update dereferences `existing` before null check + leaks raw body via `console.log("dataaa", data)`.
26. Pending update-requests endpoint has no pagination + admin page has no search.
27. .env.example files missing critical variables — fresh deploys silently break.
28. Duplicate nested backend tree at `/var/www/serpbays/serpbays_server/serpbays_server/` — schema-sync incident reproducer.
29. pm2 dump.pm2 last saved before the 2026-06-11 incident — `pm2 resurrect` on reboot replays pre-incident state.
30. `scripts/sync-schema.js` auto-sets the safety override — short-circuits the interlock.
31. Backup cron has no alerting — silent backup failure invisible until needed.
32. CORS origins hardcoded — env-driven `cors.js` is dead code.
33. Three listing-workflow test scripts always exit 0 + hard-coded fixture IDs + GSC secret clobber.
34. Admin POST routes gated by `requires-edit` instead of `requires-create`.
35. Public check-claimable leaks publisherName + verificationMethod, no rate limit.
36-38. Lifecycle nits: `wasJustApproved` re-triggers on missing marketplaceId; placement_speed clobbers admin overrides; commission rate hardcoded in marketplace-sync.

## Nice-to-have (28 items)

Schema hygiene (`marketplaceId`/`originalWebsiteId`/`newOwnerWebsiteId` as scalars, `claimingInProgress` defined but never written, `dataVersion` not enforced as optimistic lock); publisher-side UX (status filter missing 4 of 8 values, stale setState in wizard reload, step-3 submit enabled while invalid, reseller-code typing side-effect, double-fetch on filter, alert() vs toast, 1000ms error-toast); admin-side UX (admin add-website domain status reset, `window.prompt` rejection-reason capture); operability (logging style sweep, bulk-ops audit, stale auth tests, post-recovery row-count comms); minor data-model footguns (description maxLength asymmetry, "Id"-suffix on relations); ops (Nodemailer debug:true leaks email contents to stdout in prod, 77 restarts/21h baseline cadence).

## Refuted / already-fixed

- BC-1, BC-2, QA-1, FE-1, GSC rate limiter, `config/database.js` production safety guard, postgres backup cron, `strapi_ro` role, panel20 session-null bug, stale `dist/` — verified already applied this session, excluded.
- dev-lifecycle-hooks-2 (new sync call's outer try/catch swallow), dev-lifecycle-hooks-8 (speculative observability) — demoted to info.
- qa-happy-path-1..6, qa-regression-suite-5..7 — coverage gaps merged into #33.
- devops-observability-3, devops-observability-7 — folded into nice-to-have logging sweep.
- sec-session-csrf-6 (theoretical CSRF surface) — folded into #11.
- dev-data-model-5/6/8 — schema hygiene; nice-to-have.

## Ordered execution plan

1. **#1** submissionStatus enum extension — unblocks #16, #21, #23 and several admin actions
2. **#2** duplicate delete handler removal
3. **#14** admin audit field schema (coordinate with #1, both schema migrations)
4. **#25** remove `console.log("dataaa", data)`, fix null-check ordering, sweep payload-dump pattern in admin controllers
5. **#10** remove JWT console.logs from `src/admin/app.js` / `app.jsx`
6. **#9** JWT_SECRET hard-fail at boot + other env vars
7. **#27** rewrite `.env.example` for both repos (together with #9)
8. **#32** CORS env-driven
9. **#5** update() ownership check + read-side scope + extract helper
10. **#3** POST overwrite of approved listings
11. **#4** wizard fallback client + UNIQUE constraint (dedup duplicates first)
12. **#6** admin filters `$or` overwrite
13. **#13** Submit-for-Review error surfacing (client)
14. **#12** admin gscVerified mass-assignment
15. **#23** checkClaimable allowlist + deterministic order
16. **#7** TOCTOU on claim + update (wrap in TX, FOR UPDATE)
17. **#8** paused-listing transfer + marketplaceId nulling
18. **#20** resume re-sync + min-price guard
19. **#21** admin general PUT approved→rejected guard
20. **#16** approved+missing marketplaceId backfill/refuse
21. **#17, #18, #19** update-request fidelity + reseller PUT flags + diff-from-body
22. **#22, #26** admin audit + pending-update pagination
23. **#34, #35** admin POST `requires-create` + public check-claimable trim+rate-limit
24. **#11** JWT custody (stage 1: tokenVersion + 1-day expiry; stage 2: BFF)
25. **#15, #24** marketplace URL unique migration + dropped-field warnings (after #33 lands tests)
26. **#28** move nested backend tree + **#29** pm2 save + **#30** sync-schema preflight + **#31** backup alerting — DevOps hardening batch
27. **#33** test infrastructure (exit codes + fixtures + CI runner) — can run parallel to items 1-26
28. Nice-to-have items #36–63 in any order
