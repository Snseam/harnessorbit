# Paired Benchmark Evaluation

HarnessOrbit's benchmark evaluator is a statistics harness for controlled experiments. It does not run agents, does not enable adaptive dispatch by default, and does not claim that HarnessOrbit is faster from smoke tests or shadow routing.

Run it with a predeclared plan and a result file:

```bash
node benchmarks/evaluate.mjs benchmarks/example-plan.json benchmarks/example-results.json
```

The plan fixes the schema version, experiment id, deadline, cohorts, task ids, arms, and repetitions before results are imported. The result file must carry the same `schemaVersion` and `experimentId`. Each result must match one planned `(cohortId, taskId, armId, repetition)` identity. Duplicate, unknown, unsafe, or oversized identities fail the evaluation instead of being silently ignored.

The evaluator treats missing, failed, timed out, cancelled, and unjudged trials as part of the denominator. A trial is complete only when it reports project acceptance within the fixed deadline. `p50TimeToAcceptanceMs` and `p90TimeToAcceptanceMs` are computed over all planned trials; if fewer than 50% or 90% of the denominator reached full acceptance, the corresponding percentile is `null`. This prevents success-only averages from looking fast while hiding failures.

Each report includes an `overall` view and per-cohort views. Use the cohort views for existing-repository and greenfield comparisons; the overall view is a convenience rollup and should not hide cohort-specific regressions.

Each report also includes two cancellation sensitivity views:

- `userCancelsIncluded` counts user-cancelled trials as non-completions.
- `userCancelsExcluded` removes user-cancelled trials from that sensitivity denominator and from paired comparisons.

Pairwise comparisons are matched by cohort, task id, and repetition. The evaluator reports planned pairs, observed matched pairs, missing pair members, and completed-pair deltas. Completed-pair deltas only use pairs where both arms produced observed full-acceptance results. `benefitClaim` remains `null`: rollout claims require enough real, controlled, paired data and a separate release decision. Unpaired data can still be inspected, but it cannot justify a speed or completion-rate claim.

The schema checks accounting shape, not whether a claimed result is truthful. Keep raw transcripts, commits, check logs, and acceptance artifacts available for review. HarnessOrbit should stay opt-in until CI or a separate release process verifies enough real benchmark evidence.

The example files are intentionally small and incomplete. They demonstrate accounting behavior, not performance evidence.
