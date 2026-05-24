; Tree-sitter locals query for Hale.
;
; Consumed by editors that support tree-sitter's local-
; variable scoping pattern:
;   - Helix: powers `gd` (go to definition) on local bindings
;     and consistent-variable highlighting under cursor
;   - Neovim's nvim-treesitter-refactor (similar features)
;
; Three capture roles per the tree-sitter community convention:
;   @local.scope       — where a new scope begins
;   @local.definition  — where a name is bound in scope
;   @local.reference   — where a name is used (resolves to
;                        the nearest enclosing definition)
;
; LSP-shaped cross-file goto-def waits on a real Hale LSP;
; this file gives editors the in-file variable shape they
; need without LSP infrastructure.

; ============================================================
; Scopes
; ============================================================

; Function bodies create a local scope (params + bindings
; visible inside).
(function_decl) @local.scope
(ffi_function_decl) @local.scope

; Locus / interface / perspective / topic bodies — own scope.
(locus_decl) @local.scope
(interface_decl) @local.scope
(perspective_decl) @local.scope

; Lifecycle method bodies — separate scope per lifecycle
; (params declared in birth() vs run() don't cross-leak).
(lifecycle_decl) @local.scope
(mode_decl) @local.scope
(failure_decl) @local.scope

; Closure bodies — their own scope (captures: is the
; declarative binding surface).
(closure_decl) @local.scope

; Generic block — opens a fresh let-binding scope.
(block) @local.scope

; Match arms — pattern bindings in the arm are scoped to
; the arm body.
(match_arm) @local.scope

; ============================================================
; Definitions
; ============================================================

; let / let mut binding — name is in scope from this point
; forward in the enclosing block.
(let_stmt
  name: (identifier) @local.definition)

; Function parameters bind in the function body scope.
(parameter
  name: (identifier) @local.definition)

; Locus param declarations bind in the locus body scope.
; (Visible as self.X inside methods.)
(param_decl
  name: (identifier) @local.definition)

; for var bindings.
(for_stmt
  var: (identifier) @local.definition)

; Pattern bindings in match arms.
(binding_pattern
  (identifier) @local.definition)

; Closure captures clause — identifiers appear directly as
; children since _identifier_list is a hidden rule.
(closure_clause
  (identifier) @local.definition)

; Generic type parameters.
(generic_param
  name: (identifier) @local.definition)

; ============================================================
; References
; ============================================================

; Bare identifier in expression position resolves to the
; nearest enclosing @local.definition. Field accesses
; (foo.bar) are NOT local references — `bar` is a member
; name, not a name in scope. Likewise path accesses
; (foo::bar) — `bar` is namespace-qualified.

(identifier) @local.reference
