/* Lowering: source text -> numbers, lists and words (README section 3). */
#include "bo.h"

typedef struct { Val *a; size_t n, cap; } Vec;

static void vec_push(Vec *v, Val x) {
    if (v->n == v->cap) {
        v->cap = v->cap ? v->cap * 2 : 8;
        v->a = realloc(v->a, v->cap * sizeof(Val));
    }
    v->a[v->n++] = x;
}

static uint32_t decode(const unsigned char *s, size_t n, size_t *i) {
    unsigned char c = s[*i];
    uint32_t cp = c;
    int extra = 0;
    (*i)++;
    if (c >= 0xF0) { cp = c & 7; extra = 3; }
    else if (c >= 0xE0) { cp = c & 15; extra = 2; }
    else if (c >= 0xC0) { cp = c & 31; extra = 1; }
    while (extra-- > 0 && *i < n && (s[*i] & 0xC0) == 0x80) cp = (cp << 6) | (s[(*i)++] & 63);
    return cp;
}

int is_token_space(uint32_t c) {
    return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c == 0x85 || c == 0xa0 ||
           c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 ||
           c == 0x202f || c == 0x205f || c == 0x3000;
}

static int is_digit(char c) { return c >= '0' && c <= '9'; }

/* [+-]?\d+ | [+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)? */
static int looks_numeric(const char *s) {
    if (*s == '+' || *s == '-') s++;
    const char *p = s;
    int int_digits = 0, frac_digits = 0;
    while (is_digit(*p)) { p++; int_digits++; }
    if (*p == '.') {
        p++;
        while (is_digit(*p)) { p++; frac_digits++; }
        if (!int_digits && !frac_digits) return 0;
    } else if (!int_digits) {
        return 0;
    }
    if (*p == 'e' || *p == 'E') {
        p++;
        if (*p == '+' || *p == '-') p++;
        if (!is_digit(*p)) return 0;
        while (is_digit(*p)) p++;
    }
    return *p == 0;
}

/* 1 if s is a number (value in *out), 0 if not; *overflow set when it is not finite */
int parse_number_text(const char *s, double *out, int *overflow) {
    *overflow = 0;
    if (!looks_numeric(s)) return 0;
    double d = strtod(s, NULL);
    if (!isfinite(d)) {
        *overflow = 1;
        return 1;
    }
    *out = d == 0 ? 0 : d;
    return 1;
}

typedef struct {
    Vec *open;       /* stack of lists being built */
    int *open_line;
    size_t depth, cap;
    Forms *forms;
    size_t forms_cap;
} State;

static void emit(State *st, const Val *items, int cnt, int line) {
    if (st->depth) {
        for (int i = 0; i < cnt; i++) vec_push(&st->open[st->depth - 1], items[i]);
    } else {
        Forms *f = st->forms;
        if (f->n == st->forms_cap) {
            st->forms_cap = st->forms_cap ? st->forms_cap * 2 : 64;
            f->f = realloc(f->f, st->forms_cap * sizeof(Form));
        }
        f->f[f->n].line = line;
        f->f[f->n].list = list_from(items, (uint32_t)cnt);
        f->n++;
    }
}

static int fail(LowerErr *e, int line, int incomplete, const char *fmt, const char *arg) {
    snprintf(e->msg, sizeof e->msg, fmt, arg ? arg : "");
    e->line = line;
    e->incomplete = incomplete;
    return 1;
}

static void free_state(State *st) {
    for (size_t i = 0; i < st->depth; i++) free(st->open[i].a);
    free(st->open);
    free(st->open_line);
}

