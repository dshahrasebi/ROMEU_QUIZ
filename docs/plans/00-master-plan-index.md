# ROMEU_QUIZ v2.0 — Master Implementation Plan

## Current state: v1.0 live on Railway
- 160 tests passing (89 REST + 71 socket)
- EN/ES i18n complete
- Production CSP fix deployed

## Plan files

| File | Contents | Est. items |
|---|---|---|
| `01-batch1-infrastructure-critical-ux.md` | Persistent volume, player waiting state, streak visibility, kick player | 4 features |
| `02-batch2-authoring-game-quality.md` | Question reorder, live answer count, shuffle questions, shuffle options | 4 features |
| `03-batch3-data-export-polish.md` | Import/export JSON, CSV export, post-game breakdown, mobile responsive, toasts | 5 features |
| `04-batch4-feature-expansion.md` | Poll type, solo practice, pause/unpause, folders/tags, emoji reactions, CSV bulk import | 6 features |
| `05-testing-plan.md` | CSRF tests, display socket tests, edge cases, per-batch feature tests | ~40+ new tests |

## Implementation order

**Batch 1** (do first — infrastructure + critical UX)
1. Railway persistent volume ← RED FLAG: data loss on redeploy
2. Player "Waiting..." state
3. Streak count on player phone
4. Host kick player

**Batch 2** (authoring + game quality)
5. Drag-and-drop question reorder
6. Live answer count during question
7. Randomize question order
8. Randomize answer option order

**Batch 3** (data + polish)
9. Quiz import/export (JSON)
10. CSV export of session results
11. Post-game personal breakdown
12. Host panel mobile responsiveness
13. Toast/snackbar notifications

**Batch 4** (expansion)
14. Poll question type
15. Solo practice mode
16. Pause/unpause
17. Question bank / folders / tags
18. Emoji reactions
19. Bulk CSV import

**Testing** — T1-T3 before Batch 1; T4 with each batch

## Dependencies
- Batch 2.4 (shuffle options) requires 2.2 (live answer count) to be updated for per-player emit
- Batch 3.3 (post-game breakdown) is independent
- Batch 4.1 (poll type) requires DB migration — do before 4.6 (bulk import) so CSV format includes type
- Testing T2 requires verifying how display socket joins — may need to add `display-join` event first
