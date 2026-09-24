# HarnessOrbit development and acceptance

This branch treats HarnessOrbit as a business-outcome layer over CAO. CAO's
`run.json`, Git snapshots, independent checks, verification evidence and
integration result remain authoritative. Jev is an optional advisory
DecisionProvider and starts in shadow mode.

## Long-running safeguards

- Every implementation story has a durable entry in `.omx/ultragoal/`.
- Provider failures, timeouts, abstains, cancellations, unjudged results and
  missing benchmark rows stay in the denominator.
- Credentials, raw prompts, source contents and terminal output are excluded
  from ContextPacket and decision receipts.
- No provider can mutate run state, permissions, retries, acceptance,
  integration, merge, push or deployment.
- The baseline is rerun after each runtime contract change. The constrained
  test environment may report loopback/process `EPERM`; those are recorded as
  environment-bound failures rather than silently removed.

## Internal comparison

Run the deterministic contract fixture with:

```sh
node scripts/internal-benchmark.mjs --output /tmp/cao-harnessorbit-benchmark.json
```

Run the real paired pilot preflight with:

```sh
npm run benchmark:real -- --version-only --output /tmp/cao-real-pilot.json
```

The branch now includes a first-party runtime entrypoint for the second arm:

```sh
node scripts/harnessorbit-runner.mjs --version
```

It builds a bounded ContextPacket, records context and shadow decision receipts
in the external Project Ledger, strips Jev credentials from the Codex child
environment, and delegates execution to Codex. Acceptance and integration still
come from the benchmark's independent checks and evidence writer.

Execution uses `node scripts/harnessorbit-runner.mjs` as the first-party
HarnessOrbit command, a clean
isolated base checkout, a declared task prompt and the same checks/deadline on
both arms. Without those controls the command returns `status=blocked`, keeps
missing arms in the evaluator denominator, and writes no claim-eligible result.

The fixture pairs seven cases across Pure Codex and Codex + HarnessOrbit:
normal work, blocked permission, provider saturation, retry, scope
violation, verification failure and high-risk work. It is a measurement and
safety harness, not a claim of product benefit. Real controlled runs must use
the same task, base commit, checks and deadline before any rollout decision.

The existing `benchmarks/evaluator.mjs` deliberately reports all planned
trials, classifies incomplete acceptance, and refuses rollout claims. The
internal wrapper adds operational metrics for attempts, blocked duration,
provider recovery, high-risk misses, context size, tokens and cost.

The local Jev credential is configured for the direct TypeSafe endpoint
`https://api.typesafe.ai/v1/systemone` with the pinned `jev-1.13.0` model. The official
Vercel AI Gateway endpoints use a separate gateway credential; their 401 result
is retained as an integration boundary and does not block deterministic CAO
fallback or shadow operation.

## Acceptance gates

1. New and existing tests pass, with sandbox-bound failures listed separately.
2. Jev unavailable produces the deterministic path and the same CAO state
   authority.
3. Shadow receipts are schema-versioned and contain only digests and bounded
   metadata.
4. HarnessOrbit shows a repeatable improvement only after real paired trials;
   synthetic fixtures never satisfy that gate.
5. Final review must be clear, then post-cleaner verification is rerun.

The current verification snapshot is 517/517 full tests and a passing syntax
check. The acceptance report records the earlier restricted-sandbox failures
separately and keeps the real product-benefit gate open.
