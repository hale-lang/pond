// pond/term — C glue for the terminal control surface.
//
// Flat libc-only shims behind the @ffi("c") declarations in
// term.hl. No external link deps — `hale.toml` lists only this
// translation unit. Symbol names are `term_`-prefixed because
// @ffi symbols are NOT mangled per-import (spec/ffi.md: "the
// LLVM symbol name is the literal Hale fn name as written"), so
// every FFI-bearing pond lib must claim a unique C prefix.
// pond/tui ships its own copies under `tui_` for the same
// reason (G34 keeps tui/ from importing this lib anyway).
//
// Safety net: term_raw_enable installs an atexit hook that
// restores the saved termios and emits a best-effort screen
// reset (leave alt screen, show cursor, mouse/paste off, SGR
// reset). Every runtime panic path is exit()-shaped as of hale
// #106 (lotus_root_panic always was; the F.30b stale-view
// panic flipped from _exit to exit), so the hook covers panic,
// error, and normal return uniformly. See FRICTION.md
// `panic-exit-bypasses-atexit` (RESOLVED).

#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static struct termios term_saved;
static int term_saved_valid = 0;
static int term_raw_active = 0;
static int term_atexit_installed = 0;

static void term_restore_at_exit(void) {
    if (term_raw_active && term_saved_valid) {
        tcsetattr(STDIN_FILENO, TCSAFLUSH, &term_saved);
        term_raw_active = 0;
        // Best-effort visual reset: leave alt screen, show
        // cursor, SGR mouse off, bracketed paste off, SGR reset.
        // Disabling modes that were never enabled is a no-op.
        const char *reset =
            "\x1b[?1049l\x1b[?25h\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[0m";
        ssize_t n = write(STDOUT_FILENO, reset, strlen(reset));
        (void)n;
    }
}

// 1 when fd is a terminal, 0 otherwise.
int64_t term_isatty(int64_t fd) {
    return isatty((int)fd) ? 1 : 0;
}

// Enter raw mode on stdin. Returns 1 on success, 0 on failure
// (not a tty / tcsetattr rejected). Idempotent. ISIG is
// disabled, so Ctrl-C arrives as byte 0x03 instead of SIGINT —
// the caller owns the quit path while raw mode is active.
int64_t term_raw_enable(void) {
    if (term_raw_active) { return 1; }
    if (!isatty(STDIN_FILENO)) { return 0; }
    if (tcgetattr(STDIN_FILENO, &term_saved) != 0) { return 0; }
    term_saved_valid = 1;

    struct termios raw = term_saved;
    raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    raw.c_oflag &= ~(OPOST);
    raw.c_cflag |= CS8;
    raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;

    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw) != 0) { return 0; }
    term_raw_active = 1;
    if (!term_atexit_installed) {
        atexit(term_restore_at_exit);
        term_atexit_installed = 1;
    }
    return 1;
}

// Restore the saved termios. Returns 1 on success (including
// the not-currently-raw no-op), 0 on tcsetattr failure.
int64_t term_raw_disable(void) {
    if (!term_raw_active) { return 1; }
    if (!term_saved_valid) { return 0; }
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &term_saved) != 0) { return 0; }
    term_raw_active = 0;
    return 1;
}

// Terminal size as (cols << 16) | rows; 0 when stdout is not a
// tty or the ioctl fails. Poll this per frame instead of
// handling SIGWINCH — no signal surface needed.
int64_t term_size_packed(void) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) != 0) { return 0; }
    if (ws.ws_col == 0 || ws.ws_row == 0) { return 0; }
    return ((int64_t)ws.ws_col << 16) | (int64_t)ws.ws_row;
}

// Write s to fd 1 via raw write(2), bypassing stdio's
// line-buffering (the Hale prelude sets stdout to _IOLBF, which
// would flush a multi-line frame once per newline). Returns the
// byte count written, -1 on error. EINTR is retried.
int64_t term_write_stdout(const char *s) {
    if (s == NULL) { return 0; }
    size_t len = strlen(s);
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(STDOUT_FILENO, s + off, len - off);
        if (n < 0) {
            if (errno == EINTR) { continue; }
            return -1;
        }
        off += (size_t)n;
    }
    return (int64_t)off;
}

// Block up to timeout_ms for one byte on stdin.
// Returns 0..255 = the byte; -1 = timeout; -2 = EOF or error.
// timeout_ms <= 0 means "don't wait" (pure poll).
int64_t term_read_byte(int64_t timeout_ms) {
    struct pollfd p;
    p.fd = STDIN_FILENO;
    p.events = POLLIN;
    int rc = poll(&p, 1, (int)timeout_ms);
    if (rc == 0) { return -1; }
    if (rc < 0) { return (errno == EINTR) ? -1 : -2; }

    unsigned char b;
    ssize_t n = read(STDIN_FILENO, &b, 1);
    if (n == 1) { return (int64_t)b; }
    if (n == 0) { return -2; }
    return (errno == EINTR) ? -1 : -2;
}
