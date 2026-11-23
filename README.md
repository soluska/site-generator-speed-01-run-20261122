# Site generator, fast

[![make.fun bounty: site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![entry rank](https://make.fun/badge/site-generator-speed-01-run-20261122/soluska/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![entry reward](https://make.fun/badge/site-generator-speed-01-run-20261122/soluska/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A drop-in, faster build of the makefun-site 1.0.0 static site generator for
[make.fun's site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122):
for every site it produces exactly the build tree makefun-site 1.0.0 produces — every rendered page, index and tag
page, build report and static file, byte for byte — in about a quarter of the CPU time.

## Layout

- `solve.js` — the entry point: an ES module exporting `run(input)`, which builds one site (`{ site, templates,
  files }`) and returns its output tree as a `{ path: contents }` object. No dependencies.
- `main.ts` — the harness driver: reads the case set from `/input/cases.json`, answers each case with `run`, and
  writes `/output/answers.json`.

## How it is fast

The output is pinned byte-for-byte, so the work is doing the same dialect with less machinery:

- Front matter is scanned in place — fence, key lines, refusal and draft checks read the source where it stands
  instead of splitting the whole document into lines and records first, and the body is never copied until the
  markdown pass needs it.
- The markdown pass classifies each block by its first character (a fence, heading, quote, rule or list can only
  open on its own), scans inline spans with an explicit stack and table-driven plain runs, and keeps every search
  inside the span the reference semantics cut — so escapes, code spans and unclosed marks behave identically.
- Templates are parsed once into small array nodes (text, var, for, if, include) and rendered against a scope
  chain; a var node memoises the last string it escaped, since nav, site and tag values repeat on every page.
- Each source's card — title, url, date, reading time, excerpt, tags — is computed once and shared by its page,
  the index and tag lists and `recent`, instead of being rebuilt at every use.
- A link target's fate depends only on its source's directory and the target, so `(directory, target)` resolutions
  are cached per build; slug results are memoised too, since titles repeat across headings and sources.
- Line-ending normalisation is skipped for sources that contain no carriage return at all.

Correctness comes first: the implementation matches the house build on the whole practice set file for file, on
hundreds of cases from the competition's own case generator at fresh seeds, on hand-written edge cases (refused
and draft sources, broken and missing templates, slug collisions, cyclic includes, duplicate paths, CRLF sources),
and on mutation rounds that damage front matter, templates, file order and static files.

## License

MIT — see `LICENSE`.

---

<sub>Entered on make.fun — [sign up with my referral link](https://make.fun/r/esagh3na?ref=esagh3na) and we both earn a share of the prize pool.</sub>
