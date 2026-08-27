---
'@nestm/storage': minor
---

Add a typed `mapCreateConflict` hook to the AI SDK workspace adapter so
applications can represent atomic create collisions as domain results without
mutating generated tools. Keep replace/ETag conflicts fail-closed and sanitize
mapper failures at the tool boundary.

Mark workspace tools with optional inputs or a combined create/replace union as
non-strict for provider schema generation while retaining strict Zod runtime
validation.
