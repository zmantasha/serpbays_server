# nginx vhost audit copies

This directory holds tracked reference copies of nginx vhost files used by
SerpBays in production. **They are not deployed automatically.** The source of
truth lives on the production host at `/etc/nginx/sites-available/`.

## Files

- `prod-cms.serpbays.conf` — Strapi API vhost (`prod-cms.serpbays.com`),
  proxying to `localhost:1338`.

## Purpose

nginx configuration on the prod box is not managed by an IaC tool. Keeping a
mirror here lets backend changes that depend on a matching nginx limit
(for example, `strapi::body` jsonLimit aligned with nginx
`client_max_body_size`) be reviewed together in a single PR, and gives future
devs a tracked reference of what the live vhost should look like.

## Deploy procedure

After merging an edit to a file in this folder, run on the prod host:

```bash
# Snapshot the current live file in case you need to roll back
sudo cp /etc/nginx/sites-available/prod-cms.serpbays.conf \
        /tmp/prod-cms.serpbays.conf.bak.$(date +%s)

# Copy the new version into place
sudo cp /var/www/serpbays-app-server/deploy/nginx/prod-cms.serpbays.conf \
        /etc/nginx/sites-available/prod-cms.serpbays.conf

# Validate syntax BEFORE reloading — reload will refuse if test fails
sudo nginx -t

# Zero-downtime reload (in-flight requests finish on the old worker)
sudo nginx -s reload
```

## Drift check

If you suspect the live file and the tracked copy have diverged, diff them:

```bash
diff /etc/nginx/sites-available/prod-cms.serpbays.conf \
     /var/www/serpbays-app-server/deploy/nginx/prod-cms.serpbays.conf
```

Any unexpected output means either the live file has been hand-edited without
updating this copy, or this copy has been updated without deploying — reconcile
before making further changes.
