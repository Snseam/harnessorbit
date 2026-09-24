# HarnessOrbit acceptance evidence

Date: 2026-09-24 (Asia/Shanghai)

This report records the evidence for the CAO branch integration. It keeps
implementation facts, observed measurements, statistical claims and unknowns
separate.

## Implementation facts

- `DecisionProvider` is optional and advisory. Shadow mode is the default;
  online mode requires deterministic low-risk eligibility and an explicit
  caller opt-in before an advisory rank is recorded.
- Jev failures, timeouts, missing configuration and invalid responses use the
  deterministic provider. No provider path owns permissions, retries, run
  acceptance, integration, merge, push or deployment.
- The Jev adapter follows the official Vercel Evaluation HTTP shape: model
  `typesafe-ai/jev`, bounded structured `state`, named `choice` questions with
  criteria, and `answers`/usage/provider metadata parsing. Provider cost is
  normalized into the receipt when the gateway returns a numeric or numeric
  string value.
- `ContextPacket` contains bounded Git metadata and digests. `ProjectLedger`
  is external to the project, append-only and metadata-sanitized. The ledger
  refuses a state root inside the project tree.
- `run.json` remains the run authority. Runtime events, `RunApi`, workflow
  reports and decision receipts are versioned and bounded.
- `release-readiness` reports `accepted`, `blocked` or `unknown` from task
  attempts, independent checks and integration evidence.

## Verification evidence

| Check | Result | Boundary |
| --- | --- | --- |
| Initial restricted sandbox `npm test` | 465/492 passed, 27 failed | Existing loopback `listen EPERM` gateway/monitor tests and two process-tree timeout tests; no new HarnessOrbit test failed |
| Latest full `npm test` | **517/517 passed** | Full suite after boundary hardening, ledger hooks, real-pilot harness additions and direct TypeSafe Jev adapter coverage, zero failures/cancellations |
| `npm run check` | **passed** | Syntax checks for 134 modules |
| New/changed targeted tests | **passed** | Focused decision, adaptive, context/ledger, benchmark, runtime, replay, workflow, performance and real-pilot tests |
| CLI smoke | **passed** | `harness init`, `harness replay`, `harness benchmark` |
| Exact configured Jev secret scan | **clean** | `.env.local` ignored, mode `0600`, not tracked; the value is never printed or committed |
| Official Jev gateway probe | **TypeSafe direct passed; Vercel gateway rejected** | `api.typesafe.ai/v1/models` and `/v1/systemone` returned 200 with pinned `jev-1.13.0`; Vercel `/v1/evaluate` and `/typesafe/v1/systemone` returned 401. Sanitized evidence is in `work/real-benchmark/jev-probe-2026-09-24.json` |

## Internal comparison

The deterministic contract fixture ran 42 planned trials: 21 Pure Codex and
21 Codex + HarnessOrbit, with the same task definition, base fixture commit,
 checks and 6000 ms deadline. It includes normal, blocked, provider
 saturation, retry, scope, verification and high-risk cohorts.

All timing and acceptance fields below have `metricSource=synthetic-contract-fixture`
and `observed=false`; they are plumbing measurements until a real trial supplies
receipt, commit, check-log, snapshot, verification and integration references.

Observed fixture metrics:

- Pure Codex: mean duration 2491 ms, blocked duration 15060 ms, 3 human
  interventions, provider recovery 0/3, accepted/integrated 6/21, and
  `projectAcceptance=unknown` 6/21. Mean time to accepted/integrated was
  1670 ms among the accepted fixture rows.
- Codex + HarnessOrbit: mean duration 1253 ms, blocked duration 2610 ms, 0
  human interventions, provider recovery 3/3, 25 ms mean decision latency,
  3780 input tokens and 42 cents modeled cost. Accepted/integrated was 6/21,
  `projectAcceptance=unknown` was 0/21, and mean time to accepted/integrated
  was 1330 ms among the accepted fixture rows.
- Both arms had zero high-risk misses.

The fixture is marked `deterministic-contract-simulation` and
`claimEligible=false`. These numbers validate measurement and safety plumbing;
they do not establish a product benefit. A real paired Codex experiment is
required before changing the default strategy.

The latest real-pilot preflight is archived at
`work/real-benchmark/preflight-2026-09-24.json`. It is `status=blocked` with Codex CLI
`0.156.1` available and a clean base commit, while the HarnessOrbit command is
not configured. The task prompt and `npm run check` control are present, but
execution was not requested, so the report retains both arms in the denominator
and does not execute a product comparison. No real HarnessOrbit benefit claim
is made.

The Jev credential probe is a separate external boundary. The supplied
credential is accepted by TypeSafe's direct API and the adapter completed a
bounded live shadow decision; the Vercel AI Gateway endpoints require a
different AI Gateway credential and returned HTTP 401. The live Jev result is
not a HarnessOrbit benefit claim. The adapter remains shadow-first and does
not change deterministic selection authority.

The generated ContextPacket now uses one canonical digest for creation and
verification. Runtime event reads reject cross-run identities, decision digests
cover all material receipt fields, and a full append-only ledger returns the
authoritative workflow report with `ledgerEvidenceIncomplete=true` instead of
failing the evaluation.

## Acceptance boundary

The branch is implementation-ready and full-suite verified. Product-benefit
acceptance remains intentionally open until real controlled paired runs are
executed with the declared controls and their raw receipts, timing, token,
cost, acceptance and safety denominators are archived.
