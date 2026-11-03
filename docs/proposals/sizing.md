# Proposal: sizing tasks before routing them

Status: accepted direction, rolled out step by step. Written 2026-11-03. Done in 0.6.0: step 0, and the router's part of step 1 (floors); dev-team carries the task key per step from 0.7.3.

Today the router knows three things about a spawn: which agent it is, an optional
regular expression on the prompt, and how many times the same task was spawned. Two
very different tasks sent to the same agent get the same model.

This proposal adds a task score, written by the dev-team agents that already analyse
every ticket, and keeps the decision in the router, where it is deterministic, capped
and logged.

Inspired by [spar-x-fr/spar-x-skills](https://github.com/spar-x-fr/spar-x-skills)
(`skills/rightsize`): its four-axis score and its measured effort sweep. What it lacks,
and this plugin keeps: the score is enforced by a hook, never left to the model's
discipline, and every score is logged next to its outcome so it can be calibrated.

## Principles

1. **Who estimates is not who decides.** Dodie and Archie estimate; the router decides,
   inside a floor and a cap.
2. **Errors are not symmetric.** A model too large only costs money. A model too small
   on a task with a check costs a retry, which escalation catches. A model too small
   on a risky task with no check can lose quality silently. So: start low where a check
   exists, and hold a hard floor on risk.
3. **No signal without a measure.** Every signal goes to the journal beside the outcome,
   and `model-tuner` reports how well it predicts.
4. **The table changes only by the owner's hand.** The tuner proposes; the owner edits.

## The score

Four axes, 0 to 3, each read off a section of the spec its author just wrote.

| Axis | Scored by | Read from | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|---|
| **A** ambiguity | Dodie; Archie lowers it | `Open questions` | none open | 1–2 minor | a design choice is open | goal unclear: grill first |
| **R** risk | Dodie (business); Archie may only raise it | `Context`, `Risks and trade-offs` | throwaway | normal code with tests | production data, public text, public API | money, personal data, auth, deletion, migration |
| **C** scope | Dodie estimates, Archie revises | `User stories`, then `Components touched` | 1 file | 2–5 files, 1 module | several modules | public interface or ADR (Dodie slices instead) |
| **D** depth | Archie | `Design` | copy a pattern | adapt a pattern | non-obvious design | novel algorithm, concurrency, unknown cause |
| **CHK** flag | Archie | `Test plan` | set when every DoD line has a test that fails first | | | |

Between two levels: take the higher for R; for C, A and D take the lower when CHK is
set (escalation catches it), the higher otherwise.

### In the ticket

One line per revision, never overwritten; every axis at 2 or more cites its evidence:

```
Size (dodie, 2026-11-03): C1 R3 A2 D? — R: customer refund; A: two rounding rules
Size (archie, 2026-11-04): C2 R3 A0 D2 CHK — C: payments + api; D: idempotent retries; A: settled (ADR-12)
```

The `cycle` skill passes the latest line in every brief as `[size: C2 R3 A0 D2 CHK]`.

## The decision

```json
"sizing": {
  "roles": {
    "dev-team:dodie":  ["A", "C"],
    "dev-team:archie": ["A", "C", "D"],
    "dev-team:kody":   ["D", "C"],
    "dev-team:bugsy":  ["D"],
    "dev-team:lockie": ["R"]
  },
  "models":  ["haiku", "haiku", "sonnet", "opus"],
  "efforts": ["low", "low", "medium", "high"]
},
"floors": [
  { "paths": ["migrations/**", "**/auth/**", "**/payment*/**"], "model": "opus" }
]
```

- Level for an agent = the highest of its role's axes, plus 1 when R ≥ 2, capped at 3.
- With CHK, effort one step lower, except at R = 3.
- Order: `[model:]` tag, then the caller's model, then `[size:]`, then a rule, then the
  table. Escalation on retry: effort first, then model. Last, the choice is held between
  the floor and `maxModel`.
- The caller's model no longer goes below the floor.

## Fix first: one task key per step

The cycle spawns Archie twice on one ticket (technical spec, then PR review), and Uxie
too. With the ticket alone as the key, the review counts as a retry and escalates. The
`cycle` skill names the step in `description` (`#42 spec`, `#42 impl`, `#42 qa`,
`#42 review`), and `taskKey` captures both: `#\d+\s+(spec|impl|qa|review)`. Kody sent
back after a blocking QA verdict stays `#42 impl`: that escalation is right.

## Measure

- Journal: per spawn, the decision (as today, plus `agentId`); per finished run, its
  tokens (input, output, cache read, cache write), duration and end reason.
- Main metric: cost per successful task, all attempts included, at a first-attempt
  success rate that does not drop.
- A/B: each task goes to arm A or B by the hash of its task key, over the same period.

## Rollout

| Step | Delivers | Gate to the next |
|---|---|---|
| 0 | Tokens and duration of each routed run in the journal (`turn.complete`) | every routed run has its tokens for a week |
| 1 | Task key per step, floors by path, floor applied to the caller's model | no false escalation of Archie or Uxie; no spawn on a sensitive path below its floor |
| 2 | Dodie and Archie write `Size`; `cycle` passes `[size:]` | at least 90% of tickets carry a `Size` line |
| 3 | The router routes on `[size:]`, A/B 50/50 | at least 30 tasks per arm; cost per successful task down; first-attempt success no more than 5 points lower |
| 4 | Effort through `turn.step`, after a live check that the rewrite applies | same gate as step 3 |
| 5 | Tuner calibration report: Dodie → Archie → outcome | drifts reported per axis |

A Haiku classifier (`$.model.classify`) comes later, only if many spawns arrive with no
score.

## Open points

1. Floor above `maxModel`: proposed, `maxModel` wins and a toast warns.
2. The A/B thresholds (30 tasks per arm, 5 points) are starting values, not measured ones.
3. Tickets run outside `cycle` carry no score and fall back to the table.
4. Steps 1 to 3 change `deki-lab/dev-team` too: `agents/dodie.md`, `agents/archie.md`,
   `skills/cycle/SKILL.md`.
