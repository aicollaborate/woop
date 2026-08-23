# Flowix–DSH compatibility contract

## Baseline

The permanent compatibility baseline is Flowix 1.2.1 with DSH Host 1.0.0.
The wire value `protocolVersion: 1` is a fixed format marker for this contract,
not a commitment to maintain parallel v1/v2 implementations.

Both sides must keep the baseline working:

- A newer DSH Host accepts requests emitted by Flowix 1.2.1.
- A newer Flowix accepts responses and events emitted by DSH Host 1.0.0.
- A newer Flowix checks capabilities before using optional behavior and falls
  back when an older DSH Host does not advertise it.
- A newer DSH Host keeps the methods, required fields, event meanings, and
  terminal behavior used by Flowix 1.2.1.

The baseline host capabilities are:

```text
model-catalog
model-discovery
plugin-catalog
runtime-profile
```

## Evolution rules

- Existing methods, required fields, response shapes, and event meanings are
  append-only and must not be changed incompatibly.
- New request and response fields must be optional. Receivers ignore unknown
  fields, events, and capabilities.
- New methods, notifications, and capabilities may be added.
- Capability names are stable once published; behavior requiring a new
  capability must not be inferred from a Flowix or DSH product version.
- Internal Harness, Cordis, profile, and runtime changes stay behind
  `dsh-host`; they are not part of the Flowix wire contract.

Only introduce `protocolVersion: 2` if a future semantic change cannot be
adapted inside `dsh-host` while preserving this baseline. A product release by
itself is never a reason to increment the protocol marker.

## Release gates

Every DSH package must pass the offline sequence below before publication and
again before Flowix activates an installed version:

```text
host.initialize
runtime.ensure
runtime.bridge.capabilities
runtime.dispose
host.shutdown
```

The package manifest, `dsh-runtime.json`, and `host.initialize` result must
agree on protocol and build identity. Compatibility CI covers the baseline
client against the current host, the current client against the baseline host,
and current against current.
