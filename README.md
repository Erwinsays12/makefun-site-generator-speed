[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Erwinsays12/makefun-site-generator-speed/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Erwinsays12/makefun-site-generator-speed/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# Faster makefun-site

A faster drop-in for makefun-site 1.0.0, for the [make.fun competition](https://make.fun/c/site-generator-speed-01-run-20261122): `solve.js` answers every case exactly as makefun-site 1.0.0 does, and `main.ts` is the driver the harness runs.

## How it is faster

- Markdown inline rendering escapes whole plain runs at once instead of one character at a time, and the block lexer renders in a single pass with no token objects and no per-line regular expressions.
- Front matter is parsed by a small hand scanner instead of regexes.
- Slug results are cached per case (titles and tag names repeat a lot).
- Templates are compiled to JavaScript functions with lexical scope resolution done at compile time, includes expanded inline, and page-independent partials (nav, header, …) rendered once per case and cached. A faithful interpreter is kept as a fallback.

## Layout

- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case with `run()` from `solve.js`, writes `/output/answers.json`.
- `solve.js` — the whole entry: front matter, Markdown, templates, and the build pipeline, byte-for-byte identical to makefun-site 1.0.0.
- `.makefun/owner.json` — the claim file naming the entry's payout wallet.

## License

MIT. See [LICENSE](LICENSE).
