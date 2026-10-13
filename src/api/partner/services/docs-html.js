'use strict';

// Public docs for the Serpbays customer API (served at /api/v1/docs). 2026-10-13
module.exports = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Serpbays API · Sites catalog</title><meta name="robots" content="noindex">
<style>
:root{--fg:#0f172a;--mut:#64748b;--bd:#e2e8f0;--bg:#fff;--code:#f8fafc;--acc:#e05e00}
@media (prefers-color-scheme:dark){:root{--fg:#e2e8f0;--mut:#94a3b8;--bd:#1e293b;--bg:#0b1120;--code:#111827;--acc:#ff8a3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{margin-top:36px;font-size:20px;border-top:1px solid var(--bd);padding-top:24px}
h3{font-size:16px;margin:24px 0 6px}p,li{color:var(--fg)}.mut{color:var(--mut)}code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);border:1px solid var(--bd);border-radius:8px;padding:12px;overflow-x:auto}code{background:var(--code);padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--bd);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600}
.m{display:inline-block;background:var(--acc);color:#fff;border-radius:4px;padding:0 6px;font-size:12px;font-weight:700;margin-right:6px}
</style></head><body><main>
<h1>Serpbays API</h1><p class="mut">Read-only access to every site listed on the Serpbays marketplace, with live buyer prices. Version 1.</p>

<h2>Authentication</h2>
<p>Every request needs your API key. Keys are issued by the Serpbays team; keep yours secret.</p>
<pre>curl https://api.serpbays.com/api/v1/sites \\
  -H "Authorization: Bearer sbk_live_YOUR_KEY"</pre>
<p><code>X-API-Key: sbk_live_YOUR_KEY</code> works too. All responses are JSON. Prices are in USD.</p>

<h2>Limits</h2>
<p>Each key has a per-minute and a per-day request limit (default 60 per minute and 10,000 per day). Every response tells you where you stand:</p>
<table><tr><th>Header</th><th>Meaning</th></tr>
<tr><td><code>X-RateLimit-Limit</code> / <code>X-RateLimit-Remaining</code> / <code>X-RateLimit-Reset</code></td><td>Requests per minute, how many are left, and when the window resets (Unix time)</td></tr>
<tr><td><code>X-Daily-Limit</code> / <code>X-Daily-Remaining</code></td><td>Requests per day (resets 00:00 UTC) and how many are left</td></tr></table>
<p>Some keys can also fetch only a set number of <b>different sites per day</b> (fetching a site again the same day is free). Headers <code>X-Sites-Daily-Limit</code> and <code>X-Sites-Daily-Remaining</code> show where you are; <code>/v1/me</code> shows your limits.</p>
<p>Over a limit you get <code>429</code>. Wait for the reset and retry.</p>

<h2>Endpoints</h2>
<h3><span class="m">GET</span>/api/v1/sites</h3>
<p>Live sites, 50 per page by default (max 100).</p>
<table><tr><th>Parameter</th><th>Example</th><th>What it does</th></tr>
<tr><td><code>page</code>, <code>per_page</code></td><td>2, 100</td><td>Pagination</td></tr>
<tr><td><code>sort</code>, <code>order</code></td><td>dr, desc</td><td>Sort by <code>dr</code>, <code>da</code>, <code>traffic</code>, <code>price</code>, <code>updated</code>, <code>created</code> or <code>id</code>; <code>asc</code> or <code>desc</code></td></tr>
<tr><td><code>dr_min</code>, <code>dr_max</code>, <code>da_min</code>, <code>da_max</code></td><td>50, 90</td><td>Authority range</td></tr>
<tr><td><code>traffic_min</code>, <code>traffic_max</code></td><td>10000</td><td>Monthly organic traffic</td></tr>
<tr><td><code>price_min</code>, <code>price_max</code></td><td>50, 300</td><td>Guest post price (USD)</td></tr>
<tr><td><code>category</code>, <code>language</code>, <code>country</code></td><td>Finance, English, US</td><td>Text match on categories / languages / countries (country also matches the top-traffic country code)</td></tr>
<tr><td><code>domain</code></td><td>techcrunch</td><td>Domain contains</td></tr>
<tr><td><code>niche</code></td><td>casino, crypto, cbd, dating</td><td>Only sites that accept that niche</td></tr>
<tr><td><code>link_insertion</code>, <code>assured</code></td><td>true</td><td>Only sites offering link insertion / with Assured Placement</td></tr>
<tr><td><code>updated_since</code>, <code>listed_since</code></td><td>2026-10-01T00:00:00Z</td><td>Only sites changed / newly listed since that time; use this to keep your copy in sync</td></tr></table>
<pre>curl "https://api.serpbays.com/api/v1/sites?dr_min=50&amp;category=Finance&amp;sort=price&amp;order=asc&amp;per_page=20" \\
  -H "Authorization: Bearer sbk_live_YOUR_KEY"</pre>
<h3>Response</h3>
<pre>{
  "data": [{
    "id": 35698,
    "domain": "example.com",
    "metrics": { "dr": 72, "da": 65, "traffic": 120000, "traffic_source": "ahrefs", "top_country": "US", "top_country_share": 61, "spam_score": 1 },
    "categories": ["Business", "Finance"], "languages": ["English"], "countries": ["United States"],
    "prices": { "currency": "USD", "guest_post": 149, "link_insertion": 99,
                "casino": { "guest_post": null, "link_insertion": null }, "crypto": { "guest_post": 250, "link_insertion": null },
                "cbd": { "guest_post": null, "link_insertion": null }, "dating": { "guest_post": null, "link_insertion": null } },
    "link": { "type": "Do follow", "dofollow": "1", "validity": "Lifetime", "sponsored": false, "ugc": false },
    "turnaround_days": 7, "min_words": 500, "digital_pr": false, "assured_placement": true,
    "guidelines": "…", "sample_links": ["https://example.com/sample-post"],
    "url": "https://app.serpbays.com/marketplace/35698",
    "price_updated_at": "2026-09-21T10:00:00Z", "updated_at": "2026-10-12T08:00:00Z", "listed_at": "2025-12-10T09:00:00Z"
  }],
  "meta": { "page": 1, "per_page": 20, "total": 1834, "total_pages": 92 }
}</pre>
<p class="mut">A price of <code>null</code> means that service is not offered on that site.</p>

<h3><span class="m">GET</span>/api/v1/sites/{id}</h3><p>One site, same shape as above. <code>404</code> if it is not live.</p>
<h3><span class="m">GET</span>/api/v1/categories</h3><p>Every category with the number of live sites in it.</p>
<h3><span class="m">GET</span>/api/v1/me</h3><p>Your key's label, limits and today's usage.</p>

<h2>Errors</h2>
<table><tr><th>Status</th><th>code</th><th>Meaning</th></tr>
<tr><td>400</td><td>bad_request</td><td>A parameter is wrong; the message says which</td></tr>
<tr><td>401</td><td>missing_key / invalid_key / key_revoked / key_expired</td><td>Check your key or ask Serpbays for a new one</td></tr>
<tr><td>404</td><td>not_found</td><td>No live site with that id</td></tr>
<tr><td>429</td><td>rate_limited / daily_limit / daily_site_limit</td><td>Slow down; see the limit headers</td></tr>
<tr><td>500</td><td>server_error</td><td>Our side; retry in a moment</td></tr></table>
<pre>{ "error": { "code": "invalid_key", "message": "This API key is not valid." } }</pre>

<h2>Keeping a local copy in sync</h2>
<ol><li>First run: page through <code>/api/v1/sites?per_page=100&amp;sort=id&amp;order=asc</code>.</li>
<li>Then every few hours: <code>/api/v1/sites?updated_since=&lt;time of your last run&gt;&amp;per_page=100</code>.</li>
<li>Sites that disappear from the list were paused or removed; check them with <code>/api/v1/sites/{id}</code> (404 = no longer live).</li></ol>
<p class="mut">Questions or a higher limit: contact your Serpbays account manager.</p>
</main></body></html>`;
