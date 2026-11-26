/* A small line editor for the REPL on a terminal (no library needed): left/right, home/end,
   delete, up/down through the history, and the usual Ctrl-A/E/B/F/K/U/W/D/L keys. */
#include <errno.h>
#include <termios.h>
#include <unistd.h>

#include "bo.h"

#define HIST_MAX 500

static char *hist[HIST_MAX];
static int nhist;

static void history_add(const char *s) {
    if (!*s || (nhist && strcmp(hist[nhist - 1], s) == 0)) return;
    if (nhist == HIST_MAX) {
        free(hist[0]);
        memmove(hist, hist + 1, (HIST_MAX - 1) * sizeof *hist);
        nhist--;
    }
    hist[nhist++] = strdup(s);
}

static int read_key(void) {
    unsigned char c;
    ssize_t r;
    while ((r = read(0, &c, 1)) < 0 && errno == EINTR) {}
    return r == 1 ? c : -1;
}

/* Redraws the prompt and the buffer, leaving the cursor at position pos. */
static void redraw(const char *prompt, const char *buf, size_t len, size_t pos) {
    printf("\r%s%.*s\033[K", prompt, (int)len, buf);
    size_t back = 0;
    for (size_t i = pos; i < len; i++)
        if (((unsigned char)buf[i] & 0xC0) != 0x80) back++;
    if (back) printf("\033[%zuD", back);
    fflush(stdout);
}

static size_t prev_char(const char *b, size_t p) {
    while (p > 0 && ((unsigned char)b[--p] & 0xC0) == 0x80) {}
    return p;
}
static size_t next_char(const char *b, size_t len, size_t p) {
    if (p < len) p++;
    while (p < len && ((unsigned char)b[p] & 0xC0) == 0x80) p++;
    return p;
}

/* Reads one line (with its newline) into out; returns 0 at end of input. */
int line_read(const char *prompt, char *out, size_t size) {
    struct termios old, raw;
    if (tcgetattr(0, &old)) return fgets(out, (int)size, stdin) != NULL;
    raw = old;
    raw.c_lflag &= ~(ICANON | ECHO);
    raw.c_cc[VMIN] = 1;
    raw.c_cc[VTIME] = 0;
    tcsetattr(0, TCSADRAIN, &raw);
    char *buf = calloc(size, 1);
    size_t len = 0, pos = 0;
    int h = nhist, ok = 1;
    char *saved = NULL;
    /* Output that did not end in a newline would be erased by the redraw of the prompt. */
    if (bo_stdout_midline) {
        putchar('\n');
        bo_stdout_midline = 0;
    }
    redraw(prompt, buf, len, pos);
    for (;;) {
        int c = read_key();
        if (c < 0 || (c == 4 && len == 0)) { ok = 0; break; }
        if (c == '\r' || c == '\n') break;
        if (c == 27) {
            int a = read_key();
            if (a != '[' && a != 'O') continue;
            int b = read_key();
            if (b >= '0' && b <= '9') {
                int d = read_key();
                while (d >= 0 && d != '~' && !(d >= 'A' && d <= 'Z')) d = read_key();
                if (b == '3' && d == '~' && pos < len) {
                    size_t n = next_char(buf, len, pos);
                    memmove(buf + pos, buf + n, len - n + 1);
                    len -= n - pos;
                } else if (b == '1' || b == '7') pos = 0;
                else if (b == '4' || b == '8') pos = len;
            } else if (b == 'D') pos = prev_char(buf, pos);
            else if (b == 'C') pos = next_char(buf, len, pos);
            else if (b == 'H') pos = 0;
            else if (b == 'F') pos = len;
            else if (b == 'A' || b == 'B') {
                int to = b == 'A' ? h - 1 : h + 1;
                if (to < 0 || to > nhist) { redraw(prompt, buf, len, pos); continue; }
                if (h == nhist) { free(saved); saved = strdup(buf); }
                h = to;
                const char *src = h == nhist ? saved : hist[h];
                snprintf(buf, size, "%s", src);
                pos = len = strlen(buf);
            }
        } else if (c == 1) pos = 0;
        else if (c == 5) pos = len;
        else if (c == 2) pos = prev_char(buf, pos);
        else if (c == 6) pos = next_char(buf, len, pos);
        else if (c == 11) { buf[pos] = 0; len = pos; }
        else if (c == 21) { memmove(buf, buf + pos, len - pos + 1); len -= pos; pos = 0; }
        else if (c == 23) {
            size_t p = pos;
            while (p > 0 && buf[p - 1] == ' ') p--;
            while (p > 0 && buf[p - 1] != ' ') p--;
            memmove(buf + p, buf + pos, len - pos + 1);
            len -= pos - p;
            pos = p;
        } else if (c == 12) printf("\033[H\033[2J");
        else if (c == 4 || c == 127 || c == 8) {
            size_t from = c == 4 ? pos : prev_char(buf, pos);
            size_t to = c == 4 ? next_char(buf, len, pos) : pos;
            if (from < to) {
                memmove(buf + from, buf + to, len - to + 1);
                len -= to - from;
                pos = from;
            }
        } else if ((c >= 32 || c == '\t') && len + 2 < size) {
            memmove(buf + pos + 1, buf + pos, len - pos + 1);
            buf[pos++] = (char)c;
            len++;
        }
        redraw(prompt, buf, len, pos);
    }
    tcsetattr(0, TCSADRAIN, &old);
    putchar('\n');
    fflush(stdout);
    if (ok) {
        history_add(buf);
        snprintf(out, size, "%s\n", buf);
    }
    free(buf);
    free(saved);
    return ok;
}
