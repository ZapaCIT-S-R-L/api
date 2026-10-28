-- Re-emits the current membership state as events. Until now staging had no MEMBERSHIP_EVENTS queue producer, and
-- families made before migration 0009 never had events, so the chat and calls services know none of them. Every
-- event carries the full state of what it describes and consumers apply events idempotently, so re-sending what
-- may already have arrived is safe. Order: members, then connections, then shared kids, then devices.

INSERT INTO membership_outbox (body, created_at)
SELECT json_object('v', 1, 'id', lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'type', 'family.member_added', 'familyId', family_id, 'accountId', account_id, 'role', role,
  'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT family_id, parent_id AS account_id, 'parent' AS role, 0 AS kind FROM family_parents
  UNION ALL
  SELECT family_id, id, 'kid', 1 FROM kids
)
ORDER BY kind, family_id, account_id;

INSERT INTO membership_outbox (body, created_at)
SELECT json_object('v', 1, 'id', lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'type', 'connection.created', 'connectionId', id, 'familyIds', json_array(family_a, family_b),
  'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM family_connections
ORDER BY id;

INSERT INTO membership_outbox (body, created_at)
SELECT json_object('v', 1, 'id', lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'type', 'connection.kid_shared', 'connectionId', connection_id, 'kidAccountId', kid_id,
  'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM connection_shared_kids
ORDER BY connection_id, kid_id;

INSERT INTO membership_outbox (body, created_at)
SELECT json_object('v', 1, 'id', lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'type', 'device.upserted', 'accountId', account_id, 'deviceId', device_id, 'registrationId', registration_id,
  'occurredAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM devices
ORDER BY account_id, device_id;
