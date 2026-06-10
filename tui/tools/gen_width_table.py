#!/usr/bin/env python3
"""Generate tui/width.hl — a complete codepoint display-width table.

Derives wcwidth-compatible widths from Python's bundled Unicode
database (no network), merges them into ranges, and emits a Hale
fn doing binary search via a nested if-tree (Hale has no const
arrays we'd want to lean on here; the if-tree is O(log n) with
zero data-structure surface).

Width rules (matching the de-facto wcwidth contract):
  0  combining marks (Mn, Me), enclosing/format controls (Cf,
     except U+00AD SOFT HYPHEN = 1), zero-width spaces, ZWJ/ZWNJ,
     variation selectors, Hangul Jamo medial vowels + final
     consonants (U+1160-11FF, U+D7B0-D7FF — they compose into
     the preceding syllable cell).
  2  East Asian Wide (W) + Fullwidth (F) — includes CJK, Hangul
     syllables, fullwidth forms, and (Unicode >= 9) the emoji
     presentation blocks.
  1  everything else.

Only non-1 ranges are emitted; the fn defaults to 1. The caller
(screen.hl char_width) handles cp == 0 (wide-char continuation
marker) and the ASCII fast path before consulting this table.

Regenerate after a Python/Unicode upgrade:
    python3 tools/gen_width_table.py > width.hl
"""

import sys
import unicodedata

MAX_CP = 0x110000

ZERO_EXTRA = set()
ZERO_EXTRA.update(range(0x1160, 0x1200))    # Hangul Jamo V+T
ZERO_EXTRA.update(range(0xD7B0, 0xD800))    # Hangul Jamo ext-B V+T
ZERO_EXTRA.update(range(0x200B, 0x2010))    # ZWSP..RLM
ZERO_EXTRA.update(range(0xFE00, 0xFE10))    # variation selectors
ZERO_EXTRA.update(range(0xE0100, 0xE01F0))  # VS supplement


def width_of(cp: int) -> int:
    if cp in ZERO_EXTRA:
        return 0
    ch = chr(cp)
    cat = unicodedata.category(ch)
    if cat in ("Mn", "Me"):
        return 0
    if cat == "Cf":
        return 1 if cp == 0x00AD else 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    return 1


def build_ranges():
    ranges = []  # (start, end_inclusive, width)
    start = None
    cur = None
    for cp in range(0x20, MAX_CP):  # below 0x20 handled by caller
        w = width_of(cp)
        if w == 1:
            if start is not None:
                ranges.append((start, cp - 1, cur))
                start = None
            continue
        if start is None:
            start, cur = cp, w
        elif w != cur:
            ranges.append((start, cp - 1, cur))
            start, cur = cp, w
    if start is not None:
        ranges.append((start, MAX_CP - 1, cur))
    return ranges


def emit(ranges, depth):
    pad = "    " * depth
    if not ranges:
        return f"{pad}return 1;\n"
    mid = len(ranges) // 2
    lo, hi, w = ranges[mid]
    out = f"{pad}if cp < {lo} {{\n"
    out += emit(ranges[:mid], depth + 1)
    out += f"{pad}}}\n"
    out += f"{pad}if cp <= {hi} {{ return {w}; }}\n"
    out += emit(ranges[mid + 1:], depth + 1)
    return out


def main():
    ranges = build_ranges()
    body = emit(ranges, 1)
    sys.stdout.write(f"""\
// pond/tui — codepoint display-width table. GENERATED FILE.
//
// Produced by tools/gen_width_table.py from Python's bundled
// Unicode database (unidata {unicodedata.unidata_version});
// {len(ranges)} merged non-narrow ranges, binary-search if-tree
// (depth ~{len(ranges).bit_length()}). Do not edit by hand —
// regenerate:
//
//     python3 tools/gen_width_table.py > width.hl
//
// Contract: width (0, 1, or 2) for any scalar >= 0x20. The
// caller (char_width in screen.hl) owns cp == 0 (wide-cell
// continuation marker) and the < 0x20 control range.

fn width_lookup(cp: Int) -> Int {{
{body}}}
""")


if __name__ == "__main__":
    main()
