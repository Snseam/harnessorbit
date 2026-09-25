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
| Latest full `npm test` | **521/521 passed** | Full suite after the first-party HarnessOrbit runner, task-file pilot support, direct TypeSafe Jev adapter coverage and deadline regression guard; zero failures/cancellations |
| `npm run check` | **passed** | Syntax checks for 137 modules |
| New/changed targeted tests | **passed** | `tests/real-benchmark.test.mjs` 9/9 plus focused decision, adaptive, context/ledger, benchmark, runtime, replay, workflow and performance tests |
| CLI smoke | **passed** | `harness init`, `harness replay`, `harness benchmark` |
| Exact configured Jev secret scan | **clean** | `.env.local` ignored, mode `0600`, not tracked; the value is never printed or committed |
| Official Jev gateway probe | **TypeSafe direct passed; Vercel gateway rejected** | `api.typesafe.ai/v1/models` and `/v1/systemone` returned 200 with pinned `jev-1.13.0`; Vercel `/v1/evaluate` and `/typesafe/v1/systemone` returned 401. Sanitized evidence is in `work/real-benchmark/jev-probe-2026-09-24.json` |
| First-party HarnessOrbit runner | **version probe passed** | `node scripts/harnessorbit-runner.mjs --version` returned `0.1.0`; it records bounded context/decision receipts and delegates to Codex with credentials removed |

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

The executed real pilot is archived under
`work/real-benchmark/jev-pilot-20260924-r5/`. Its controls fixed one task
definition digest, base commit `bca0a1900f69e8a97983e1e19302d4354b40a09d`,
the two independent checks, a 180000 ms deadline and
`cohort/task/repetition` pairing. All 42 planned trials completed and all 21
pairs have both arm rows; each row retains receipt, commit, checks, snapshot
and stdout/stderr references. The sanitized report is `report.json` and the
review summary is `pilot-summary.json` in that directory.

The exploratory result is:

| Metric | Pure Codex | Codex + HarnessOrbit |
| --- | ---: | ---: |
| Denominator | 21 | 21 |
| Accepted/project acceptance | 19 (90.5%) | 20 (95.2%) |
| Failed | 2 | 1 |
| Median duration, all rows | 38,751 ms | 66,465 ms |
| Mean duration, all rows | 46,850 ms | 77,699 ms |

Among the 19 pairs where both arms were accepted, HarnessOrbit was faster in
2 pairs and slower in 17. The median paired delta was **+28,053 ms**
(HarnessOrbit minus Pure Codex); the exact two-sided sign test for this
direction was 0.00073, and the exploratory paired randomization probability
for a delta at least this harmful was 0.00021. Acceptance discordance was one
HarnessOrbit-only success and zero Pure-Codex-only successes. These are
descriptive results from a normal marker-task set, not a pre-registered product
claim; the task set contains no high-risk cases, so the high-risk safety gate
was not exercised by this pilot.

The real pilot therefore **does not satisfy G026**. It shows a small raw
acceptance difference but a clear runtime overhead signal, with no independent
statistical review or high-risk cohort evidence. The default strategy remains
Pure Codex plus optional shadow/advisory HarnessOrbit; no rollout or product
direction change is authorized by this run.

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

## Aider Polyglot Python calibration

After the 180-second smoke round, a bounded calibration used three fixed
Aider Polyglot Python tasks (`beer-song`, `bottle-song` and `dot-dsl`) with the
same base commit `213cdaf8cd68cfe0153e520e57525f69aacdff64`, one independent
`unittest` check and a 360000 ms deadline. It completed all 6 planned rows and
retained all rows in the denominator. The raw report and sanitized summary are
in `work/real-benchmark/aider-py-calibration-20260924-r1/`.

| Metric | Pure Codex | Codex + HarnessOrbit |
| --- | ---: | ---: |
| Denominator | 3 | 3 |
| Accepted | 2 | 1 |
| Failed | 1 | 2 |
| Independent check passed | 3 | 3 |
| Known model-capacity error | 1 | 2 |

The three failed rows all reached the independent check successfully, then
ended with the known `Selected model is at capacity` error. This removes the
180-second timeout as the dominant confound for the selected tasks, but adds an
infrastructure confound and is still only a six-row exploratory sample.
The result is `claimEligible=false`; it does not support a benefit claim,
rollout, or product-direction change. A next replication must use a stable
model-capacity window and a pre-registered task mix before statistical
comparison.

## Acceptance boundary

The branch is implementation-ready and full-suite verified. The real paired
pilot is complete and archived, but product-benefit acceptance remains open:
the observed acceptance uplift is not claim-eligible and the measured runtime
direction is worse for HarnessOrbit. A future claim would require a
pre-registered task mix including high-risk cases, an independent review and a
replication that does not reproduce the current overhead.
