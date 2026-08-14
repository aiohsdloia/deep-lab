---
name: word-revise
description: "Use whenever the user wants to revise or polish an existing Word document (.doc/.docx) and see every change as a tracked change (修订/审阅模式/redline), especially when the document ALREADY contains tracked changes and needs another round of revision — the standard string-edit tools break in that case. Every revision is authored as 'sculab' and is reviewable/acceptable/rejectable in Word or WPS. Triggers include: 修订/润色/批改/审阅修改, 'track changes', 'redline', 'revise the doc', 'polish this word file'. Do NOT use for creating a brand-new document from scratch (use the docx skill for that)."
---

# Word revision & polishing with tracked changes (修订模式)

## What this skill does

Turns your text edits into real Word tracked changes (`w:ins` / `w:del`) attributed to
**`sculab`**, so the user can open the result in Word/WPS, review every change, and
accept or reject each one.

Its core capability is **re-revision**: revising a document that *already contains*
tracked changes (from `sculab` or from anyone else). A naive tool cannot do this:

- The target text is split across `<w:ins>`/`<w:del>` wrappers, so it is **not
  contiguous** in `document.xml` — plain find/replace cannot locate it (or silently
  mutates an old revision instead of adding a new one).
- New marks must nest legally inside the old ones, or Word/WPS will reject the file.

This skill uses a DOM-based, author-aware engine (`scripts/revise.py`) that handles
that. Do NOT hand-edit `document.xml` runs for tracked changes in this skill; let the
engine do it.

## Workflow (always in this order)

Work in a scratch directory. All `revise.py` commands take an *unpacked* directory
except `unpack`/`fold`.

1. **Convert** legacy `.doc` → `.docx` if needed:
   ```bash
   textutil -convert docx -output out.docx in.doc     # macOS
   # or, if LibreOffice is available:
   soffice --headless --convert-to docx in.doc --outdir ./
   ```
2. **Unpack**:
   ```bash
   python3 scripts/revise.py unpack input.docx work/
   ```
3. **Survey** the document — read it and pick what to change:
   ```bash
   python3 scripts/revise.py status work/ --limit 80     # paragraphs + visible text + redlines
   python3 scripts/revise.py summary work/               # which authors already revised
   ```
   `status` prints `[id] 'visible text'  | redlines: sculab×2`; ids are paragraph
   indexes (0-based, document order) you pass to edits.
4. **Write the edits JSON**, then apply:
   ```bash
   cat > edits.json <<'JSON'
   [
     {"para": 2, "old": "四川省重点实验室", "new": "四川省重点实验室（筹）"},
     {"para": 6, "new": ""},
     {"old": "依托单位：（盖章）", "new": "依托单位：（盖章）　二〇二六年八月"}
   ]
   JSON
   python3 scripts/revise.py apply work/ --edits edits.json --author sculab
   ```
   `--author` defaults to `sculab`; keep it unless the user says otherwise.
5. **Verify + pack** (always against the **original clean input**, not the last
   redlined output — see Why below):
   ```bash
   python3 scripts/revise.py verify work/ --original input.docx
   python3 scripts/revise.py pack work/ output.docx --original input.docx
   ```
   `pack` refuses to emit if verification fails. Verify MUST print PASSED.
6. **Close the loop**: if soffice is available, render `output.docx` → PDF/PNG and
   visually check the redlines look right. Report the revision summary (which
   paragraphs changed, by `sculab`) to the user.
   Optionally produce a clean copy with `sculab`'s changes accepted:
   ```bash
   python3 scripts/revise.py fold work/ --author sculab --out output_clean.docx
   ```

## Edits JSON schema

A list of edit objects, applied in order:

| key      | meaning                                                              |
|----------|----------------------------------------------------------------------|
| `para`   | 0-based paragraph index from `status`. Omit to search every paragraph. |
| `old`    | text to locate in the paragraph's *current visible* text. Omit → the paragraph's whole text is `old`. |
| `new`    | replacement text (verbatim). `""` deletes.                           |
| `all`    | true → replace every occurrence (default: first only).               |

Single-edit shortcut: `apply work/ --old TEXT --new TEXT [--all]`.
Empty-paragraph insert: `{"para": 1, "old": "", "new": "text"}`.
If `old` is not found the command errors and changes nothing — re-run `status` and
copy the exact visible text.

## How re-revision works (author-aware rules)

The engine reads the *visible* text (insertions shown, deletions hidden), applies your
edit there, and emits marks according to what the old text was inside:

| old text lives in…                       | result                                                        |
|------------------------------------------|---------------------------------------------------------------|
| normal run                               | `<w:del sculab>` + `<w:ins sculab>` at paragraph level        |
| `sculab`'s own prior `<w:ins>`           | superseded in place (no nested same-author marks); new text becomes a fresh `<w:ins>` |
| `sculab`'s own prior `<w:del>`           | restoring that text unwraps the del (undo) instead of a new mark |
| another author's `<w:ins>`               | `sculab`'s `<w:del>` is **nested inside** their `<w:ins>`     |
| another author's `<w:del>`               | `sculab`'s `<w:ins>` is placed **after** their `<w:del>`      |
| whole paragraph deleted                  | all runs deleted **and** the paragraph mark marked deleted (`w:pPr/w:rPr/w:del`) |

**Why verify against the original input:** the invariant the engine guarantees is
"if you strip every `sculab` change from the output, you get the original input text
back". That holds across any number of revision rounds, so the *original* clean file
(not the last round's output) is always the right `--original` for `verify`/`pack`.

## Polishing guidance (润色)

- Prefer **minimal, targeted edits** over full rewrites. One edit per changed span.
- Fix typos, wrong/mixed punctuation (use proper 中文标点 — but only the edit you
  intend, keep the rest untouched), subject–predicate agreement, spacing, and
  terminology consistency.
- Preserve the original style/format: headings, fonts, lists, numbers — do not
  restyle. The engine copies run formatting (`w:rPr`) onto inserted text.
- Batch related edits of one paragraph into one `old`/`new` pair; avoid two edits
  that overlap the same text.
- If an edit could go several ways (ambiguous wording), make the safest minimal
  change and add a comment to the user in your summary rather than guessing at tone.
- After packing, sanity check: `status` of the final work dir should show the new
  visible text, and `summary` should show marks only by `sculab` (plus any pre-existing
  authors' marks, which are preserved).

## Dependencies

- Python 3 with **lxml** (`python3 -c "import lxml"`). No LibreOffice/pandoc needed
  for the core workflow.
- `textutil` (macOS) for `.doc` → `.docx`; LibreOffice is optional, for PDF preview
  and for `accept all` flows.
- The engine is self-contained; it does not call the `docx` skill's scripts.
  It also works on the `docx` skill's unpacked folders (it re-reads the XML).

## Troubleshooting

- `text not found`: run `status`, copy the exact visible text (note: whitespace and
  full-width vs half-width characters count).
- Verification FAILED: you edited text without it being a tracked change (e.g. touched
  something the engine didn't route through apply). Redo from a fresh unpack; never
  hand-edit `document.xml` between steps.
- The user wants to *accept* some rounds but keep later rounds: `fold` accepts exactly
  one author's changes; other authors' marks remain.

## Regression tests

```bash
python3 scripts/../tests/revise_tests.py   # from the skill dir: python3 tests/revise_tests.py
```
Covers round-1/round-2/round-3, another-author nesting, undo, whole-paragraph delete,
empty-paragraph insert, and fold.
