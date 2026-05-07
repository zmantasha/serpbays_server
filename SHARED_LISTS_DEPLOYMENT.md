# Shared Lists — Deployment Notes

This feature lets admins curate a list of marketplace sites and share it with customers via a public or private URL. It spans all three repos:

- **`serpbays_server`** — Strapi content types + endpoints
- **`serpbays_admin`** — Admin CRUD UI under `/shared-lists`
- **`serpbays_client`** — Customer-facing route at `/lists/[slug]`

Below is what needs to change before going live.

---

## 1. Environment variables (must set before deploy)

### `serpbays_admin` (Vercel / hosting env)

| Var | Purpose | Required value |
|---|---|---|
| `NEXT_PUBLIC_CLIENT_URL` | Origin where `/lists/[slug]` is hosted on the customer app. The admin uses it to build the share link copied to clipboard and emailed. | `https://app.serpbays.com` (or `https://serpbays.com` if listings live on the marketing host) |

If unset, the admin will copy `http://localhost:3000/lists/<slug>` — links won't work for real customers.

### `serpbays_client` (Vercel / hosting env)

| Var | Purpose | Required value |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Strapi origin. Already used elsewhere in the app. | `https://api.serpbays.com` |

The shared-list page and Clerk-Strapi sync both read this. If misconfigured, the page will show "Loading…" forever.

### `serpbays_server`

No new env vars. Uses the existing JWT secret, bcrypt (in deps), and the existing autosend email service.

---

## 2. Database migration

Strapi auto-creates these tables on first boot after deploy. **Take a Postgres backup beforehand** — the auto-migration is generally safe but a few new tables + one m2m link table per relation will be added:

- `shared_lists`
- `shared_lists_websites_lnk` (m2m → marketplace)
- `shared_lists_shared_with_lnk` (m2m → users)
- `shared_lists_created_by_id_lnk`, `shared_lists_updated_by_id_lnk` (Strapi internal)
- `shared_list_templates`
- `shared_list_templates_created_by_id_lnk`, `_updated_by_id_lnk`

Strapi's content-type schemas live at:
- `src/api/shared-list/content-types/shared-list/schema.json`
- `src/api/shared-list-template/content-types/shared-list-template/schema.json`

If you ever rename or drop fields, do it via a migration — never edit the schema in production hot.

---

## 3. CORS

Already includes the prod hosts (`https://app.serpbays.com`, both panel hosts, staging). No change needed unless you add a new customer-facing origin.

File: `serpbays_server/config/middlewares.ts` → `strapi::cors`.

---

## 4. Rate limiting (caveat for horizontal scaling)

The public endpoint `/api/shared-lists/:slug` uses the existing in-memory `simple-rate-limit` policy at **60 requests/minute/IP**. It's adequate for single-node deploys. **If you ever run multiple Strapi instances behind a load balancer**, swap this for a Redis-backed limiter (or per-instance limits will be permissive in aggregate). The policy file is `src/policies/simple-rate-limit.js` — same module the existing app uses elsewhere.

---

## 5. robots.txt

Customer-facing `/lists/*` is **never indexable** regardless of robots.txt:

- Page metadata sets `<meta name="robots" content="noindex,nofollow,noarchive">`
- Middleware sets `X-Robots-Tag: noindex, nofollow, noarchive` on every `/lists/*` response
- Slugs are 8 base64url chars from `crypto.randomBytes(6)` → ~48 bits of entropy, unguessable

The existing `serpbays_client/public/robots.txt` (currently `Disallow: /` for staging) does not need to change. When you eventually open up the customer site for general indexing in production, only update those lines — the per-route protections we added remain in force.

---

## 6. Clerk → Strapi auth

OAuth-signed-in customers (Google sign-in via Clerk) typically don't have a Strapi `jwtToken` cookie unless they've used the dashboard, so private lists wouldn't load for them. The shared-list page now bridges this automatically:

- On `/lists/[slug]` mount, if Clerk says "signed in" but `getAuthToken()` returns nothing, the page POSTs to the existing `/api/auth/clerk/sync` (same endpoint used by the dashboard), gets a Strapi JWT, stores it via `useAuthStore.setAuth(...)`, then fetches the list.
- Failure is non-fatal — viewer falls through to the friendly "Sign in required" gate with a working **Sign in again** CTA.
- The login form (`app/(auth)/login/login-form.tsx`) and SSO callback (`app/(auth)/sso-callback/page.tsx`) now honor a `?returnTo=<safe-path>` query param so customers come back to the list after signing in.

