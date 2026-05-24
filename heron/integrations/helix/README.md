# Helix integration for heron

[Helix](https://helix-editor.com) is a tree-sitter-native
modal editor. Wiring heron in gets you Hale syntax
highlighting + basic structural navigation in Helix today —
no LSP needed.

## Quick start

Add two blocks to your `~/.config/helix/languages.toml`
(create the file if it doesn't exist):

```toml
[[language]]
name = "hale"
scope = "source.hale"
file-types = ["hl"]
roots = []
comment-tokens = ["//"]
block-comment-tokens = { start = "/*", end = "*/" }
indent = { tab-width = 4, unit = "    " }
auto-format = false

[[grammar]]
name = "hale"
source = { git = "https://github.com/hale-lang/pond", subpath = "heron", rev = "main" }
```

Then build the grammar:

```sh
hx --grammar fetch
hx --grammar build
```

Open any `.hl` file in Helix — you'll see colored tokens
(keywords, types, identifiers, literals, operators, bus
subjects) per heron's `queries/highlights.scm`.

## Pin to a specific revision

For a stable setup, replace `rev = "main"` with a specific
commit SHA you've tested against:

```toml
source = { git = "https://github.com/hale-lang/pond", subpath = "heron", rev = "<sha>" }
```

This avoids surprise grammar updates on `hx --grammar fetch`.

## Local development (heron contributor)

If you're working on heron itself, point the grammar source
at your local checkout:

```toml
[[grammar]]
name = "hale"
source = { path = "/absolute/path/to/hale-lang/pond/heron" }
```

This skips git fetch and lets you iterate on `grammar.js` +
`hx --grammar build` directly.

## What you get

Per `queries/highlights.scm`:

- **Keywords** (`@keyword`): locus, type, interface, fn,
  params, contract, bus, capacity, lifecycle, mode, closure,
  the recovery primitives, fallible/or/raise/discard, all the
  others
- **Types** (`@type`): user-declared locus / type / interface
  names + the built-in primitives (Int, Float, String, etc.)
- **Functions** (`@function`, `@function.method`,
  `@function.call`): fn declarations + call sites
- **Identifiers** (`@variable`, `@variable.member`,
  `@variable.parameter`): let-bindings, struct fields, params
- **Literals** (`@number`, `@string`, `@constant.builtin`):
  numbers, strings, true/false/nil
- **Operators** + **punctuation** in their own groups
- **Bus subjects** (`@string.special.symbol`): the
  string-literal subjects in `subscribe "foo.bar" as h;` /
  `publish "foo.bar";` / `"foo.bar" <- payload;`
- **Builtins** (`@function.builtin`): sum / prod / println / etc.

## Symbol navigation (tags.scm)

Heron ships `queries/tags.scm` which Helix uses for its
`<space>s` symbol picker. Once the grammar is built, opening
any .hl file and pressing `<space>s` shows a fuzzy-filterable
picker of every defined symbol — locus, type, interface,
topic, perspective, function, const. Picking jumps to the
declaration.

What gets indexed:

- `@definition.type` — locus_decl, type_decl, topic_decl,
  perspective_decl
- `@definition.interface` — interface_decl
- `@definition.function` — function_decl, ffi_function_decl
- `@definition.method` — interface_method_sig
- `@definition.constant` — const_decl
- `@reference.call` — direct + method + path call sites
- `@reference.type` — type references in fn params, struct
  fields, locus param decls

`<space>S` (capital S) picks across the whole workspace, not
just the current file — useful for "where's that Petal type
declared?" across iris's lib/lotus_viz/ tree.

## Not yet wired

- **`locals.scm`** for variable-scope-aware goto-def. Helix
  would use this for `gd` (go to definition) on local
  variables. Smallish addition; add when someone wants it.
- **LSP-like operations** (hover, completion, real
  goto-def across files): not part of heron's scope. When
  an Hale LSP lands, it'll be a separate Helix
  `[language-server]` entry.

## Other editors

The same `parser.c` + `queries/highlights.scm` plug into
every tree-sitter-supporting editor. Patterns vary per
editor; the upstream pond/heron lib documents the C-ABI side.

- **Neovim** — `nvim-treesitter` plugin; add hale to its
  parser list pointing at this repo.
- **VSCode** — would need a small extension wrapping
  `tree-sitter-hale` via the `vscode-tree-sitter` shape.
  Not yet shipped; would live under `integrations/vscode/`
  here when authored.
- **Zed / Sublime / Emacs** — similar patterns, all
  consume `parser.c` + `highlights.scm` with editor-specific
  packaging.

Contributions for those editors welcome under
`integrations/<editor>/` in this directory.
