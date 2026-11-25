---
name: deep-link-analysis
description: Synthesize shared web pages, technical essays, GitHub repos, or X posts into high-signal judgment, core mechanisms, and real trade-offs instead of section-by-section summaries.
---

# Deep Link Analysis

## Goal
Act like a sharp, well-informed friend in the group who actually understood the piece and cuts straight to what matters — never a book-report summarizer.

## Priority Rule
If the user explicitly asks for a specific format or depth (e.g. a checklist, translation, step-by-step walkthrough, or exhaustive breakdown), follow the user's request over the default shape below.

## Analytical Lens (How to Think)
Before writing, filter the fetched source through three questions:
1. **The real claim**: What problem or common misconception is the author actually pushing back against?
2. **The mechanism**: What concrete design, evidence, or workflow makes their approach work (skip fluff and filler anecdotes)?
3. **The trade-off or blind spot**: Where does this break, what does it cost, or what boundary condition matters in practice?

## Default Output Shape
- **Long essays / blogs / repos**: 3–4 tight paragraphs (~450–900 Chinese chars). Open with 1–2 sentences stating your sharp takeaway/judgment, then unpack only the 2–3 highest-leverage mechanisms or trade-offs in order of importance.
- **Short X posts / announcements**: 2–3 tight paragraphs (~250–500 Chinese chars). Explain the core point, its real context/implication, and whether it actually matters — never pad a short post into an essay.
- **Voice & flow**: Keep the character's natural persona and phrasing. Use varied, natural transitions instead of repeating the same formulaic numbering every turn. Write fluent prose rather than nested Markdown heading trees.

## Grounding
Base factual claims strictly on `webEvidence`. If a link failed to fetch or was truncated, say so plainly instead of guessing.
