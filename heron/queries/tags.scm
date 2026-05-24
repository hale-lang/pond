; Tree-sitter tags query for Hale.
;
; Consumed by:
;   - Helix's `<space>s` symbol picker
;   - Neovim's tree-sitter-aware tag generators
;   - Anything that consumes the ctags-shape "definition" set
;
; Capture conventions (per tree-sitter community):
;   @definition.function, @definition.type, @definition.interface,
;   @definition.constant, @definition.method, @reference.call
;
; Note: tree-sitter tags are coarser than an LSP's
; goto-definition — they enumerate every named declaration so
; editors can show a flat picker. The LSP-shaped surface
; (hover / references / rename) waits on a real Hale LSP
; building on heron's AST.

; ============================================================
; Top-level definitions
; ============================================================

; locus declaration
(locus_decl
  name: (identifier) @name) @definition.type

; type declaration (covers struct, alias, and enum forms via
; the grammar's three productions)
(type_decl
  name: (identifier) @name) @definition.type

; interface declaration
(interface_decl
  name: (identifier) @name) @definition.interface

; topic declaration
(topic_decl
  name: (identifier) @name) @definition.type

; perspective declaration
(perspective_decl
  name: (identifier) @name) @definition.type

; module declaration (rarely used; reserved syntax)
(module_decl
  name: (identifier) @name) @definition.namespace

; ============================================================
; Functions
; ============================================================

; Top-level function declaration
(function_decl
  name: (identifier) @name) @definition.function

; @ffi extern declarations
(ffi_function_decl
  name: (identifier) @name) @definition.function

; Interface method signatures
(interface_method_sig
  name: (identifier) @name) @definition.method

; ============================================================
; Constants
; ============================================================

(const_decl
  name: (identifier) @name) @definition.constant

; ============================================================
; Call sites
; ============================================================
;
; @reference.call captures help editors show "where is X
; called from?" — even without an LSP, the tag picker can
; jump between calls and definitions of the same name.

(call_expr
  callee: (identifier) @name) @reference.call

(call_expr
  callee: (field_expr
    member: (identifier) @name)) @reference.call

(call_expr
  callee: (path_expr
    member: (identifier) @name)) @reference.call

; ============================================================
; Type references
; ============================================================
;
; @reference.type captures help editors connect a use of a
; type back to its declaration.

(parameter
  type: (named_type
    (qualified_name
      (identifier) @name))) @reference.type

(struct_field
  type: (named_type
    (qualified_name
      (identifier) @name))) @reference.type

(param_decl
  type: (named_type
    (qualified_name
      (identifier) @name))) @reference.type
