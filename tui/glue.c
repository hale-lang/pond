// pond/tui — C glue for the TUI runtime.
//
// DUPLICATE of pond/term/glue.c under `tui_`-prefixed symbols
// (flagged in FRICTION.md `glue-duplicated-from-term`). Two
// reasons it can't be shared:
//   1. G34: tier libs can't import each other (the two-hop
//      qualified-literal codegen break), so tui/ can't reach
//      term/'s Hale-side wrappers.
//   2. @ffi symbols are NOT mangled per-import (spec/ffi.md),
//      so if both libs shipped a glue.c defining `term_*` the
//      link would see duplicate symbols in any app vendoring
//      both. Per-lib C prefixes are the convention.
//
// Keep edits in sync with pond/term/glue.c.

#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static struct termios tui_saved;
static int tui_saved_valid = 0;
static int tui_raw_active = 0;
static int tui_atexit_installed = 0;

static void tui_restore_at_exit(void) {
    if (tui_raw_active && tui_saved_valid) {
        tcsetattr(STDIN_FILENO, TCSAFLUSH, &tui_saved);
        tui_raw_active = 0;
        const char *reset =
            "\x1b[?1049l\x1b[?25h\x1b[?1006l\x1b[?1002l\x1b[?2004l\x1b[0m";
        ssize_t n = write(STDOUT_FILENO, reset, strlen(reset));
        (void)n;
    }
}

int64_t tui_isatty(int64_t fd) {
    return isatty((int)fd) ? 1 : 0;
}

int64_t tui_raw_enable(void) {
    if (tui_raw_active) { return 1; }
    if (!isatty(STDIN_FILENO)) { return 0; }
    if (tcgetattr(STDIN_FILENO, &tui_saved) != 0) { return 0; }
    tui_saved_valid = 1;

    struct termios raw = tui_saved;
    raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    raw.c_oflag &= ~(OPOST);
    raw.c_cflag |= CS8;
    raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;

    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw) != 0) { return 0; }
    tui_raw_active = 1;
    if (!tui_atexit_installed) {
        atexit(tui_restore_at_exit);
        tui_atexit_installed = 1;
    }
    return 1;
}

int64_t tui_raw_disable(void) {
    if (!tui_raw_active) { return 1; }
    if (!tui_saved_valid) { return 0; }
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &tui_saved) != 0) { return 0; }
    tui_raw_active = 0;
    return 1;
}

int64_t tui_size_packed(void) {
    struct winsize ws;
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) != 0) { return 0; }
    if (ws.ws_col == 0 || ws.ws_row == 0) { return 0; }
    return ((int64_t)ws.ws_col << 16) | (int64_t)ws.ws_row;
}

int64_t tui_write_stdout(const char *s) {
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

int64_t tui_read_byte(int64_t timeout_ms) {
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
