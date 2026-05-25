/**
 * @file Tree-sitter grammar for Hale
 * @author hale-lang
 * @license Apache-2.0
 *
 * Source of truth: hale/spec/grammar.ebnf
 * Precedence reference: hale/spec/precedence.md
 *
 * Section numbering below mirrors grammar.ebnf for easy
 * cross-reference.
 */

const PREC = {
  // From precedence.md, level 14 (highest) → 0 (lowest).
  // Tree-sitter precedence is numeric; we mirror the spec
  // levels so a reader can match the two.
  CALL: 14,             // (), [], ., ::
  UNARY: 13,            // unary -, !, ~
  MUL: 12,              // *, /, %
  ADD: 11,              // +, -
  SHIFT: 10,            // <<, >>
  BIT_AND: 9,           // &
  BIT_XOR: 8,           // ^
  BIT_OR: 7,            // |
  CMP: 6,               // <, >, <=, >=
  EQ: 5,                // ==, !=
  APPROX: 4,            // ~~ (closure only)
  AND: 3,               // &&
  OR: 2,                // ||
  OR_DISP: 1,           // `or` (fallible disposition)
  ASSIGN: 0,            // =, +=, -=, ...
  SEND: -1,             // <- (statement only)
};

module.exports = grammar({
  name: 'hale',

  word: $ => $.identifier,

  extras: $ => [
    /\s+/,
    $.line_comment,
    $.block_comment,
    $.doc_comment,
  ],

  externals: $ => [
    // External tokens from scanner.c are deferred until
    // specific parse failures motivate them. See README
    // § "Deferred to scanner.c".
  ],

  conflicts: $ => [
    // Conflicts surface as the grammar grows. Document the
    // reason for each entry inline.
    [$._expression, $._type_expr],         // qualified_name appears in both
    [$.lvalue, $.self_expr],               // `self[i]` could be lvalue or expr
    [$.lvalue, $._expression],             // `foo.bar` could be lvalue or field_expr
    [$.binding_pattern, $.qualified_name], // bare ident in pattern position
    [$.if_stmt, $.if_expr],                // statement-position if vs value-position if
    [$.qualified_name, $.path_expr],       // `Foo::Bar` followed by `{` (struct literal) vs `(` (path call)
    [$.qualified_name, $._expression],     // `foo` as qualified-name (for literal/type) vs identifier expression
    [$.named_type, $._expression],         // `from < total` — named_type's generic_args vs binary_expr's `<`
  ],

  // Supertypes are deferred — tree-sitter requires a "single
  // visible child" property per supertype that not all of our
  // hidden-alternative rules satisfy (notably _type_expr has
  // a parenthesized form). Without supertypes, queries still
  // work; we lose only the "supertype node" affordance at
  // node-walk time. Revisit when grammar stabilizes.

  rules: {

    // ===========================================================
    // § 1. Top level
    // ===========================================================

    source_file: $ => seq(
      repeat($.import_decl),
      repeat($._top_decl),
    ),

    // v1.x-IMPORT: bare `import "path";` (no alias) is a
    // parse error. The grammar reflects that — `as IDENT`
    // is required.
    import_decl: $ => seq(
      'import',
      field('path', $.string_literal),
      'as',
      field('alias', $.identifier),
      ';',
    ),

    _top_decl: $ => choice(
      $.locus_decl,
      $.perspective_decl,
      $.type_decl,
      $.const_decl,
      $.function_decl,
      $.ffi_function_decl,
      $.interface_decl,
      $.topic_decl,
      $.module_decl,
    ),

    module_decl: $ => seq(
      'module',
      field('name', $.identifier),
      '{',
      repeat($._top_decl),
      '}',
    ),

    interface_decl: $ => seq(
      'interface',
      field('name', $.identifier),
      '{',
      repeat($.interface_method_sig),
      '}',
    ),

    interface_method_sig: $ => seq(
      'fn',
      field('name', $.identifier),
      '(',
      optional($._param_list),
      ')',
      optional(seq('->', field('return_type', $._type_expr))),
      ';',
    ),

    topic_decl: $ => seq(
      'topic',
      field('name', $.identifier),
      optional(seq(':', field('parent', $.identifier))),
      '{',
      repeat($.topic_field),
      '}',
    ),

    topic_field: $ => choice(
      seq('payload', ':', field('payload_type', $._type_expr), ';'),
      seq('subject', ':', field('subject', $.string_literal), ';'),
    ),

    // ===========================================================
    // § 2. Locus declaration
    // ===========================================================

    locus_decl: $ => seq(
      // F.32-2 v0.2 (2026-05-25): `@form(...)` and
      // `@locality(...)` may both decorate the same locus,
      // in either order; each may appear at most once. Real
      // arity is enforced by the host typechecker; the
      // grammar accepts the looser shape.
      repeat($._locus_decorator),
      optional('main'),
      'locus',
      field('name', $.identifier),
      optional($.generic_params),
      optional($.locus_annotations),
      '{',
      repeat($._locus_member),
      '}',
    ),

    _locus_decorator: $ => choice(
      $.form_annotation,
      $.locality_annotation,
    ),

    // @form(name, key=value, ...)
    form_annotation: $ => seq(
      '@',
      'form',
      '(',
      field('form_name', $.identifier),
      repeat(seq(',', $.form_arg)),
      ')',
    ),

    form_arg: $ => seq(
      field('key', $.identifier),
      '=',
      field('value', $._expression),
    ),

    // F.32-2 v0.2 (2026-05-25): @locality(L1|L2|L3|any)
    // pins a per-locus cache-tier budget that the host's
    // working-set estimator evaluates against. See
    // spec/types.md § "Working-set estimator (F.32-2)" for
    // the budget precedence rules.
    locality_annotation: $ => seq(
      '@',
      'locality',
      '(',
      field('tier', $.locality_tier),
      ')',
    ),

    locality_tier: $ => choice(
      'L1',
      'L2',
      'L3',
      'any',
    ),

    locus_annotations: $ => seq(
      ':',
      $.locus_annotation,
      repeat(seq(',', $.locus_annotation)),
    ),

    locus_annotation: $ => choice(
      seq('tier', $.integer_literal),
      seq('projection', $.projection_class),
      seq('schedule', $.schedule_class),
    ),

    projection_class: $ => choice(
      'rich',
      'chunked',
      seq('recognition', $.recognition_params),
    ),

    recognition_params: $ => seq(
      '(',
      'cap',
      '=',
      $.integer_literal,
      ',',
      $.recognition_sub_mode,
      ')',
    ),

    recognition_sub_mode: $ => choice(
      'fixed_cell',
      'shared_slab',
      'spillover',
      'summary_only',
    ),

    schedule_class: $ => choice(
      'cooperative',
      seq('pinned', optional(seq('(', 'core', '=', $.integer_literal, ')'))),
    ),

    _locus_member: $ => choice(
      $.params_block,
      $.contract_block,
      $.bus_block,
      $.capacity_block,
      $.lifecycle_decl,
      $.mode_decl,
      $.failure_decl,
      $.closure_decl,
      $.function_decl,
      $.const_decl,
      $.type_decl,
      $.bindings_block,
      $.placement_block,
      $.birth_check_decl,
    ),

    // F.31 (2026-05-23): `placement { field: <spec>; ... }`
    // declares where each main-locus param field's locus
    // runs. Only valid on a `main locus`; the typechecker
    // enforces "field exists in params" and "no duplicate
    // field keys." The grammar accepts placement entries on
    // any locus; the typechecker rejects on non-main.
    placement_block: $ => seq(
      'placement',
      '{',
      repeat($.placement_entry),
      '}',
    ),

    placement_entry: $ => seq(
      field('field', $.identifier),
      ':',
      field('spec', $.placement_spec),
      ';',
    ),

    // Placement specs reuse the same surface as the legacy
    // `schedule_class` annotation, with the addition of an
    // optional named pool on cooperative: `cooperative(pool
    // = io)` opts a field's locus onto a named cooperative
    // pool worker thread instead of the default main pool.
    placement_spec: $ => choice(
      seq(
        'cooperative',
        optional(seq(
          '(',
          'pool',
          '=',
          field('pool', $.identifier),
          ')',
        )),
      ),
      seq(
        'pinned',
        optional(seq(
          '(',
          'core',
          '=',
          field('core', $.integer_literal),
          ')',
        )),
      ),
    ),

    // F.27 v2 birth_check.
    birth_check_decl: $ => seq(
      'birth_check',
      '{',
      $._expression,
      '}',
      '->',
      'violate',
      field('closure_name', $.identifier),
      optional(seq('(', $._expression, ')')),
      ';',
    ),

    bindings_block: $ => seq(
      'bindings',
      '{',
      repeat($.binding_entry),
      '}',
    ),

    binding_entry: $ => seq(
      field('topic', $.identifier),
      ':',
      $._transport_spec,
      optional($.binding_where),
      ';',
    ),

    _transport_spec: $ => choice(
      $.unix_transport,
      $.shm_ring_transport,
      $.adapter_transport,
    ),

    unix_transport: $ => seq(
      'unix',
      '(',
      $.string_literal,
      repeat(seq(',', $.unix_kwarg)),
      ')',
    ),

    unix_kwarg: $ => seq('role', ':', choice('listen', 'connect')),

    shm_ring_transport: $ => seq(
      'shm_ring',
      '(',
      $.string_literal,
      repeat(seq(',', $.shm_ring_kwarg)),
      ')',
    ),

    shm_ring_kwarg: $ => choice(
      seq('slot_count', ':', $.integer_literal),
      seq('on_overflow', ':', $.overflow_policy),
    ),

    overflow_policy: $ => choice('block', 'drop', 'fail'),

    adapter_transport: $ => seq(
      field('locus_name', $.identifier),
      '{',
      optional(seq(
        $.struct_init,
        repeat(seq(',', $.struct_init)),
        optional(','),
      )),
      '}',
    ),

    binding_where: $ => seq(
      'where',
      $.binding_constraint,
      repeat(seq(',', $.binding_constraint)),
    ),

    binding_constraint: $ => choice(
      'intra_process',
      'intra_machine',
      'cross_machine',
      'zero_copy',
    ),

    // ===========================================================
    // § 3. Params block
    // ===========================================================

    params_block: $ => seq(
      'params',
      '{',
      repeat($.param_decl),
      '}',
    ),

    param_decl: $ => seq(
      field('name', $.identifier),
      optional(seq(':', field('type', $._type_expr))),
      choice(
        seq('=', field('default', $._expression), ';'),
        seq(':', 'inferred', ';'),
        ';',   // required-shape: name: T;
      ),
    ),

    // ===========================================================
    // § 4. Contract block
    // ===========================================================

    contract_block: $ => seq(
      'contract',
      choice(
        seq(':', 'inferred', ';'),
        seq('{', repeat($.contract_member), '}'),
      ),
    ),

    contract_member: $ => seq(
      choice('expose', 'consume'),
      choice(
        seq(field('name', $.identifier), ':', field('type', $._type_expr), ';'),
        seq('inferred', ';'),
      ),
    ),

    // ===========================================================
    // § 5. Bus block
    // ===========================================================

    bus_block: $ => seq(
      'bus',
      '{',
      repeat($._bus_member),
      '}',
    ),

    _bus_member: $ => choice($.bus_subscribe, $.bus_publish),

    bus_subscribe: $ => seq(
      'subscribe',
      field('subject', $._bus_subject),
      'as',
      field('handler', $.identifier),
      optional(seq('of', 'type', field('type', $._type_expr))),
      ';',
    ),

    bus_publish: $ => seq(
      'publish',
      field('subject', $._bus_subject),
      optional(seq('of', 'type', field('type', $._type_expr))),
      optional(seq('as', field('alias', $.identifier))),
      ';',
    ),

    _bus_subject: $ => choice($.string_literal, $.qualified_name),

    // ===========================================================
    // § 5b. Capacity block (F.22)
    // ===========================================================

    capacity_block: $ => seq(
      'capacity',
      '{',
      repeat($.capacity_slot),
      '}',
    ),

    capacity_slot: $ => seq(
      field('kind', choice('pool', 'heap')),
      field('name', $.identifier),
      'of',
      field('cell_type', $._type_expr),
      optional(seq('indexed_by', field('indexed_by', $.identifier))),
      optional(seq('as_parent_for', field('as_parent_for', $.identifier))),
      ';',
    ),

    // ===========================================================
    // § 6. Lifecycle blocks
    // ===========================================================

    lifecycle_decl: $ => seq(
      field('kind', $._lifecycle_keyword),
      optional(seq('(', optional($._param_list), ')')),
      optional(seq('->', field('return_type', $._type_expr))),
      $.block,
    ),

    _lifecycle_keyword: $ => choice(
      'birth',
      'accept',
      'run',
      'drain',
      'dissolve',
    ),

    // ===========================================================
    // § 7. Mode declarations
    // ===========================================================

    mode_decl: $ => seq(
      'mode',
      field('name', $._mode_name),
      optional(seq('(', optional($._param_list), ')')),
      optional(seq('->', field('return_type', $._type_expr))),
      $.block,
    ),

    _mode_name: $ => choice('bulk', 'harmonic', 'resolution'),

    // ===========================================================
    // § 8. Failure handler
    // ===========================================================

    failure_decl: $ => seq(
      'on_failure',
      '(',
      $._param_list,
      ')',
      $.block,
    ),

    // ===========================================================
    // § 9. Closure tests
    // ===========================================================

    closure_decl: $ => seq(
      'closure',
      field('name', $.identifier),
      '{',
      optional(seq($.closure_assertion, ';')),
      repeat($.closure_clause),
      '}',
    ),

    closure_assertion: $ => seq(
      $._expression,
      choice('~~', 'approx'),
      $._expression,
      'within',
      $._expression,
    ),

    closure_clause: $ => choice(
      seq('epoch', $._epoch_spec, ';'),
      seq('persists_through', '(', $._identifier_list, ')', ';'),
      seq('resets_on', '(', $._identifier_list, ')', ';'),
      seq('captures', ':', $._identifier_list, ';'),
    ),

    _epoch_spec: $ => choice(
      'tick',
      seq('duration', '(', $._expression, ')'),
      'birth',
      'dissolve',
      'explicit',
      'inline',
    ),

    // ===========================================================
    // § 10. Perspective declaration
    // ===========================================================

    perspective_decl: $ => seq(
      'perspective',
      field('name', $.identifier),
      optional($.generic_params),
      '{',
      repeat($._perspective_member),
      '}',
    ),

    _perspective_member: $ => choice(
      $.params_block,
      seq('stable_when', $.block),
      seq('serialize_as', $._type_expr, ';'),
      $.function_decl,
    ),

    // ===========================================================
    // § 11. Type declarations
    // ===========================================================

    type_decl: $ => choice(
      // type T = type_expr;
      seq('type', field('name', $.identifier), optional($.generic_params),
          '=', field('aliased', $._type_expr), ';'),
      // type T { field: Type; ... }  (struct)
      seq('type', field('name', $.identifier), optional($.generic_params),
          '{', repeat($.struct_field), '}'),
      // type T = enum { A, B(int), ... };
      seq('type', field('name', $.identifier), optional($.generic_params),
          '=', 'enum', '{',
          $.enum_variant, repeat(seq(',', $.enum_variant)), '}', ';'),
    ),

    struct_field: $ => seq(
      field('name', $.identifier),
      ':',
      field('type', $._type_expr),
      optional(seq('=', field('default', $._expression))),
      ';',
    ),

    enum_variant: $ => seq(
      field('name', $.identifier),
      optional(seq('(', $._type_expr, repeat(seq(',', $._type_expr)), ')')),
    ),

    generic_params: $ => seq(
      '<',
      $.generic_param,
      repeat(seq(',', $.generic_param)),
      '>',
    ),

    generic_param: $ => seq(
      field('name', $.identifier),
      optional(seq(':', field('constraint', $._type_expr))),
    ),

    generic_args: $ => seq(
      '<',
      $._type_expr,
      repeat(seq(',', $._type_expr)),
      '>',
    ),

    // ===========================================================
    // § 12. Type expressions
    // ===========================================================

    _type_expr: $ => choice(
      $.primitive_type,
      $.named_type,
      $.projection_type,
      $.array_type,
      $.tuple_type,
      $.function_type,
      $.unit_type,
      seq('(', $._type_expr, ')'),
    ),

    // `()` — the unit type. Per spec/types.md: "If a fn omits
    // `-> T`, the return type defaults to `()`. Explicit `-> T`
    // is required for any non-unit return." Some stdlib fns
    // spell `-> ()` explicitly when paired with `fallible(E)`
    // so the fallible-success-type is unambiguous.
    unit_type: $ => seq('(', ')'),

    primitive_type: $ => choice(
      'Int', 'Uint', 'Float', 'Decimal', 'String', 'Bool',
      'Time', 'Duration', 'Bytes',
      'BytesView', 'StringView',
    ),

    named_type: $ => seq($.qualified_name, optional($.generic_args)),

    projection_type: $ => seq(
      choice('Rich', 'Chunked', 'Recognition'),
      '<',
      $._type_expr,
      '>',
    ),

    array_type: $ => seq(
      '[',
      $._type_expr,
      optional(seq(';', $._expression)),
      ']',
    ),

    tuple_type: $ => seq(
      '(',
      $._type_expr,
      ',',
      $._type_expr,
      repeat(seq(',', $._type_expr)),
      ')',
    ),

    function_type: $ => seq(
      'fn',
      '(',
      optional(seq($._type_expr, repeat(seq(',', $._type_expr)))),
      ')',
      optional(seq('->', $._type_expr)),
    ),

    qualified_name: $ => seq(
      $.identifier,
      repeat(seq('::', $.identifier)),
    ),

    // ===========================================================
    // § 13. Const and function decls
    // ===========================================================

    const_decl: $ => seq(
      'const',
      field('name', $.identifier),
      ':',
      field('type', $._type_expr),
      '=',
      field('value', $._expression),
      ';',
    ),

    function_decl: $ => seq(
      'fn',
      field('name', $.identifier),
      optional($.generic_params),
      '(',
      optional($._param_list),
      ')',
      optional(seq('->', field('return_type', $._type_expr))),
      optional($.fallible_marker),
      $.block,
    ),

    // @ffi("c") fn name(params) -> ret ;
    ffi_function_decl: $ => seq(
      $.ffi_annotation,
      'fn',
      field('name', $.identifier),
      '(',
      optional($._param_list),
      ')',
      optional(seq('->', field('return_type', $._type_expr))),
      ';',
    ),

    ffi_annotation: $ => seq(
      '@',
      'ffi',
      '(',
      $.string_literal,
      ')',
    ),

    fallible_marker: $ => seq(
      'fallible',
      '(',
      field('payload_type', $._type_expr),
      ')',
    ),

    _param_list: $ => seq(
      $.parameter,
      repeat(seq(',', $.parameter)),
    ),

    parameter: $ => seq(
      field('name', $.identifier),
      ':',
      field('type', $._type_expr),
      optional(seq('=', field('default', $._expression))),
    ),

    // ===========================================================
    // § 14. Statements + blocks
    // ===========================================================

    block: $ => seq(
      '{',
      repeat($._statement),
      optional($._expression),     // trailing expression (Phase 2b)
      '}',
    ),

    _statement: $ => choice(
      $.let_stmt,
      $.assign_stmt,
      $.send_stmt,
      $.if_stmt,
      $.match_stmt,
      $.for_stmt,
      $.while_stmt,
      $.return_stmt,
      $.break_stmt,
      $.continue_stmt,
      $.yield_stmt,
      $.recovery_stmt,
      $.violate_stmt,
      $.fail_stmt,
      $.block,
      $.expr_stmt,
    ),

    let_stmt: $ => seq(
      'let',
      optional('mut'),
      field('name', $.identifier),
      optional(seq(':', field('type', $._type_expr))),
      '=',
      field('value', $._expression),
      ';',
    ),

    assign_stmt: $ => seq(
      field('target', $.lvalue),
      field('op', $._assign_op),
      field('value', $._expression),
      ';',
    ),

    _assign_op: $ => choice(
      '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    ),

    lvalue: $ => seq(
      choice($.identifier, 'self'),
      repeat(choice(
        seq('.', $.identifier),
        seq('[', $._expression, ']'),
      )),
    ),

    send_stmt: $ => prec(PREC.SEND, seq(
      field('subject', $._expression),
      '<-',
      field('payload', $._expression),
      ';',
    )),

    if_stmt: $ => prec.right(seq(
      'if',
      field('condition', $._expression),
      field('then', $.block),
      repeat(seq('else', 'if', $._expression, $.block)),
      optional(seq('else', field('else', $.block))),
    )),

    match_stmt: $ => seq(
      'match',
      field('scrutinee', $._expression),
      '{',
      $.match_arm,
      repeat(seq(',', $.match_arm)),
      optional(','),
      '}',
    ),

    match_arm: $ => seq(
      field('pattern', $._pattern),
      optional(seq('if', field('guard', $._expression))),
      '->',
      field('body', choice($._expression, $.block)),
    ),

    _pattern: $ => choice(
      $.literal_pattern,
      $.wildcard_pattern,
      $.binding_pattern,
      $.constructor_pattern,
      $.tuple_pattern,
    ),

    literal_pattern: $ => choice(
      $.integer_literal,
      $.float_literal,
      $.string_literal,
      'true',
      'false',
      'nil',
    ),

    wildcard_pattern: $ => '_',

    binding_pattern: $ => $.identifier,

    constructor_pattern: $ => seq(
      $.qualified_name,
      optional(seq('(', $._pattern_list, ')')),
    ),

    tuple_pattern: $ => seq(
      '(',
      $._pattern,
      ',',
      $._pattern,
      repeat(seq(',', $._pattern)),
      ')',
    ),

    _pattern_list: $ => seq($._pattern, repeat(seq(',', $._pattern))),

    for_stmt: $ => seq(
      'for',
      field('var', $.identifier),
      'in',
      field('iter', $._expression),
      field('body', $.block),
    ),

    while_stmt: $ => seq(
      'while',
      field('condition', $._expression),
      field('body', $.block),
    ),

    return_stmt: $ => seq('return', optional($._expression), ';'),

    break_stmt: $ => seq('break', ';'),

    continue_stmt: $ => seq('continue', ';'),

    yield_stmt: $ => seq('yield', ';'),

    fail_stmt: $ => seq('fail', $._expression, ';'),

    recovery_stmt: $ => seq(
      $._recovery_op,
      '(',
      optional($._argument_list),
      ')',
      optional($.recovery_modifier),
      ';',
    ),

    _recovery_op: $ => choice(
      'restart',
      'restart_in_place',
      'drain',
      'dissolve',
      'quarantine',
      'reorganize',
      'bubble',
    ),

    recovery_modifier: $ => choice(
      seq('for', $._expression),
      seq('until', $._expression),
    ),

    violate_stmt: $ => seq(
      'violate',
      field('closure_name', $.identifier),
      optional(seq('with', field('payload', $._expression))),
      ';',
    ),

    expr_stmt: $ => seq($._expression, ';'),

    // ===========================================================
    // § 15. Expressions — precedence ordered
    // ===========================================================

    _expression: $ => choice(
      $.or_disposition_expr,
      $.range_expr,
      $.binary_expr,
      $.unary_expr,
      $.call_expr,
      $.field_expr,
      $.index_expr,
      $.path_expr,
      $.struct_literal,
      // locus instantiation is syntactically identical to a
      // struct literal — both lower to `Name { field: val, ... }`.
      // The distinction is semantic (does Name resolve to a
      // locus or a type?), not syntactic. Consumers
      // (lotus_viz, semantic-analyzer) make the call at
      // tree-walk time.
      $.tuple_expr,
      $.array_expr,
      $.if_expr,
      // match-as-expression deferred — match_stmt overlaps and
      // tree-sitter can't disambiguate without lookahead help.
      // Add via a distinct match_expr rule (or scanner.c) when
      // a real workload needs it.
      $.sum_expr,
      $.prod_expr,
      $.parenthesized,
      $.self_expr,
      $.identifier,
      $._literal,
    ),

    parenthesized: $ => seq('(', $._expression, ')'),

    self_expr: $ => 'self',

    // Range — used inside index brackets for slicing, e.g.
    // `s[from..total]`. Per spec/precedence.md range is level 1
    // non-assoc; we use prec.left for tree-sitter happiness
    // since GLR doesn't need explicit non-assoc enforcement at
    // this level. Half-open ranges (`..end` / `start..`) are
    // not in stdlib usage today; add them when a workload
    // surfaces the need.
    range_expr: $ => prec.left(1, seq(
      field('start', $._expression),
      field('op', choice('..', '..=')),
      field('end', $._expression),
    )),

    or_disposition_expr: $ => prec.right(PREC.OR_DISP, seq(
      field('expr', $._expression),
      'or',
      field('disposition', choice(
        $.raise_disposition,
        $.discard_disposition,
        $.fail_disposition,
        $._expression,
      )),
    )),

    raise_disposition:   $ => 'raise',
    discard_disposition: $ => 'discard',
    fail_disposition:    $ => seq('fail', $._expression),

    binary_expr: $ => {
      const table = [
        [PREC.OR,      '||'],
        [PREC.AND,     '&&'],
        [PREC.EQ,      '=='],
        [PREC.EQ,      '!='],
        [PREC.CMP,     '<'],
        [PREC.CMP,     '>'],
        [PREC.CMP,     '<='],
        [PREC.CMP,     '>='],
        [PREC.BIT_OR,  '|'],
        [PREC.BIT_XOR, '^'],
        [PREC.BIT_AND, '&'],
        [PREC.SHIFT,   '<<'],
        [PREC.SHIFT,   '>>'],
        [PREC.ADD,     '+'],
        [PREC.ADD,     '-'],
        [PREC.MUL,     '*'],
        [PREC.MUL,     '/'],
        [PREC.MUL,     '%'],
      ];
      return choice(...table.map(([p, op]) =>
        prec.left(p, seq(
          field('left', $._expression),
          field('op', op),
          field('right', $._expression),
        )),
      ));
    },

    unary_expr: $ => prec.right(PREC.UNARY, seq(
      field('op', choice('-', '!', '~')),
      field('operand', $._expression),
    )),

    call_expr: $ => prec(PREC.CALL, seq(
      field('callee', $._expression),
      '(',
      optional($._argument_list),
      ')',
    )),

    field_expr: $ => prec(PREC.CALL, seq(
      field('object', $._expression),
      '.',
      field('member', $._member_name),
    )),

    index_expr: $ => prec(PREC.CALL, seq(
      field('object', $._expression),
      '[',
      field('index', $._expression),
      ']',
    )),

    path_expr: $ => prec(PREC.CALL, seq(
      field('object', $._expression),
      '::',
      field('member', $._member_name),
    )),

    // member_name admits framework-vocabulary keywords post-dot.
    _member_name: $ => choice(
      $.identifier,
      'bulk', 'harmonic', 'resolution',
      'closure', 'locus', 'params', 'contract',
      'bus', 'capacity', 'tier', 'projection',
      'perspective', 'type',
    ),

    if_expr: $ => prec.right(seq(
      'if',
      field('condition', $._expression),
      field('then', $.block),
      'else',
      field('else', choice($.if_expr, $.block)),
    )),

    sum_expr: $ => seq('sum', '(', $._expression, ')'),
    prod_expr: $ => seq('prod', '(', $._expression, ')'),

    tuple_expr: $ => seq(
      '(',
      $._expression,
      ',',
      $._expression,
      repeat(seq(',', $._expression)),
      ')',
    ),

    array_expr: $ => seq(
      '[',
      choice(
        optional(seq($._expression, repeat(seq(',', $._expression)))),
        seq($._expression, ';', $.integer_literal),
      ),
      ']',
    ),

    struct_literal: $ => seq(
      field('name', $.qualified_name),
      '{',
      optional(seq(
        $.struct_init,
        repeat(seq(',', $.struct_init)),
        optional(','),
      )),
      '}',
    ),

    struct_init: $ => seq(
      field('field', $.identifier),
      ':',
      field('value', $._expression),
    ),

    _argument_list: $ => seq(
      $._expression,
      repeat(seq(',', $._expression)),
    ),

    _identifier_list: $ => seq(
      $.identifier,
      repeat(seq(',', $.identifier)),
    ),

    // ===========================================================
    // § 16. Lexical tokens
    // ===========================================================

    identifier: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    _literal: $ => choice(
      $.integer_literal,
      $.float_literal,
      $.decimal_literal,
      $.string_literal,
      $.fstring_literal,
      $.bytes_literal,
      $.duration_literal,
      $.time_literal,
      $.boolean_literal,
      $.nil_literal,
    ),

    integer_literal: $ => token(choice(
      /[0-9][0-9_]*/,
      /0x[0-9a-fA-F_]+/,
      /0o[0-7_]+/,
      /0b[01_]+/,
    )),

    float_literal: $ => token(seq(
      /[0-9][0-9_]*/,
      '.',
      /[0-9][0-9_]*/,
      optional(/[eE][+-]?[0-9]+/),
      optional(/f32|f64/),
    )),

    // Decimal — `d` suffix on a numeric literal.
    decimal_literal: $ => token(seq(
      /[0-9][0-9_]*/,
      optional(seq('.', /[0-9][0-9_]*/)),
      'd',
    )),

    // String / bytes literals MUST be token() so the lexer
    // consumes them atomically — otherwise `//` inside a URL
    // string is matched as a `line_comment` from `extras` and
    // the parse blows up.
    string_literal: $ => token(choice(
      // Triple-quoted multi-line: """...""".
      seq('"""', repeat(choice(/[^"]/, /"[^"]/, /""[^"]/)), '"""'),
      // Raw string: r"..." — no escape processing.
      seq('r"', repeat(/[^"]/), '"'),
      // Regular string with escapes.
      seq('"', repeat(choice(
        /[^"\\\n]/,
        seq('\\', /./),
      )), '"'),
    )),

    bytes_literal: $ => token(seq(
      'b"',
      repeat(choice(
        /[^"\\\n]/,
        seq('\\', /./),
      )),
      '"',
    )),

    // f-strings need parser-level handling for the interpolated
    // expressions, but we can token-ize the literal frame.
    // For v0, treat fstring_literal as a single token (no
    // interpolation extraction — the body is opaque text).
    // Polish-phase upgrade: extract `{expr}` sub-trees.
    fstring_literal: $ => token(seq(
      'f"',
      repeat(choice(
        /[^"\\\n]/,
        seq('\\', /./),
      )),
      '"',
    )),

    // 5s, 100ms, 1h30m, etc.
    duration_literal: $ => token(seq(
      /[0-9]+/,
      choice('ns', 'us', 'ms', 's', 'm', 'h', 'd'),
      repeat(seq(/[0-9]+/, choice('ns', 'us', 'ms', 's', 'm', 'h', 'd'))),
    )),

    // ISO-8601 in backticks.
    time_literal: $ => token(seq('`', /[^`]+/, '`')),

    boolean_literal: $ => choice('true', 'false'),

    nil_literal: $ => 'nil',

    // ---- Comments ----

    line_comment: $ => token(seq('//', /[^\n]*/)),

    block_comment: $ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),

    doc_comment: $ => token(choice(
      seq('///', /[^\n]*/),
      seq('/**', /[^*]*\*+([^/*][^*]*\*+)*/, '/'),
    )),
  },
});
