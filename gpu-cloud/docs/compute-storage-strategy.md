# Compute + Storage Strategy — KEEP BOTH (adopted)

**Adopted by the owner:** 24 November 2026 ~21:13 WAT.
**Recommended by:** the reviewer, thread 16 (verbatim
`architecture/kaggle-vs-storage-review-reply-verbatim-2026-11-24.md`).
**Status:** governing strategy for NOVA GPU Cloud.

## Formal statement

NOVA retains Kaggle as its primary free GPU compute provider and its own
GPU Cloud storage subsystem as the independent media-storage and
delivery layer. A non-Google compute alternative may be evaluated using
existing eligible accounts only. No paid service, new account, payment
method or automatic billing is authorised.

## Roles

| Component | Role | Decision |
| --------- | ---- | -------- |
| Kaggle | Primary free GPU compute | Retain |
| Existing non-Google GPU account, if eligible | Standby compute | Investigate |
| NOVA storage subsystem | Independent output storage and delivery | Retain and develop |
| Second storage backend | Future portability and capacity | Defer decision |
| Paid GPU services | Outside current policy | Do not activate |

## Rules

- **Rule A** — Do not abandon a working route because of one provider's
  limitations. Kaggle passed the real GPU + internet smoke test; the Wan
  one-clip proof is the next decision point. Wait for its verdict.
- **Rule B** — Never make Kaggle the permanent storage owner. Model
  weights, generated media, project records and delivery references stay
  governed by NOVA's own architecture. Kaggle executes jobs; it is not
  the permanent home of customer output.
- **Rule C** — Do not build an expensive abstraction before proving the
  need. Keep the compute interface portable, but don't implement
  multiple provider adapters until an alternative is actually available
  and tested.

## Reconsideration triggers

No arbitrary abandonment date. Reconsider Kaggle only if one of these
occurs:

1. Repeated GPU allocation failures, including multiple off-peak attempts.
2. Wan 2.2 cannot complete the required clip within Kaggle's session or
   memory constraints.
3. The weekly GPU allowance is insufficient for the intended production
   volume.
4. Kaggle restrictions prevent the intended workflow.
5. A genuinely independent, free alternative is tested and performs better.

If none of these occurs, Kaggle stays.

## Standing qualifications

- The storage subsystem is independent in design and ownership, but its
  current filesystem backend is not yet independent cloud
  infrastructure (~5 GB real capacity; live-site integration and second
  backend outstanding).
- The 182/182 storage test does not yet make the live NOVA website
  storage-independent. Stage 4 website integration is outstanding.
- The systemd service (`nova-storage-runner`) tends the store on this
  VM; the production sweep host decision is still open.
- Lightning AI is the only alternative worth investigating, and only
  with an existing eligible account — verify the actual free balance,
  GPU availability, country eligibility and billing protections before
  running anything. It is a potential backup, not a declared
  replacement.
- The long-term objective is provider independence, not provider
  avoidance.
