# pond/router — friction log

Format borrows from `notes/hale-friction.md` upstream: one
entry per gap, date-stamped, with the smallest reproducer that
forced the call.

---

## ~~2026-05-16 — interface-value-in-vec-cell~~

**Closed 2026-05-18** by F.20 Phase B interface storage landing
in upstream (G20). `@form(vec) of Handler` and `@form(vec) of
Middleware` are now legal cell types; interface coercion fires
at the synthesized `push`/`set` boundaries. The fn-pointer
shadow in `lists.hl` / `router.hl` was ripped out the same day
this entry closed — the `Route` and `MwEntry` struct shadows,
the `__router_mw_passthrough_before` / `_after` helpers, and
the parallel fn-pointer fields all collapsed. `Router.add` and
`Router.use_mw` now take `Handler` / `Middleware` interface
values directly per CONTRACTS.md. The original deviation entry
is retained below for context.

CONTRACTS.md `pond/router/` declares:

```hale
fn add(method: String, pattern: String, h: Handler) -> ();
fn use(m: Middleware) -> ();
```

Both `h: Handler` and `m: Middleware` are interface-typed
parameters that the Router needs to *store* (route table,
middleware chain) for later dispatch — not just call inline.

Pre-G20, storing a `Handler` value in a `@form(vec)` heap slot
fell under "interfaces in arrays/tuples", which Phase B didn't
yet allow. So the literal contract wasn't implementable, and
the Router accepted fn pointers at register time:

```hale
fn add(method: String, pattern: String,
       h: fn(Context) -> Response) -> ();
fn use_mw(before: fn(Context) -> Context,
          after:  fn(Context, Response) -> Response) -> ();
```

Post-G20 the shape is what CONTRACTS.md asked for from the
start:

```hale
@form(vec)
locus HandlerList { capacity { heap items of Handler; } }
@form(vec)
locus MwList      { capacity { heap items of Middleware; } }

fn add(r: Router, method: String, pattern: String, h: Handler);
fn use_mw(r: Router, m: Middleware);
```

---

## 2026-05-16 — use-is-reserved

**Status:** [DEVIATION-FROM-CONTRACT]

