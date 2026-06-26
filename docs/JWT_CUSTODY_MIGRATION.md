# JWT Custody Migration — Stage 2 Roadmap

**Audit reference:** must-fix item #11 from `docs/WEBSITE_WORKFLOW_AUDIT.md`.
**Status:** design only — Stage 1 (`tokenVersion` revocation) is shipped. Stage 2 is **not implemented**.

## Problem statement

The current SerpBays publisher and admin frontends store the Strapi JWT in two locations:

- `document.cookie` (set from JavaScript, therefore **not** `HttpOnly`)
- `localStorage` under the `auth-storage` key (Zustand `persist` middleware)

Both are readable by any script running on the same origin. The JWT carries a 7-day TTL. **Any XSS in either app — or in any subdomain that can read the cookie — yields a 7-day full-authority session token.**

Stage 1 of finding #11 (now shipped) adds server-side revocation via `up_users.token_version`. This shrinks the exposure window from "7 days, unmitigated" to "7 days OR until next bump". It does not address the root cause: the JWT is reachable from JavaScript.

Stage 2's goal is to make the JWT unreachable from JavaScript while preserving the existing UX (no extra login prompts, no shortened TTL).

## Constraints (from user requirements)

- **Keep 7-day JWT expiry.** No change to session duration.
- **Do not change the user login experience.** Existing OAuth/Clerk login flows must continue to work; no extra screens or prompts.
- **Stage 2 must be drop-in.** Token-version revocation (Stage 1) must continue to work after Stage 2 ships.

## Recommended design — Backend-for-Frontend (BFF) with HttpOnly cookies

### Architecture

```
                Browser
                   │
                   │  fetch('/api/foo')  — no Authorization header
                   │  (browser auto-sends __Host-sb-session cookie)
                   ▼
       ┌───────────────────────────────────┐
       │  Next.js BFF layer                │
       │  (publisher + admin Next.js apps) │
       │                                    │
       │  - Reads HttpOnly session cookie  │
       │  - Looks up the Strapi JWT in     │
       │    server-side session store      │
       │  - Adds Authorization header      │
       │  - Forwards to Strapi             │
       └───────────────┬───────────────────┘
                       │
                       │  Authorization: Bearer <JWT>
                       ▼
                Strapi backend
```

### Cookie attributes (the lockdown)

```
Set-Cookie: __Host-sb-session=<opaque-session-id>;
            Path=/;
            HttpOnly;        ← JS can't read it
            Secure;          ← HTTPS-only transmission
            SameSite=Lax;    ← blocks cross-site CSRF on POST/PUT/DELETE
            Max-Age=604800;  ← 7 days (matches Strapi JWT TTL)
```

