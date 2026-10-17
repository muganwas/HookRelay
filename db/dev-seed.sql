insert into app.tenants (id, name)
values ('11111111-1111-4111-8111-111111111111', 'Acme Inc');

insert into app.endpoints (id, tenant_id, url, secret, subscribed_events)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'https://example.test/hooks',
  'whsec_dev_123',
  array['order.created', 'order.refunded']
);

insert into app.events (id, tenant_id, type, payload, idempotency_key)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'order.created',
  '{"orderId":"ord_1","amount":4999}'::jsonb,
  'idem-001'
);

insert into app.deliveries (id, event_id, endpoint_id, next_attempt_at)
values (
  '44444444-4444-4444-8444-444444444444',
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  now()
);