CONTRACTS.md names the middleware-register method `use(m: M)`.
`use` is on the reserved-keyword shortlist (the Hale
grammar treats it as future-reserved for the cross-seed import
mechanism, paralleling Rust's `use`). Even though no current
production fires on `fn use(...)` declared inside a locus
body, naming a method `use` carries lexical fragility.

**Workaround taken.** Renamed to `use_mw(before, after)`.
Reads naturally — "use a middleware" — and avoids the reserved-
word collision entirely. Pairs with the fn-pointer workaround
above (the method now takes two halves rather than one
`Middleware`-typed param).

**Suggested upstream resolution.** When the Phase B follow-up
above unblocks the interface-value storage, CONTRACTS.md can
either keep `use(m)` (and accept the lexical risk) or rename
to `mount(m)` / `with(m)` to dodge it. `use_mw` here is the
v1 shape; the rename to whichever final form CONTRACTS.md
picks is mechanical.

---

## 2026-05-16 — context-req-field

**Status:** [DEVIATION-FROM-CONTRACT]

CONTRACTS.md declares:

```hale
type Context { req: Request; params: RouteParams; }
```

i.e. Context carries a nested `std::http::Request`. At v1 this
fails at codegen with:

```
type error: qualified type `std::http::Request`
  (mangled `__StdHttpRequest`) declared in stdlib path-renames
  table but not registered in user_loci, user_types, or
  user_interfaces yet — sequencing issue: type_expr_to_codegen_ty
  called before pass A0/A1 populated this name
```

Cause: pass A0 walks `program.items` in source order. User
items come before stdlib items (the bundled stdlib AST is
appended to the user program in `lower_program`). So
`__StdHttpRequest` isn't registered in `user_types` when the
user `type Context` declaration tries to resolve its `req`
field.

**Workaround taken.** Flattened `Context` to copy the four
request fields a handler actually reads:

```hale
type Context {
    method:  String;
    path:    String;
    headers: String;
    body:    String;
    params:  RouteParams;
}
```

`Router.dispatch(req)` builds the Context by copying the
fields off `req` at the boundary. Consumers read
`ctx.method` / `ctx.path` / etc. directly — one indirection
shorter than `ctx.req.method` would have been, and the
ergonomic delta is small. The full Request remains
accessible at the handler boundary if Router ever gains a
"raw req" passthrough.

**Reproducer:**

```hale
type Foo { r: std::http::Request; }   // ← fails at codegen
```

**Suggested upstream resolution.** Either (a) split pass A0
into "register all user types" then "register all stdlib
types" runs before "resolve field type exprs" (so source
order of items doesn't matter for path-qualified lookups),
or (b) have stdlib items prepended to user items in
`lower_program` (would also require pass A1 to handle the
forward-declared stdlib loci correctly). Once fixed, the
flatten can be reverted.

---

## 2026-05-16 — response-in-fn-ptr-field

**Status:** [DEVIATION-FROM-CONTRACT]

Same pass-A0 sequencing gap as `context-req-field` above, just
firing at fn-pointer field positions inside `type` records.
Once `Context` was flattened, the next error was:

```
type error: type `__lib_router_types_Route`: field `handler`
  expects `fn(__lib_router_types_Context) -> __lib_router_types_Response`,
  got `fn(__lib_router_types_Context) -> ?`
```

i.e. a `handler: fn(Context) -> std::http::Response` field on
the Route record fails to resolve `std::http::Response` for
the same reason: the user `type Route` declaration's field
type-exprs are walked before stdlib types are registered.

**Workaround taken.** Declared a local `type Response` in
`types.hl` with fields identical to `std::http::Response`
(status / content_type / body). Handler fn pointers return
the local `Response`; the `Router.dispatch` / `Router.handle`
methods convert to `std::http::Response` via
`__router_to_http` at the std::http::Server boundary.

The conversion is a single struct-literal copy — cost is
negligible compared to the per-request HTTP wire I/O. The
ergonomic cost (handler authors write `router::Response`
rather than `std::http::Response`) lines up with the rest of
the lib's surface (`router::Context`, `router::path_param`)
so it reads as "all router types live under one alias."

**Suggested upstream resolution.** Same as
`context-req-field` — fix the pass-A0 ordering so user types
can reference stdlib types in field positions. Once that
lands, the local `Response` collapses back into a
`std::http::Response` re-export.

---

## 2026-05-16 — imported-free-fn-path-call

**Status:** ~~[DEVIATION-FROM-CONTRACT]~~ **Resolved 2026-05-17**
by upstream `f9068fa` (A3). The `Params` namespace lotus has
been deleted; consumers now call `router::path_param(...)` and
`router::query_param(...)` directly per CONTRACTS.md. See
`params.hl` for the substituted shape.

CONTRACTS.md exposes:

```hale
fn path_param(p: RouteParams, name: String) -> String;
fn query_param(p: RouteParams, name: String) -> String;
```

At v1 the consumer naturally writes
`router::path_param(ctx.params, "name")`. That fails with:

```
codegen error: unsupported in codegen v0:
  path call `router::path_param` in expression position
```

Cause: `Cx::lower_path_call_expr` (codegen.rs L18812) recognizes
two two-segment shapes for non-`std::*` paths: `time::monotonic`
and enum-variant construction. Everything else falls through to
the error. The import-renames table (`Cx::mangled_for_path`)
isn't consulted at expression-position path calls for non-
fallible callees.

Three call sites in codegen DO consult `mangled_for_path`:

- `lower_path_call` for `or`-disposed fallible callees (L10881)
- Struct-literal lowering for path-qualified locus / type names (L17504)
- Type expression lowering for path-qualified type names (L5351)

So `router::Router { }`, `router::Context { ... }`, etc. work.
Plain function calls of the form `router::fn(args)` don't.

**Workaround taken.** Re-expose the same vocabulary through a
namespace lotus, `Params` (pattern 2 — empty params, methods
only). Consumers write:

```hale
let p = router::Params { };
let name = p.path(ctx.params, "name");
let q    = p.query(ctx.params, "q");
```

Cross-locus method calls route through the receiver's CodegenTy
which IS resolved via mangled_for_path at the receiver-expr
position (struct-literal lowering), so the rest of the dispatch
chain finds the locus's methods. Mirror of the v1 stdlib idiom
(`let r = std::cli::Resolver { ... }; r.lookup(...)`).

The free fns (`path_param` / `query_param`) stay declared and
work inside this lib's own seed (intra-seed paths use bare
names rewritten by the mangler — not the expression-position
path-call lowering). So the dispatcher and matcher inside
the lib still call them directly; only cross-seed call sites
take the namespace-lotus shape.