static int lower(const char *text, size_t n, int first_line, uint32_t owner, Forms *out,
                 LowerErr *err) {
    const unsigned char *s = (const unsigned char *)text;
    State st = {0};
    out->f = NULL;
    out->n = 0;
    st.forms = out;
    size_t i = 0;
    int line = first_line;
    while (i < n) {
        size_t j = i;
        uint32_t c = decode(s, n, &j);
        if (c == '\n') { line++; i = j; }
        else if (is_token_space(c)) i = j;
        else if (c == ';') {
            while (i < n && s[i] != '\n') i++;
        }
        else if (c == '(') {
            if (st.depth == st.cap) {
                st.cap = st.cap ? st.cap * 2 : 16;
                st.open = realloc(st.open, st.cap * sizeof(Vec));
                st.open_line = realloc(st.open_line, st.cap * sizeof(int));
            }
            st.open[st.depth] = (Vec){0};
            st.open_line[st.depth] = line;
            st.depth++;
            i = j;
        } else if (c == ')') {
            if (!st.depth) { free_state(&st); return fail(err, line, 0, "unmatched ')'", NULL); }
            st.depth--;
            Vec *v = &st.open[st.depth];
            Val l = list_from(v->a, (uint32_t)v->n);
            if (owner) as_list(l)->owner = owner; /* which file the list was read from (words: see below) */
            int start = st.open_line[st.depth];
            free(v->a);
            emit(&st, &l, 1, start);
            i = j;
        } else if (c == '"') {
            int start = line;
            Vec codes = {0};
            i = j;
            for (;;) {
                if (i >= n) { free(codes.a); free_state(&st); return fail(err, start, 1, "unterminated string", NULL); }
                size_t k = i;
                uint32_t ch = decode(s, n, &k);
                if (ch == '"') { i = k; break; }
                if (ch == '\\') {
                    if (k >= n) { free(codes.a); free_state(&st); return fail(err, start, 1, "unterminated string", NULL); }
                    size_t k2 = k;
                    uint32_t esc = decode(s, n, &k2);
                    uint32_t r;
                    switch (esc) {
                    case 'n': r = '\n'; break;
                    case 't': r = '\t'; break;
                    case '"': r = '"'; break;
                    case '\\': r = '\\'; break;
                    case 's': r = ' '; break;
                    default: {
                        char buf[8] = {0};
                        memcpy(buf, s + k, k2 - k);
                        free(codes.a);
                        free_state(&st);
                        return fail(err, line, 0, "bad escape \\%s", buf);
                    }
                    }
                    vec_push(&codes, from_num(r));
                    i = k2;
                    continue;
                }
                if (ch == '\n') line++;
                vec_push(&codes, from_num(ch));
                i = k;
            }
            Val l = list_from(codes.a, (uint32_t)codes.n);
            free(codes.a);
            emit(&st, &l, 1, start);
        } else {
            Vec codes = {0};
            char *ascii = malloc(n - i + 1);
            size_t na = 0;
            int plain = 1;
            while (i < n) {
                size_t k = i;
                uint32_t ch = decode(s, n, &k);
                if (is_token_space(ch) || ch == '(' || ch == ')' || ch == '"' || ch == ';') break;
                vec_push(&codes, from_num(ch));
                if (ch > 127 || ch == 0) plain = 0; else ascii[na++] = (char)ch;
                i = k;
            }
            ascii[na] = 0;
            double d;
            int overflow;
            if (plain && parse_number_text(ascii, &d, &overflow)) {
                if (overflow) {
                    char buf[96];
                    snprintf(buf, sizeof buf, "%.80s", ascii);
                    free(codes.a); free(ascii); free_state(&st);
                    return fail(err, line, 0, "number out of range: %s", buf);
                }
                Val v = from_num(d);
                emit(&st, &v, 1, line);
            } else {
                Val name = list_from(codes.a, (uint32_t)codes.n);
                Val unit;
                if (text_to_word(name, &unit) != WORD_OK) {
                    free(codes.a); free(ascii); free_state(&st);
                    return fail(err, line, 0, "invalid word name%s", "");
                }
                Val word = as_list(unit)->items[0];
                /* `__name`: private to the file being read */
                if (owner && codes.n >= 2 && codes.a[0] == from_num('_') && codes.a[1] == from_num('_'))
                    as_word(word)->owner = owner;
                emit(&st, &word, 1, line);
            }
            free(codes.a);
            free(ascii);
        }
    }
    if (st.depth) {
        int l0 = st.open_line[0];
        free_state(&st);
        return fail(err, l0, 1, "unmatched '('", NULL);
    }
    free_state(&st);
    return 0;
}

/* `owner` is the id of the source file being read (0 for text that is not a file): the words that
   start with `__` are private to it. */
int lower_word_forms(const char *text, size_t len, int first_line, uint32_t owner, Forms *out,
                     LowerErr *err) {
    return lower(text, len, first_line, owner, out, err);
}
