# heron has moved

The tree-sitter grammar for Hale now lives at
**[hale-lang/tree-sitter-hale](https://github.com/hale-lang/tree-sitter-hale)**
(extracted 2026-07-19, full history preserved) so ecosystem
consumers — nvim-treesitter, Helix, Zed, GitHub linguist — can pin
it by URL the way tree-sitter grammars are conventionally pinned.

Its CI parses the Hale compiler's fixture corpus on every push, so
the grammar can no longer drift silently behind the language.
