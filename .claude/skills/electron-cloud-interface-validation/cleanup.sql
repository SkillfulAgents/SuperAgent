-- Remove everything seed.sql created, plus the OIDC client the ops env-bundle
-- registered. Safe to re-run. Order matters (FK dependencies).
--
-- Every id here is a fixed literal from seed.sql, so this can never delete a
-- real org: it only ever matches the e2e fixtures.

delete from public.oidc_client
  where client_id = 'superagent-org-org_11111111-1111-1111-1111-111111111111';

delete from public.org_deployment
  where org_id = 'org_11111111-1111-1111-1111-111111111111';

delete from public.access_key
  where member_id = 'sub_22222222-2222-2222-2222-222222222222';

delete from public.subscribed_member
  where id = 'sub_22222222-2222-2222-2222-222222222222';

delete from public.organization
  where id = 'org_11111111-1111-1111-1111-111111111111';

delete from auth.users
  where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

-- Verification: every count must be 0.
select
  (select count(*) from public.organization    where id      like 'org_11111111%') as orgs,
  (select count(*) from public.org_deployment  where org_id  like 'org_11111111%') as deployments,
  (select count(*) from public.oidc_client     where client_id like '%org_11111111%') as clients,
  (select count(*) from auth.users             where email = 'e2e-owner@test.io')  as users;
