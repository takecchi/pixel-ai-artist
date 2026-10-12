# ADR-0011 — A subject-by-subject pixel-art rulebook

**Status:** accepted · 2026-10-06

## Context

`rules/` held eight files of general craft — palette, shading, silhouette,
outlines, animation, rigging, review. They tell an agent *how to behave* but not
*how to draw a hand at 16 px*, how a quadruped's legs sequence in a walk, or how
an isometric roof meets a wall. Asked for those subjects, the agent improvises,
and improvisation is exactly where generated pixel art fails ([ADR-0009]).

The knowledge exists — in pixel-art books, in classical figure, animal, colour
and animation books, and in a large body of free tutorials — but not in a form
an agent can apply pixel by pixel.

## Decision

Grow `rules/` into a subject-indexed rulebook, kept **flat**, numbered in bands:

| Band | Subject |
|------|---------|
| 0x | Core discipline (the original eight files) |
| 1x | Technique — lines, clusters, anti-aliasing, dithering, readability |
| 2x | Colour, light and materials |
| 3x | Characters — proportions, anatomy, faces, eyes, hands, clothing, views |
| 4x | Animation — timing, idle, walk/run, jump, attacks, secondary motion |
| 5x | Animals and creatures |
| 6x | Environments — skies, landscapes, parallax, foliage, water, tiles |
| 7x | Objects and 3D — perspective, isometric, forms, props, vehicles |
| 8x | Effects and interface — VFX, game feel, particles, UI, fonts |
| 9x | Style — platform eras, composition, tells of generated art |

Flat keeps `loadRules` and every existing `rules://` URI unchanged.

Every subject file follows one shape:

1. **Rules** — numbered, normative, each a decision an agent can act on.
2. **By size** — what survives at 8/16/32/64 px.
3. **Pixel templates** — fenced ` ```grid <name> ` blocks in the exact shape
   `draw` op `grid` takes: legend lines `<glyph> = <role> #hex`, a `---`, then
   the rows. The role is what an agent maps onto its own palette; the hex only
   makes the template renderable. `tests/rules.test.ts` compiles every block
   through the real grid compiler, and `scripts/rule-templates.ts` renders them
   to PNG; a template nobody has looked at is not a template.
4. **Procedure** — the order of work for this subject.
5. **Mistakes** — what goes wrong, and how it looks.
6. **Review** — what `pixel-critic` and `review` check for this subject.
7. **Sources** — where the rule came from.

Prose stays under ~200 lines a file, so an agent reads two or three per task;
templates come on top, and a subject that needs a full ladder of them (hands,
eyes, creatures) runs to 400–600 lines. Templates are the part an agent uses
most directly, so they are not cut to meet a line count.

Skills do not restate rules; `studio` carries a subject → rules table, and the
drawing skills and agents point at the subject files they need.

**Sources and copyright.** Books are read outside the repository and never
committed. Rules are written in our own words, cite the source by title and
chapter, and reproduce no text or figures. Notes taken while reading live in
`docs/kb-notes/`, which is git-ignored except for the topic map: they are
dense paraphrase of copyrighted books and stay on the machine that read them.

**Mechanical checks are not promised in prose.** A rule that wants a `validate`
check gets that check implemented, with a test, in the same change — or it is
written as a by-eye review item.

## Consequences

**Good.** Subject requests get decided answers — a hand at 16 px is a template,
not an improvisation — and review gains subject-specific checks.

**Good.** Resources are read on demand, so the rulebook's size costs nothing in
conversations that do not draw that subject.

**Bad.** Fifty files is a surface to keep consistent. Mitigated by the bands,
one template shape, and a test that every `rules://` reference in skills and
agents resolves.

**Bad.** Rules distilled from books can still be wrong at pixel scale.
Mitigated by rendering every template and by re-running the gallery benchmark
before and after.

[ADR-0009]: 0009-concept-first.md
