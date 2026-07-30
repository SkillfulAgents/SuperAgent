insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, email_change,
  email_change_token_new, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'authenticated', 'authenticated',
  'e2e-owner@test.io',
  crypt('e2epassword', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"E2E Owner","display_name":"E2E Owner"}',
  now(), now(), '', '', '', ''
) on conflict (id) do nothing;

insert into public.organization (id, name, plan, status)
values ('org_11111111-1111-1111-1111-111111111111', 'E2E Org', 'pro', 'active')
on conflict (id) do nothing;

insert into public.subscribed_member (id, user_id, org_id, role, tier, status)
values (
  'sub_22222222-2222-2222-2222-222222222222',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'org_11111111-1111-1111-1111-111111111111',
  'owner', 'pro', 'active'
) on conflict (id) do nothing;

insert into public.access_key (id, member_id, key, label, client_instance_id, created_at)
values (
  'ak_33333333-3333-3333-3333-333333333333',
  'sub_22222222-2222-2222-2222-222222222222',
  'plat_sa_e2e_deadbeefdeadbeefdeadbeefdeadbeef',
  'E2E Key', null, now()
) on conflict (key) do nothing;

insert into public.org_deployment
  (org_id, deployment_id, provider, desired_state, status, deployment_url)
values (
  'org_11111111-1111-1111-1111-111111111111',
  'e2e-local', 'k8s', 'present', 'deployed', 'http://127.0.0.1:8899'
) on conflict (org_id, deployment_id) do update
  set status = excluded.status, deployment_url = excluded.deployment_url,
      provider = excluded.provider, desired_state = excluded.desired_state;
