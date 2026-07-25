# Specular chaos control contract

The hidden `/specular/__chaos` route exists only to support bounded Atlas Systems assurance experiments. It is absent unless `CHAOS_ENABLED` is the literal value `true`, and every request requires the configured bearer token.

## Capability classes

The target distinguishes two capability classes.

### Policy-authorised live faults

- `status_503`
- `latency`
- `kv_write_reject`

These are the only faults declared by `atlas-infra/policy/chaos-experiments.json`.

### Test-only target hooks

- `stale_response`
- `webhook_drop`

These hooks remain available for Worker unit tests and isolated non-production validation. The control endpoint rejects them unless `CHAOS_ALLOW_TEST_FAULTS` is the literal value `true`. No production configuration is required or expected for that switch.

## Lease lifecycle

Only one lease may be active in a Worker isolate. A second activation receives HTTP 409 and cannot replace the existing record. Activation requests are serialised within the isolate before the active-lease check and KV write.

Cloudflare KV does not provide a compare-and-swap primitive. The bearer-token boundary, the single `atlas-infra` workflow concurrency group, and the in-isolate serialisation form the current controller model. A future multi-controller design would require a linearizable coordinator such as a Durable Object rather than claiming KV provides a global lock.

Each accepted lease has a logical `expires_at` bound. `currentChaos()` treats an expired or malformed lease as inactive, deletes it, and emits recovery evidence on the first control or telemetry request that observes the expiry. The physical KV TTL is deliberately longer than the logical lease so that event-driven expiry can still produce that recovery record.

Explicit `DELETE` rollback emits recovery evidence with reason `explicit_delete`. Passive expiry emits the same recovered phase with reason `lease_expired`. An invalid stored expiry is removed fail-closed with reason `invalid_expiry`.

## Non-production proof

`npm test` verifies:

- disabled mode returns 404;
- invalid authentication returns 401;
- unsupported and overlong faults return 422;
- test-only hooks require the explicit switch;
- active leases cannot be overwritten;
- concurrent same-isolate activation admits one lease;
- passive expiry deletes the lease and emits recovery evidence;
- explicit rollback emits separately identified recovery evidence.

`npm run lint` and `wrangler deploy --dry-run` remain the repository-native syntax, bundle, and Worker contract checks. These checks do not deploy the Worker or inject a live fault.
