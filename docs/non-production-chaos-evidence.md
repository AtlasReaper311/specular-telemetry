# Non-production chaos verification

This branch proves the chaos target contract without contacting the production control endpoint.

## Verified by repository-native tests

- the hidden route is absent when disabled;
- invalid bearer tokens fail closed;
- unsupported faults and durations over 300 seconds are rejected;
- `stale_response` and `webhook_drop` are test-only unless explicitly enabled in an isolated environment;
- an active lease returns HTTP 409 and is not overwritten;
- simultaneous activation in one Worker isolate admits one lease;
- passive logical expiry removes the record and emits recovered evidence;
- explicit deletion emits recovered evidence with a distinct reason;
- the physical KV TTL remains longer than the logical lease so expiry evidence is not immediately discarded.

## Validation boundary

The normal pull-request workflow runs Python detector tests, Worker linting, Node tests, `wrangler deploy --dry-run`, and the pinned Worker metadata contract validator. It does not deploy `specular-edge`, alter secrets or variables, or inject a fault.

The single-controller model remains explicit. Cloudflare KV does not provide compare-and-swap semantics, so cross-isolate global exclusion is not claimed. The protected bearer token, one controller workflow concurrency group, target-side active-lease rejection, and same-isolate serialisation are the current safety layers.