---

## 7. New email recipient list

The "Send via email" button in the editor uses `strapi.service('api::global.autosend-service').send(...)` — same service that already sends order emails. No new SMTP setup, no new env, no new template files. Verify the autosend service is configured in production before relying on this button.

---

## 8. Production smoke test (post-deploy)

1. Log into `panel20.serpbays.com` (or whatever the prod admin host is).
2. Sidebar → **Shared Lists** → **+ New shared list**.
3. Add 5-10 websites via "Search marketplace" or "Paste domains".
4. Pick **Public**, set markup `+10%`, save → URL gets copied.
5. Open the URL in incognito on `app.serpbays.com/lists/<slug>` — confirm:
   - Header has SerpBays logo + Sign in button.
   - `x-robots-tag: noindex, nofollow, noarchive` in DevTools network tab.
   - Table renders with marked-up prices.
   - Buy now CTA per row links to `/marketplace/<id>`.
   - Multi-select + Add to cart sends items to `/cart`.
6. Edit the list → set a password → reopen URL in incognito → password prompt appears → wrong password shows error → correct password loads list.
7. Edit the list → switch to **Private** → add yourself as recipient → save → open URL while signed out → "Sign in required" → sign in → list loads.
8. Edit the list → enable **Snapshot mode** → click **Take snapshot now** → reopen URL → confirm "Snapshot — values frozen as of <date>" line appears.
9. Edit the list → **Save as template** → reopen any list → confirm template appears in **Apply template…** dropdown.
10. Edit → **Send via email** → enter your own email → confirm it arrives with a working link.

---

## 9. Future hardening (not blockers)

- **Per-recipient pricing**: not built. Customers in `sharedWith` all see the same prices.
- **Snapshot data size**: `shared_list.snapshotData` is a JSON column. For lists of 1000+ sites the row gets bigger; PostgreSQL handles this fine but worth keeping an eye on if usage explodes.
- **Audit log**: only `viewCount` + `lastViewedAt` are tracked. We don't log per-view IP / user-agent. Add a `shared-list-view` content type if you ever need granular analytics.
- **Drag-reorder** uses native HTML5 drag — solid on desktop, won't work on touch. If admins use iPads, replace with `dnd-kit`.
- **Bulk-add cap**: `Select all matching` in the marketplace dialog caps at 500 sites per click. Increase or chunk if real workflows need bigger batches.

---

## 10. Files changed (for reference)

### `serpbays_server`
- `src/api/shared-list/**` — new content type, public controller (`findBySlug`), slug lifecycle, projection helper
- `src/api/shared-list-template/**` — new content type
- `src/api/admin/controllers/shared-lists.js` — admin CRUD + bulk-add + share-email + snapshot
- `src/api/admin/controllers/shared-list-templates.js` — template CRUD
- `src/api/admin/routes/shared-lists.js` — route registration
- `src/api/admin/routes/shared-list-templates.js` — route registration
- `src/api/admin/controllers/marketplace.js` — added `sortField` / `sortDirection`
- `src/policies/is-admin-with-jwt.js` — new combined auth+role policy for the new admin routes
- `src/index.js` — registered the two new admin route files

### `serpbays_admin`
- `src/app/shared-lists/**` — index page + new + edit routes
- `src/components/shared-lists/Editor.tsx` — full editor with all dialogs
- `src/lib/api/admin.ts` — types + API client methods
- `src/lib/permissions.ts` — added `Shared Lists` nav entry
- `src/components/layout/dashboard-sidebar.tsx` — wired the new sidebar entry

### `serpbays_client`
- `app/lists/[slug]/page.tsx` — server route w/ `noindex` metadata
- `app/lists/[slug]/SharedListView.tsx` — full client component
- `app/(auth)/login/login-form.tsx` — honors `?returnTo`
- `app/(auth)/sso-callback/page.tsx` — honors `?returnTo`
- `middleware.ts` — `/lists/*` public route + always-on `X-Robots-Tag` for that path + safe-returnTo bounce on `/login`

— Generated end of session, 2026-05-06.