The `__Host-` prefix mandates:
- `Path=/`
- `Secure` set
- **No `Domain` attribute** — so the cookie is bound to the exact origin (publisher app cannot read admin's cookie, even within `*.serpbays.com`)

### Cookie value: opaque session id, NOT the JWT itself

The browser cookie carries a short random opaque id (e.g. `crypto.randomBytes(32).toString('base64url')`). The Next.js BFF maps this id to the actual Strapi JWT via a server-side store:

| Store option | Pros | Cons |
|---|---|---|
| **Postgres table** (`bff_sessions`: `id`, `user_id`, `jwt`, `expires_at`) | One source of truth; auditable; integrates with existing pg-backup cron | Per-request DB lookup; needs a tiny LRU cache in the BFF |
| **Redis** | Sub-ms lookup; native TTL | New infra dependency (not yet in stack) |
| **In-memory** (Node `Map`) | Zero infra | Restart-loss (incident class we just fixed); not viable per `RECOVERY.md` |

**Recommendation:** Postgres table + in-process LRU cache. Reuses existing infrastructure; survives Strapi restarts; integrates with the existing safety guard.

### Auth flow after migration

1. **Login (Clerk session exchange):**
   - User completes Clerk auth → Next.js receives the Clerk session
   - Next.js calls Strapi's `/api/auth/clerk` (existing endpoint) to mint a Strapi JWT
   - Next.js stores the JWT in `bff_sessions` with a random session id
   - Next.js responds to the browser with `Set-Cookie: __Host-sb-session=<id>`
   - **The Strapi JWT never reaches the browser.**

2. **Authenticated request:**
   - Browser sends cookie automatically
   - BFF reads `__Host-sb-session` cookie → looks up the JWT
   - BFF forwards the request to Strapi with `Authorization: Bearer <JWT>`
   - Response streamed back to browser

3. **Logout:**
   - Browser POSTs to `/api/auth/logout` (BFF endpoint)
   - BFF deletes the `bff_sessions` row AND calls Strapi's existing `/api/auth/logout` to bump `tokenVersion` (Stage 1 revocation)
   - BFF responds with `Set-Cookie: __Host-sb-session=; Max-Age=0` (clears cookie)

### CSRF protection

`SameSite=Lax` blocks cross-site CSRF on `POST`/`PUT`/`DELETE`/`PATCH` for top-level navigations and form submits. For state-changing `fetch()` calls, browsers also send the cookie only on same-site requests by default — but defense-in-depth recommends:

- **Synchronizer token pattern:** BFF issues a CSRF token (separate non-HttpOnly cookie `__Host-sb-csrf`) on login. Frontends must include the same token in an `X-CSRF-Token` header on state-changing requests. BFF rejects mismatches.

CSRF token can rotate weekly (independent of JWT TTL).

## Migration steps

Each step is independently shippable and reversible. Run in order; gate progression on production canary metrics.

### Step 1 — Build the BFF layer (Next.js API routes)

Files to add (both publisher app and panel20):

```
app/api/auth/login/route.ts        — Clerk → BFF session exchange
app/api/auth/logout/route.ts       — invalidate BFF session + Strapi tokenVersion bump
app/api/auth/refresh/route.ts      — extend BFF session if Strapi JWT is near-expiry
app/api/[...proxy]/route.ts        — generic forward-to-Strapi proxy (adds Authorization)
lib/bff/sessions.ts                — Postgres + LRU session store
lib/bff/cookie.ts                  — __Host- cookie helpers
middleware.ts                      — attach session-id to requests + CSRF check
```

DB migration (Strapi-side):

```sql
CREATE TABLE bff_sessions (
  id            VARCHAR(64) PRIMARY KEY,         -- opaque session id
  user_id       INTEGER NOT NULL REFERENCES up_users(id) ON DELETE CASCADE,
  jwt           TEXT NOT NULL,                    -- Strapi JWT (server-side only)
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMP NOT NULL,
  user_agent    TEXT,                             -- optional, for audit
  ip            VARCHAR(64)                       -- optional, for audit
);
CREATE INDEX bff_sessions_user_id_idx ON bff_sessions (user_id);
CREATE INDEX bff_sessions_expires_at_idx ON bff_sessions (expires_at);
```

Cron job: delete expired `bff_sessions` rows daily.

**Effort:** 1 engineer × 1 week per app (publisher + admin).

### Step 2 — Roll out behind a feature flag

Add `NEXT_PUBLIC_USE_BFF_AUTH=false` env var. Initial default: false. Routes check the flag — when false, fall back to the current localStorage/cookie behaviour.

Deploy and verify both paths coexist. No user impact.

### Step 3 — Canary the BFF path

Enable `NEXT_PUBLIC_USE_BFF_AUTH=true` for staging. Monitor for 1 week:

- Login success rate
- 401 rate on authenticated endpoints
- Session-store latency (Postgres p99 must be < 5 ms)
- BFF process memory (LRU cache size)

### Step 4 — Production rollout

Enable BFF auth in production via the feature flag. Existing user sessions still use the localStorage path until they next log out + log in (their JWT remains valid for up to 7 days). New logins use BFF.

After 7+ days, all active sessions are BFF-backed. No forced-logout event.

### Step 5 — Remove the localStorage / JS-cookie code paths

Delete:
- `lib/store/auth.ts` Zustand `partialize` persistence
- `lib/store/auth-clerk.ts` JWT-to-cookie write
- Every `localStorage.getItem('auth-storage')` site
- Every `document.cookie` write for `jwtToken=`

Frontend now has zero JavaScript-readable JWT.

### Step 6 — Tighten cookies further

Once BFF is the only auth path:

- Issue a `__Host-sb-csrf` cookie (non-HttpOnly, used by frontend JS to read + echo in `X-CSRF-Token`)
- Optional: rotate BFF session id on every privileged action (defence against session-fixation)

## What Stage 2 does NOT change

- **JWT expiry stays 7 days.** Strapi config unchanged.
- **Login UX is identical.** Clerk flows, password reset flows, OAuth flows all unchanged from the user's perspective.
- **`tokenVersion` revocation (Stage 1) keeps working.** BFF's logout endpoint calls the existing `/api/auth/logout` to bump `tokenVersion`. Admin revoke endpoint unchanged.
- **Existing Strapi API surface unchanged.** Strapi continues to accept `Authorization: Bearer <JWT>`. The BFF just becomes the only caller from the browser path.

## Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| BFF becomes a single point of failure | M | Postgres-backed sessions survive Next.js restarts; deploy multi-instance Next.js with load balancer |
| Session store latency adds per-request overhead | L | LRU cache (1k–5k entries) + Postgres index hits; p99 should stay sub-5ms |
| Migration breaks existing sessions | H | Feature flag rollout; old path stays live during canary; force-logout only at final cleanup |
| CSRF token desync after long idle | L | Token TTL longer than typical idle (1 week); refresh on every BFF response |
| Cookie clobbered by another `*.serpbays.com` subdomain | L | `__Host-` prefix mandates no Domain attribute, scoping to exact origin |

## Estimated effort

| Step | Effort |
|---|---|
| 1. Build BFF (publisher + admin) | 2 engineer-weeks |
| 2. Feature flag + dual-path | 2 engineer-days |
| 3. Staging canary + monitoring | 1 engineer-week (mostly observation) |
| 4. Production rollout | 1 engineer-day |
| 5. Remove old code paths | 3 engineer-days |
| 6. CSRF + session-id rotation hardening | 1 engineer-week |
| **Total** | **5–6 engineer-weeks** |

## Acceptance criteria

When Stage 2 is complete:

- `grep -r "localStorage.*token\|document\.cookie.*jwt" serpbays_client serpbays-adminpanel/serpbays_admin/src` returns zero hits.
- Browser DevTools → Application → Cookies shows only `__Host-sb-session` (HttpOnly, Secure, SameSite=Lax) and `__Host-sb-csrf` (non-HttpOnly, Secure, SameSite=Strict).
- A test XSS injection (sandbox only) that reads `document.cookie` and `localStorage.getItem('auth-storage')` cannot lift a JWT.
- `tokenVersion` revocation still works end-to-end (the existing regression test `scripts/test-token-version.js` continues to pass).

## References

- Audit report: `docs/WEBSITE_WORKFLOW_AUDIT.md` finding #11
- Stage 1 implementation:
  - `src/extensions/users-permissions/strapi-server.js` (JWT verify wrap + lifecycle bump + helper)
  - `src/api/auth/controllers/session.js` + `src/api/auth/routes/session.js` (logout + revoke endpoints)
  - `database/migrations/2026.06.15T00.00.00.add-up-users-token-version.js` (schema migration)
  - `scripts/test-token-version.js` (regression test)
- OWASP cheat sheet: [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [JWT for Java](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
