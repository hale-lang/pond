# pond/router

HTTP router on top of `std::http`. Routes have a method + a
pattern (with `:name` captures); middleware is a chain of
`Middleware`-shaped loci that run `before` (transform Context)
and `after` (transform Response). The Router locus implements
`std::http::Handler` structurally, so it drops straight into a
`std::http::Server { handler: my_router, ... }`.

Suggested alias: `router`.

## Vendoring

```hale
import "vendor/pond/router" as router;
```

## Quick start

```hale
import "vendor/pond/router" as router;

locus Root {
    fn handle(ctx: router::Context) -> router::Response {
        return router::Response { status: 200, body: "hello" };
    }
}

locus Greet {
    fn handle(ctx: router::Context) -> router::Response {
        let name = router::path_param(ctx.params, "name");
        return router::Response {
            status: 200,
            body: "hello, " + name
        };
    }
}

locus LogMw {
    fn before(ctx: router::Context) -> router::Context {
        eprintln(ctx.req.method, " ", ctx.req.path);
        return ctx;
    }
    fn after(ctx: router::Context, resp: router::Response) -> router::Response {
        return resp;
    }
}

fn main() {
    let r = router::Router { };
    r.add("GET", "/", Root { });
    r.add("GET", "/greet/:name", Greet { });
    r.use(LogMw { });
    std::http::Server {
        port: 8080,
        handler: r,
        ready_signal: "READY"
    };
}
```

Handlers and middleware are Hale loci that structurally
satisfy `router::Handler` (one `handle` method) and
`router::Middleware` (a `before` + `after` pair) respectively.
A "before-only" middleware writes the interesting logic in
`before` and a passthrough `after` — same for "after-only".

## Public surface

Implements the `pond/router/` section of
[`../CONTRACTS.md`](../CONTRACTS.md). The 2026-06-12 pass
restored the contract surface — registration is via **Router
methods** (`r.add(method, pattern, h)`, `r.use(m)`), the
`LocusRef → Interface` coercion now firing at method-arg and
struct-field sites at HEAD; the free-fn shims (`router::add(r,
...)`, `router::use_mw` / `use_before` / `use_after`) are
retired, and `Context` carries the nested
`req: std::http::Request` per the contract (read
`ctx.req.method`, `ctx.req.path`, etc.; `ctx.req.path` is the
raw target — query lookup goes through
`router::query_param(ctx.params, name)`).

One local-shape note: handlers return `router::Response`, not
`std::http::Response` — Hale has no alias/re-export surface, so
the field-equal local type stays and the Router converts at the
Server boundary. `Response.headers` (CRLF-joined extra header
lines, e.g. `Set-Cookie`) passes through to
`std::http::Response.headers`. See
[`FRICTION.log`](FRICTION.log) for the refreshed log.

## Demo

`examples/hello-routes/` ships a runnable demo: `GET /`
returns "hello", `GET /greet/:name` returns "hello, NAME", and
a logging middleware writes each request line to stderr. Build
+ run:

```bash
hale build pond/router/examples/hello-routes/
./pond/router/examples/hello-routes/main
# in another shell:
curl -s http://127.0.0.1:8080/
curl -s http://127.0.0.1:8080/greet/world
```

The demo prints `READY` on stdout when the listen socket binds
(via `std::http::Server.ready_signal`); test oracles wait for
that line before issuing requests.

## Files

| File | What |
|------|------|
| `types.hl` | `RouteParams`, `Context`, `Response` shapes |
| `interfaces.hl` | `Handler`, `Middleware` structural interfaces |
| `lists.hl` | `RouteEntry` shape + `@form(vec)` storage loci (route entries, middleware) |
| `match.hl` | Pattern split + match + path/query extraction |
| `params.hl` | `path_param` / `query_param` free fns |
| `router.hl` | `Router` locus (add/use/dispatch/handle) + `NotFound404` default + dispatch chain |