**Reproducer:**

```hale
// lib/foo.hl
fn greet(name: String) -> String { return "hi " + name; }

// main.hl
import "lib" as foo;
fn main() {
    println(foo::greet("world"));   // ← codegen rejects
}
```

**Suggested upstream resolution.** Extend
`lower_path_call_expr` (and the statement-position sibling
`lower_path_call`) to consult `mangled_for_path` for non-
`std::*` paths and dispatch to `lower_user_fn_call` with the
resolved name. The plumbing already exists for the type-
expression and struct-literal paths; the function-call
position just needs the same hookup. Once that lands, the
`Params` namespace lotus collapses back into the free-fn
contract shape.

---

## 2026-05-16 — intra-seed-locus-order

**Status:** [WORKAROUND-DOCUMENTED]

Within one imported seed, files are bundled alphabetically
(per `spec/projects.md` § "Resolution order" — `read_dir` +
sort in `hale-cli/src/main.rs::collect_target_files`).
Pass A1 of codegen (`declare_locus_struct`) walks loci in
merged-source order; a locus whose params reference another
locus by name fails if the referenced locus hasn't been
declared yet (`unknown type name X in signature` from
`type_expr_to_codegen_ty` L5329).

For pond/router this fires on:

```hale
// router.hl
locus Router {
    params {
        routes: RouteList = RouteList { };   // ← RouteList in storage.hl
    }
}
```

If `storage.hl` lands after `router.hl` alphabetically
(`s > r`), Router's struct declaration tries to resolve
`RouteList` before `storage.hl`'s pass has registered it.

**Workaround taken.** Renamed `storage.hl` → `lists.hl`
(`l < r`) so the vec loci are declared first. The contents
are identical; the file name is the only knob the consumer
of this constraint controls.

**Suggested upstream resolution.** Split pass A1 into "scan
every file to register every locus's name + struct shape"
(no param resolution) followed by "resolve param type-exprs
now that every locus name is known." Then alphabetical
ordering inside a seed stops being load-bearing for code
that crosses files.

---

## 2026-05-16 — url-decoding (duplicate-suspected)

**Status:** [GAP]

`query_param` returns the raw value-half of an `&`-separated
pair without percent-decoding. A request to `/?name=hello%20world`
binds `name` to `"hello%20world"`, not `"hello world"`. Same
applies to path captures — `/greet/hello%20world` captures
`name` as `"hello%20world"`.

URL decoding (`%XX` percent-escapes → bytes; `+` → space in
query strings only) is a universal HTTP concern, not router-
specific. The first lib that needs it should land it under
`std::str` or its own `pond/url/` lib; `pond/router` will
delegate. Flagging here so it isn't reimplemented per-call-
site.

**Suggested resolution.** Add `std::str::url_decode_path(s)`
and `std::str::url_decode_query(s)` C-runtime primitives;
have `query_param` + `path_param` (or the matcher upstream
of them) call them.

---

## 2026-05-16 — header-parsing (duplicate-suspected)

**Status:** [GAP]

`std::http::header(req, name)` exists for request-side header
lookup. There's no equivalent for *setting* response headers
(`Response { ... }` only carries status + content_type + body;
the Server writes a fixed `Content-Type` / `Content-Length` /
`Connection: close` block on the wire). Routes that need to
emit custom headers (CORS, caching, set-cookie) can't today.

This is upstream of pond/router — the Response shape comes
from `std::http`. Logged here because every router-shaped lib
will hit the same gap, and someone should consolidate it once
the right surface lands.

**Suggested resolution.** Extend `std::http::Response` with a
`headers: String` field (same packed "Name: value\r\n..."
shape as `Request.headers`), then have Server emit those after
the fixed three headers (or replace them when names collide).
`pond/router` doesn't need its own header-setting API once
that lands.

