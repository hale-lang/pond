# pond/crypto — friction log

The lib is fully unblocked as of v0.8.1. All stdlib-gap entries
(SHA-256, getrandom, bytes-builder, bitwise-NOT, cross-seed free-fn
dispatch) shipped 2026-05-17 and the workarounds collapsed to the
direct surface; the namespace-lotus contract deviation also retired.
Git log carries the historical trail.

Below: live observations that aren't blocking but may surface later.

## suspected-duplicate helpers

### nibble-char / nibble-value

`hex.hl` declares two helpers — `nibble_char(n) -> String` (0..15
to one hex char) and `nibble_value(c) -> Int` (byte value of an
ASCII hex digit to 0..15, -1 otherwise). The stdlib's
`__json_hex_byte` / `__json_hex_nibble` in
`runtime/stdlib/json.hl` are the same shape; if a future
pond/json or pond/jwt lib lands, those helpers should probably
graduate into a `std::text::hex` namespace or similar.

### char_at_byte

`hex.hl`'s `char_at_byte(s, i)` is `std::bytes::at(std::bytes::
from_string(s), i)` — a common shape. Anywhere a String needs
byte-level inspection (parsers, validators, codecs) the same
pattern recurs. If `std::str::byte_at(s, i) -> Int
fallible(IndexError)` landed as a one-call surface (one less
heap-copy from `from_string`), every consumer benefits. Suspected
duplicate of the pattern at `json.hl:255-260` and adjacent.
