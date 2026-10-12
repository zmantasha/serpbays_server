-- Reporting views: same columns as the real tables, minus accounts tagged "internal"
-- (latest user_tags entry in admin_audit_logs). Dashboard / analytics / wallets
-- read these via search_path; the real tables are untouched.
begin;
create schema if not exists reporting;

create or replace view reporting.test_user_ids as
  select x.user_id from (
    select distinct on (tl.user_id) tl.user_id, a.details
      from public.admin_audit_logs a
      join public.admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id = a.id
     where a.action = 'user_tags'
     order by tl.user_id, a.created_at desc, a.id desc
  ) x
  where coalesce(x.details->'tags', '[]'::jsonb) @> '["internal"]'::jsonb;

create or replace view reporting.up_users as
  select u.* from public.up_users u where u.id not in (select user_id from reporting.test_user_ids);

create or replace view reporting.user_wallets as
  select w.* from public.user_wallets w
   where not exists (select 1 from public.user_wallets_users_permissions_user_lnk l
                      where l.user_wallet_id = w.id and l.user_id in (select user_id from reporting.test_user_ids));

create or replace view reporting.transactions as
  select t.* from public.transactions t
   where not exists (select 1 from public.transactions_users_permissions_user_lnk l
                      where l.transaction_id = t.id and l.user_id in (select user_id from reporting.test_user_ids))
     and not exists (select 1 from public.transactions_user_wallet_lnk wl
                       join public.user_wallets_users_permissions_user_lnk ul on ul.user_wallet_id = wl.user_wallet_id
                      where wl.transaction_id = t.id and ul.user_id in (select user_id from reporting.test_user_ids));

create or replace view reporting.orders as
  select o.* from public.orders o
   where not exists (select 1 from public.orders_advertiser_lnk l
                      where l.order_id = o.id and l.user_id in (select user_id from reporting.test_user_ids));

create or replace view reporting.withdrawal_requests as
  select w.* from public.withdrawal_requests w
   where not exists (select 1 from public.withdrawal_requests_publisher_lnk l
                      where l.withdrawal_request_id = w.id and l.user_id in (select user_id from reporting.test_user_ids));

grant usage on schema reporting to :"appuser";
grant select on all tables in schema reporting to :"appuser";
commit;

-- 12 Oct 2026: test_user_ids = "internal" tag OR test-looking username (+/test/demo/dummy) without a "not-test" tag.
create or replace view reporting.test_user_ids as
  with latest as (
    select distinct on (tl.user_id) tl.user_id, coalesce(a.details->'tags', '[]'::jsonb) tags
      from public.admin_audit_logs a
      join public.admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id = a.id
     where a.action = 'user_tags'
     order by tl.user_id, a.created_at desc, a.id desc)
  select u.id as user_id from public.up_users u left join latest l on l.user_id = u.id
   where coalesce(l.tags, '[]'::jsonb) @> '["internal"]'::jsonb
      or (u.username ~* '(\+|test|demo|dummy)' and not coalesce(l.tags, '[]'::jsonb) @> '["not-test"]'::jsonb);