---

## 2026-05-18 — registry-ops-as-free-fns (G20 follow-up)

**Status:** [WORKAROUND-DOCUMENTED]

`Router.add` and `Router.use_mw` (plus the convenience aliases
`use_before` / `use_after`) are *free fns over Router*, not
locus methods, even though the natural call shape would have
been `r.add(method, pattern, h)`.

The reason is the same gap pond/tower hit at
`v1-cross-seed-method-arg-coerce-missing`: v1 codegen doesn't
apply the `LocusRef → Interface` coercion at user-declared
locus-method arg sites. So `r.add("GET", "/", Root { })` —
where `add`'s `h` param is typed `Handler` and `Root { }` is a
concrete locus — fails with:

```
codegen error: unsupported in codegen v0:
  Router.add arg 2 type mismatch:
  expected Interface("Handler"), got LocusRef("Root")
```

Free-fn arg sites DO coerce (the standard F.20 Phase B path),
and the synthesized `@form(vec).push` DOES coerce (G20). So
routing every interface-arg entry point through a free fn that
forwards to the vec's push is the v1 shape that compiles. This
mirrors `pond/tower::add(reg, t)` / `pond/jobs::enqueue(q, j)`
— the established pond house style for `Interface`-arg ops.

Public call shape:

```hale
let r = router::Router { };
router::add(r, "GET", "/", Root { });
router::use_mw(r, LogMw { });
```

**Closes when:** Codegen extends `lower_user_method_call`'s
arg-prep to apply `coerce_to_interface` on `LocusRef → Interface`
mismatches the same way `lower_user_fn_call` does. Same A10
extension, different lowering site (see pond/tower/FRICTION.md
for the same entry).

---

## 2026-05-18 — interface-in-struct-field

**Status:** [WORKAROUND-DOCUMENTED]

The cleanest storage shape for a route table would be a single
`@form(vec)` of a `RouteEntry { method, pattern, handler: Handler }`
struct, pushed once per `router::add` call. v1 codegen rejects
the literal at the push site:

```
codegen error: unsupported in codegen v0:
  type `RouteEntry` field `handler` type mismatch:
  declared Interface("Handler"), got LocusRef("Root")
```

i.e. struct-literal field-init isn't a `LocusRef → Interface`
coerce site. Same shape as pond/tower's
`v1-cross-seed-struct-field-interface-coerce`.

**Worked around by:** Three parallel `@form(vec)` storage loci
— `MethodList` (String), `PatternList` (String), `HandlerList`
(Handler) — pushed in lockstep inside `router::add`. The
`get(i)` calls in the dispatch loop read all three at the same
index. Adds one allocation per route table vs the struct
shape, but routing is O(N) per request anyway and the constant
delta is rounding noise.

**Closes when:** Codegen extends struct-literal field-init
lowering to apply `coerce_to_interface` on interface-typed
fields receiving LocusRef args. Same A10 extension as the
method-arg case. Once landed, `Route { method, pattern,
handler }` collapses back to one vec.

---

## 2026-05-16 — locus-method-fallible-routing-mismatch

**Status:** [WORKAROUND-DOCUMENTED]

`router.hl`'s `__router_run_chain` reads from
`@form(vec).get(i)` which returns `T fallible(IndexError)`.
Inside a free fn we'd want the index to *not* be invalid (we
just got it from `0..len()`), so we use `or raise` to satisfy
the addressing rule — the indices come from `0..self.len()`
and the loop bounds make the error unreachable. The pre-G20
cell shape was a value-type struct (Route / MwEntry) and the
workaround used `or <synthesized-default-record>`; post-G20
the cells are interface values which have no clean placeholder
literal, so `or raise` is the right shape now (the runtime
panics into the root if the impossible fires, which is what
we'd want anyway for a bounds-violation bug).

Not a contract deviation, just a code-shape note for readers
wondering why every `.get(j)` in the dispatcher uses `or raise`
when the surrounding loop guarantees the index is in range. If
a future checker can see that `i < self.len()` implies `get(i)`
always succeeds (refinement-typing territory, deferred per
`spec/types.md` § "What's deferred"), the `or raise` clauses
go away.
