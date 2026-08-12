# pond/agent/embeddings — local embedding vector store with cosine top-k search

Suggested alias: `emb`.

```hale
import "vendor/pond/agent/embeddings" as emb;
import "vendor/pond/math/matrix"      as mat;

let store = emb::Store { dim: 4 };

// Insert a few vectors (matrix factories are free fns as of
// hale v0.8.2's m90 enforcement).
let v_red    = mat::from_rows(1, 4, "1.0, 0.0, 0.0, 0.0");
let v_red2   = mat::from_rows(1, 4, "2.0, 1.0, 0.0, 0.0");
let v_green  = mat::from_rows(1, 4, "0.0, 1.0, 0.0, 0.0");
store.add("red",   v_red,   "primary axis");
store.add("red2",  v_red2,  "near red");
store.add("green", v_green, "orthogonal");

// Top-k cosine search against a query.
let q    = mat::from_rows(1, 4, "3.0, 1.0, 0.0, 0.0");
let rows = store.search(q, 3);
println(rows.csv);
//   red2  0.989949  near red
//   red   0.948683  primary axis
//   green 0.316228  orthogonal
```

## Storage

`Store` is a user-declared locus that owns three child `@form(vec)`
sub-loci, paired row-by-row:

| Sub-locus | Cell type | Holds                                   |
|-----------|-----------|-----------------------------------------|
| `IdBuf`   | `String`  | one id per row                          |
| `MetaBuf` | `String`  | one metadata blob per row               |
| `FloatBuf`| `Float`   | flat `count * dim` floats, row-major    |

Row `r` occupies `flat[r*dim .. (r+1)*dim)`. The three buffers are
mutated in lockstep by `Store.add` / `Store.remove`.

CONTRACTS.md declared
`capacity { heap items of Embedding; }`, but `@form(vec)` cell types
must be primitives or value-typed structs — locus refs (the
`Matrix` field inside `Embedding`) are rejected at typecheck per
`spec/forms.md`. Parallel arrays are the v1 substitute. See
FRICTION.log.

## `Store` surface

| Method                                    | Returns                          |
|-------------------------------------------|----------------------------------|
| `add(id, vector: Matrix, metadata)`       | `() fallible(EmbError)`          |
| `search(query: Matrix, k: Int)`           | `Rows fallible(EmbError)`        |
| `remove(id: String)`                      | `() fallible(EmbError)`          |
| `count()`                                 | `Int` (infallible)               |

`add` / `search` / `remove` are `fallible(EmbError)` methods
directly, matching CONTRACTS.md (migrated 2026-06-08 under the
v0.8.1 #24 v0.2 two-channel narrowing; the old sentinel-substitute
methods and paired `*_checked` free fns are retired). Callers
dispose via the standard surface:

```hale
store.add("x", v, "meta") or discard;
let rows = store.search(q, 3) or emb::Rows { csv: "" };
```

`EmbError.kind` is one of `"dim_mismatch"`, `"bad_k"`,
`"zero_magnitude"`, `"not_found"`.

## Result shape — `Rows`

`Rows.csv` is newline-separated; each row is

```
<id>\t<score>\t<metadata>
```

`<score>` is a Float formatted via `to_string`; consumers can
round-trip via `std::str::parse_float`. Rows are sorted descending
by cosine score.

## Cosine similarity

Per the spec definition:

```
cosine(a, b) = dot(a, b) / (mag(a) * mag(b))
mag(v)       = sqrt(dot(v, v))
```

`dot` runs against the stored flat buffer in row-major order
(not via `mat::Mat.dot` on a per-row temporary — saves the per-row
Matrix allocation in the hot loop). Magnitudes are recomputed per
query rather than cached; the cache would invalidate on every
`add` / `remove` and the v0 inner-loop cost is already dominated
by the per-element `lotus_vec_get` boundary.

## Embedding type — `Embedding`

```hale
type Embedding {
    id:         String;
    vector_csv: String;
    metadata:   String;
}
```

CONTRACTS.md declared `vector: Matrix` (a locus ref). Cross-seed
`type` fields can't hold a qualified locus ref at v1 (codegen
crashes in pass A0; see FRICTION.log). The `vector_csv` field is
the row-major CSV serialization — round-trips via
`embedding_from_matrix` / `to_matrix` (both free fns). The Store's
surface doesn't consume `Embedding` directly — `add` takes the
Matrix straight through.

```hale
let e = emb::embedding_from_matrix("id", v, "meta");
let m = emb::to_matrix(e);
```

## Example

```bash
$ hale build pond/agent/embeddings/examples/topk-demo/
$ ./pond/agent/embeddings/examples/topk-demo/topk-demo
count = 5
--- top-3 ---
red2    0.989949    near red
red     0.948683    primary axis
green   0.316228    orthogonal
--- ranking ---
#1 = red2 (want red2)
#2 = red (want red)
#3 = green (want green)
ok   #1 = red2
ok   #2 = red
ok   #3 = green
...
```

Embeds 5 hand-crafted 4-dim vectors, queries with a 6th, verifies
the top-3 against by-inspection ordering. Exercises the dim-
mismatch `search` failure path (`or report_dim_mismatch(err)`) and the `remove` path.

## Files

- `embeddings.hl` — the `Store` locus (add / search / remove /
  count) and the lib's doc header.
- `types.hl` — `Embedding` / `SearchHit` / `Rows` / `EmbError`
  shape types.
- `storage.hl` — the parallel `@form(vec)` sub-loci `IdBuf` /
  `MetaBuf` / `FloatBuf`.
- `helpers.hl` — pure free fns: cosine arithmetic, the argmax
  scan, row formatting, `to_matrix` / `embedding_from_matrix`.
- `examples/topk-demo/main.hl` — end-to-end demo.
- `FRICTION.log` — contract deviations, language gaps,
  duplication suspicions.
