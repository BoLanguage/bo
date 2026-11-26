/* Step debugger and state inspection, compiled into machine.c. It serves the WebAssembly host
   and the prompt of the native REPL. A program steps one top-level line at a time; with
   specialized operations off, compiled code maps one op to one list item and the interpreter
   pauses before every word call of the stepped program. Nested runs (INCLUDE, PARALLEL) are
   stepped over. The JSON functions return text owned by this file until the next call. */

extern int bo_exit_status;

static struct {
    int state, saved_opt, saved_line, last_line;
    int scratch, prev_state, prev_line; /* a prompt's program leaves what the last program left */
    long prev_steps;
    /* a program that is the text of a source file loads like one */
    int is_file;
    char *source;
    uint32_t file_tag, saved_cur_file;
    size_t saved_loading;
    Forms forms;
    Val *programs; /* the forms of each source line, as one program per line */
    int *lines;
    size_t nprograms, next, root_mark, saved_base, saved_len;
    const char *saved_source;
    long steps;
} dbg;

/* ------------------------------------------------------------------ baseline */

typedef struct { Stack *stack; Val items; } BaselineEntry;
static BaselineEntry *baseline;
static size_t baseline_n;

static int baseline_cmp(const void *x, const void *y) {
    const Stack *a = ((const BaselineEntry *)x)->stack, *b = ((const BaselineEntry *)y)->stack;
    return (a > b) - (a < b);
}

static BaselineEntry *baseline_find(Stack *s) {
    BaselineEntry key = {s, 0};
    return baseline_n ? bsearch(&key, baseline, baseline_n, sizeof key, baseline_cmp) : NULL;
}

/* Stacks as they are now are "library": later stacks and changes are the user's. */
void debug_mark_baseline(Machine *m) {
    free(baseline);
    baseline = malloc((m->tcount + 1) * sizeof *baseline);
    baseline_n = 0;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            Val items = list_from(s->items, (uint32_t)s->len);
            root_add(m, items);
            baseline[baseline_n++] = (BaselineEntry){s, items};
        }
    qsort(baseline, baseline_n, sizeof *baseline, baseline_cmp);
}

/* kernel: native primitive; library: only definitions the baseline already has, however often;
   shadows: a changed baseline stack; user: a new stack with contents; empty: nothing to show */
static const char *stack_origin(Stack *s) {
    if (!s->len && s->native) return "kernel";
    BaselineEntry *b = baseline_find(s);
    if (!s->len) return "empty";
    if (!b) return "user";
    List *base = as_list(b->items);
    if (!base->len) return "user";
    /* modules include each other, so a library stack may hold several copies of a definition */
    for (size_t i = s->len; i-- > 0;) {
        uint32_t j = 0;
        while (j < base->len && !val_equal(s->items[i], base->items[j])) j++;
        if (j == base->len) return "shadows";
    }
    return "library";
}

/* Empties the default stack and every stack the program made. A library stack the program
   changed goes back to the library's definitions; library and kernel stacks are untouched. */
void debug_clear_stacks(Machine *m) {
    m->data.len = 0;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            const char *origin = stack_origin(s);
            BaselineEntry *entry = baseline_find(s);
            if (!strcmp(origin, "user") || !strcmp(origin, "shadows")) {
                s->len = 0;
                s->owners_len = 0;
                if (!entry) s->locked = 0; /* a stack of the program, not the library's */
            }
            if (!strcmp(origin, "shadows")) {
                List *base = as_list(entry->items);
                stack_reserve(s, base->len);
                memcpy(s->items, base->items, base->len * sizeof(Val));
                s->len = base->len;
            }
        }
    m->epoch++; /* definitions changed back: compiled code must not keep the old ones */
}

/* ------------------------------------------------------------------ JSON output */

static char *json_out;

static void json_escape(Buf *o, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"') buf_str(o, "\\\"");
        else if (c == '\\') buf_str(o, "\\\\");
        else if (c == '\n') buf_str(o, "\\n");
        else if (c == '\t') buf_str(o, "\\t");
        else if (c < 0x20) {
            char t[8];
            snprintf(t, sizeof t, "\\u%04x", c);
            buf_str(o, t);
        } else buf_put(o, s + i, 1);
    }
}

/* a JSON string with the Bo text of v, cut to at most `max` bytes */
static void json_text(Buf *o, Val v, size_t max) {
    Buf t = {0};
    render(&t, v);
    size_t n = t.n;
    int cut = n > max;
    if (cut) {
        n = max;
        while (n && ((unsigned char)t.s[n] & 0xC0) == 0x80) n--;
    }
    buf_str(o, "\"");
    if (n) json_escape(o, t.s, n);
    if (cut) buf_str(o, "\xe2\x80\xa6");
    buf_str(o, "\"");
    free(t.s);
}

static void json_cstr(Buf *o, const char *s) {
    buf_str(o, "\"");
    json_escape(o, s, strlen(s));
    buf_str(o, "\"");
}

static void json_num(Buf *o, double d) {
    char t[32];
    snprintf(t, sizeof t, "%.0f", d);
    buf_str(o, t);
}

static void json_item(Buf *o, Val v, size_t max) {
    buf_str(o, is_list(v) ? "[\"l\"," : is_word(v) ? "[\"w\"," : "[\"n\",");
    json_text(o, v, max);
    buf_str(o, "]");
}

/* the name of a stack (empty for the default stack), as malloc'd text */
static char *stack_name(Machine *m, Stack *s) {
    if (s == &m->data) return strdup("");
    Buf b = {0};
    List *key = as_list(s->key);
    render(&b, key->len ? key->items[0] : s->key);
    return b.s ? b.s : strdup("");
}

static void json_stack(Buf *o, Machine *m, Stack *s, const char *name, const char *origin,
                       int with_items, long max_items, size_t max_chars) {
    buf_str(o, "{\"name\":");
    json_cstr(o, name);
    buf_str(o, ",\"origin\":");
    json_cstr(o, origin);
    buf_str(o, ",\"depth\":");
    json_num(o, (double)s->len);
    buf_str(o, s->locked ? ",\"locked\":true" : ",\"locked\":false");
    BaselineEntry *b = s == &m->data ? NULL : baseline_find(s);
    if (b) {
        buf_str(o, ",\"baseDepth\":");
        json_num(o, as_list(b->items)->len);
    }
    if (with_items) {
        size_t from = s->len > (size_t)max_items ? s->len - (size_t)max_items : 0;
        buf_str(o, ",\"hidden\":");
        json_num(o, (double)from);
        buf_str(o, ",\"items\":[");
        for (size_t i = from; i < s->len; i++) {
            if (i > from) buf_str(o, ",");
            json_item(o, s->items[i], max_chars);
        }
        buf_str(o, "]");
    }
    buf_str(o, "}");
}

static const char *finish_json(Buf *o) {
    free(json_out);
    json_out = o->s ? o->s : strdup("");
    return json_out;
}

typedef struct { Stack *stack; char *name; const char *origin; } Listed;

static int listed_cmp(const void *x, const void *y) {
    return strcmp(((const Listed *)x)->name, ((const Listed *)y)->name);
}

static void listed_free(Listed *l, size_t n) {
    for (size_t i = 0; i < n; i++) free(l[i].name);
    free(l);
}

/* the innermost code frame that still has something to run */
static Frame *debug_top_code(Machine *m) {
    for (size_t i = m->ctl_len; i > m->base; i--) {
        Frame *f = &m->ctl[i - 1];
        if (f->kind == FR_CODE && f->idx < (size_t)f->code->n) return f;
    }
    return NULL;
}

static const char *const STATUS[] = {"idle", "ready", "paused", "done", "error", "exit"};

/* Everything a visualizer draws for one step: status, the word about to run, the control
   stack, the default stack and the stacks that are the user's. Library, kernel and empty
   stacks are only counted; debug_stacks_json lists them on demand. */
const char *debug_state_json(Machine *m, long max_items, size_t max_chars) {
    Buf o = {0};
    buf_str(&o, "{\"status\":");
    json_cstr(&o, STATUS[dbg.state]);
    buf_str(&o, ",\"steps\":");
    json_num(&o, (double)dbg.steps);
    buf_str(&o, m->bp_hit ? ",\"breakpoint\":true" : ",\"breakpoint\":false");
    buf_str(&o, ",\"line\":");
    json_num(&o, dbg.state >= DBG_DONE ? dbg.last_line : m->line);
    buf_str(&o, ",\"exitCode\":");
    json_num(&o, bo_exit_status);

    buf_str(&o, ",\"next\":");
    {
        /* what a step would run: the next call or literal of the paused program, or the first
           item of its next line when this one is over */
        Frame *top = dbg.state == DBG_PAUSED ? debug_top_code(m) : NULL;
        Op *op = top ? &top->code->ops[top->idx] : NULL;
        Val item = 0;
        Stack *st = NULL;
        int literal = 0, known = 0;
        if (op && (op->kind == OP_SITE || op->kind == OP_SPECIALIZED)) {
            item = op->v;
            st = op->st;
            known = 1;
        } else if (op && op->kind == OP_PUSH) {
            item = op->v;
            literal = known = 1;
        } else if (dbg.state == DBG_PAUSED && !top && dbg.next < dbg.nprograms &&
                   as_list(dbg.programs[dbg.next])->len) {
            item = as_list(dbg.programs[dbg.next])->items[0];
            if (is_word(item)) st = stack_lookup(m, list_of1(item), 0);
            else literal = 1;
            known = 1;
        }
        if (!known) {
            buf_str(&o, "null");
        } else {
            buf_str(&o, "{\"word\":");
            json_text(&o, item, max_chars);
            buf_str(&o, ",\"origin\":");
            json_cstr(&o, literal ? "literal" : st ? stack_origin(st) : "empty");
            buf_str(&o, ",\"literal\":");
            if (literal) json_cstr(&o, is_list(item) ? "list" : "number");
            else buf_str(&o, "null");
            buf_str(&o, ",\"native\":");
            if (st && !st->len && st->native) json_cstr(&o, st->native->name);
            else buf_str(&o, "null");
            buf_str(&o, ",\"definition\":");
            if (st && st->len) json_text(&o, st->items[st->len - 1], max_chars);
            else buf_str(&o, "null");
            buf_str(&o, "}");
        }
    }

    buf_str(&o, ",\"frames\":[");
    for (size_t i = m->base; i < m->ctl_len; i++) {
        Frame *f = &m->ctl[i];
        static const char *const KIND[] = {"code", "ifte", "catch", "call", "handler", "lambda", "loop"};
        if (i > m->base) buf_str(&o, ",");
        buf_str(&o, "{\"kind\":");
        json_cstr(&o, f->kind >= 0 && f->kind <= FR_LOOP ? KIND[f->kind] : "other");
        if (f->kind == FR_CODE) {
            buf_str(&o, ",\"pos\":");
            /* the item that runs next: an op of code compiled with specializations does not map one to one */
            json_num(&o, (double)(f->idx < (size_t)f->code->n ? (size_t)f->code->ops[f->idx].src
                                                               : as_list(f->a)->len));
            buf_str(&o, ",\"list\":");
            json_text(&o, f->a, max_chars * 4);
        } else if (f->kind == FR_BRANCH || f->kind == FR_CATCH || f->kind == FR_LOOP) {
            buf_str(&o, ",\"list\":");
            json_text(&o, f->a, max_chars);
        }
        buf_str(&o, "}");
    }
    buf_str(&o, "]");

    Listed *shown = malloc((m->tcount + 1) * sizeof *shown);
    size_t nshown = 0, library = 0, kernel = 0, empty = 0;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            if (!s->exists) continue;
            const char *origin = stack_origin(s);
            if (!strcmp(origin, "library")) library++;
            else if (!strcmp(origin, "kernel")) kernel++;
            else if (!strcmp(origin, "empty")) empty++;
            else shown[nshown++] = (Listed){s, stack_name(m, s), origin};
        }
    qsort(shown, nshown, sizeof *shown, listed_cmp);

    buf_str(&o, ",\"stacks\":[");
    json_stack(&o, m, &m->data, "", "default", 1, max_items, max_chars);
    for (size_t i = 0; i < nshown; i++) {
        buf_str(&o, ",");
        json_stack(&o, m, shown[i].stack, shown[i].name, shown[i].origin, 1, max_items, max_chars);
    }
    buf_str(&o, "],\"counts\":{\"library\":");
    json_num(&o, (double)library);
    buf_str(&o, ",\"kernel\":");
    json_num(&o, (double)kernel);
    buf_str(&o, ",\"empty\":");
    json_num(&o, (double)empty);
    buf_str(&o, "}}");
    listed_free(shown, nshown);
    return finish_json(&o);
}

static int contains_nocase(const char *text, const char *part) {
    size_t n = strlen(part);
    for (; *text; text++) {
        size_t i = 0;
        while (i < n && text[i] && (text[i] | 32) == (part[i] | 32)) i++;
        if (i == n) return 1;
    }
    return n == 0;
}

#define LISTING_MAX 5000

/* Names, origins and depths of the stacks whose name contains `filter` (all if empty), for
   revealing library and kernel stacks on demand; empty stacks only if asked for. */
const char *debug_stacks_json(Machine *m, const char *filter, int include_empty) {
    Listed *all = malloc((m->tcount + 1) * sizeof *all);
    size_t n = 0;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            if (!s->exists || stack_is_private(s)) continue;
            const char *origin = stack_origin(s);
            if (!include_empty && !strcmp(origin, "empty")) continue;
            char *name = stack_name(m, s);
            if (!contains_nocase(name, filter)) { free(name); continue; }
            all[n++] = (Listed){s, name, origin};
        }
    qsort(all, n, sizeof *all, listed_cmp);
    Buf o = {0};
    buf_str(&o, "{\"total\":");
    json_num(&o, (double)n);
    buf_str(&o, ",\"stacks\":[");
    for (size_t i = 0; i < n && i < LISTING_MAX; i++) {
        if (i) buf_str(&o, ",");
        json_stack(&o, m, all[i].stack, all[i].name, all[i].origin, 0, 0, 0);
    }
    buf_str(&o, "]}");
    listed_free(all, n);
    return finish_json(&o);
}

/* One stack by word name ("" for the default stack), with its top `max_items` items. */
const char *debug_stack_json(Machine *m, const char *name, long max_items, size_t max_chars) {
    Buf o = {0};
    Stack *s = &m->data;
    if (*name) {
        Val word = from_word(as_list(str_list(name)));
        s = stack_lookup(m, list_of1(word), 0);
    }
    if (!s) {
        buf_str(&o, "null");
        return finish_json(&o);
    }
    json_stack(&o, m, s, name, s == &m->data ? "default" : stack_origin(s), 1, max_items, max_chars);
    return finish_json(&o);
}

/* ------------------------------------------------------------------ stepping */

/* Step modes: see bo.h. */

/* a list read from a file of the library: the include/ directory of the library home */
static int in_library(Machine *m, Val lst) {
    uint32_t id = as_list(lst)->owner;
    if (!id || id > m->nowners || !m->home || id == m->user_file) return 0;
    const char *path = m->owners[id - 1];
    size_t n = strlen(m->home);
    return !strncmp(path, m->home, n) && !strncmp(path + n, "/include/", 9);
}

/* a literal, or a call of something other than a kernel primitive or a breakpoint (which pauses
   by itself), in code that is not the library's */
static int user_step(Machine *m, Op *op) {
    int literal = op->kind == OP_PUSH;
    if (!literal && (!op->st || (!op->st->len && op->st->native))) return 0;
    Frame *f = &m->ctl[m->ctl_len - 1];
    return f->kind == FR_CODE && !in_library(m, f->a) &&
           (literal || !is_default_wrapper(m, op->st, op->v, "@", "BREAKPOINT"));
}

/* does an op count as a step (a pause point) in the current mode? */
static int debug_counts(Machine *m, Op *op) {
    if (m->step_mode == STEP_RUN) return 0;
    if (m->step_mode == STEP_INTO) return user_step(m, op);
    if (m->step_mode == STEP_OVER) return m->ctl_len <= m->step_depth && user_step(m, op);
    if (m->step_mode == STEP_WORDS_OVER) return op->kind != OP_PUSH && m->ctl_len <= m->step_depth;
    if (op->kind == OP_PUSH) return 0; /* the modes of the playground step over words only */
    if (m->step_mode == STEP_WORDS || m->step_arm) return 1;
    if (m->step_mode != STEP_USER) return 0;
    const char *origin = stack_origin(op->st);
    return strcmp(origin, "library") && strcmp(origin, "kernel");
}

static int debug_finish(Machine *m, int state) {
    dbg.last_line = m->line; /* the failing or last line, still reported once the program ended */
    m->ctl_len = dbg.saved_len;
    m->base = dbg.saved_base;
    m->nroots = dbg.root_mark;
    m->source = dbg.saved_source;
    m->line = dbg.saved_line;
    m->handling = 0;
    m->stepping = m->paused = m->in_pause = 0;
    m->catch_floor = 0;
    if (dbg.is_file) {
        int ok = state == DBG_DONE;
        m->cur_file = dbg.saved_cur_file;
        m->user_file = 0;
        finish_load(m, ok ? dbg.file_tag : 0, !ok);
        if (ok && m->nloading > dbg.saved_loading) free(m->loading[--m->nloading]);
        else unwind_loading(m, dbg.saved_loading); /* a file that did not load is not included */
        free(dbg.source);
        dbg.source = NULL;
        dbg.is_file = 0;
    }
    if (m->optimize_ops != dbg.saved_opt || m->step_cold) {
        m->optimize_ops = dbg.saved_opt;
        m->step_cold = 0;
        m->epoch++;
    }
    free(dbg.forms.f);
    free(dbg.programs);
    free(dbg.lines);
    dbg.forms.f = NULL;
    dbg.programs = NULL;
    dbg.lines = NULL;
    if (dbg.scratch) {
        dbg.state = dbg.prev_state;
        dbg.last_line = dbg.prev_line;
        dbg.steps = dbg.prev_steps;
        dbg.scratch = 0;
    } else {
        dbg.state = state;
    }
    return state;
}

/* Prepares a program for stepping; false (after reporting it) if the text does not read or
   another debugged program is still active. Nothing runs until debug_step. With DEBUG_FAST the
   program starts with specialized operations on, as for a prompt line that may never pause; the
   step commands turn them off (debug_resume). With DEBUG_SCRATCH it is a prompt line: when it is
   over, the status, line and steps are those of the program that ran before. */
static int debug_begin_as(Machine *m, const char *text, int flags, const char *source, int file) {
    int specialized = flags & DEBUG_FAST;
    if (dbg.state == DBG_READY || dbg.state == DBG_PAUSED || m->ctl_len != m->base) return 0;
    size_t len = strlen(text);
    LowerErr le;
    dbg.forms = (Forms){0};
    uint32_t tag = file ? file_id(m, source) : 0;
    uint32_t owner = m->private_words ? tag : 0;
    if (lower_word_forms(text, len, 1, owner, &dbg.forms, &le)) {
        free(dbg.forms.f);
        dbg.forms.f = NULL;
        /* reports the reading error */
        return file ? execute_file(m, text, len, source) : execute(m, text, len, "stdin", 1);
    }
    dbg.scratch = (flags & DEBUG_SCRATCH) != 0;
    dbg.prev_state = dbg.state;
    dbg.prev_line = dbg.last_line;
    dbg.prev_steps = dbg.steps;
    dbg.saved_opt = m->optimize_ops;
    if (m->optimize_ops && !specialized) {
        m->optimize_ops = 0;
        m->epoch++;
    }
    dbg.saved_base = m->base;
    dbg.saved_len = m->ctl_len;
    dbg.saved_source = m->source;
    dbg.saved_line = m->line;
    dbg.root_mark = m->nroots;
    dbg.is_file = file;
    if (file) {
        discard_private_stacks(m, owner);
        wipe_file(m, tag);
        dbg.saved_loading = m->nloading;
        m->loading = realloc(m->loading, (m->nloading + 1) * sizeof(char *));
        m->loading[m->nloading++] = resolve_path(source);
        dbg.saved_cur_file = m->cur_file;
        dbg.file_tag = m->cur_file = m->user_file = tag;
        dbg.source = strdup(source);
    }
    /* every top-level token is a form; the tokens of one line run as one program */
    dbg.programs = malloc((dbg.forms.n + 1) * sizeof(Val));
    dbg.lines = malloc((dbg.forms.n + 1) * sizeof(int));
    dbg.nprograms = 0;
    for (size_t lo = 0, hi; lo < dbg.forms.n; lo = hi) {
        hi = lo + 1;
        while (hi < dbg.forms.n && dbg.forms.f[hi].line == dbg.forms.f[lo].line) hi++;
        size_t total = 0;
        for (size_t i = lo; i < hi; i++) total += as_list(dbg.forms.f[i].list)->len;
        Val *items = malloc((total + 1) * sizeof(Val));
        size_t k = 0;
        for (size_t i = lo; i < hi; i++) {
            List *l = as_list(dbg.forms.f[i].list);
            memcpy(items + k, l->items, l->len * sizeof(Val));
            k += l->len;
        }
        Val program = list_from(items, (uint32_t)total);
        free(items);
        root_add(m, program);
        dbg.programs[dbg.nprograms] = program;
        dbg.lines[dbg.nprograms++] = dbg.forms.f[lo].line;
    }
    dbg.next = 0;
    dbg.steps = 0;
    bo_exit_status = -1;
    m->source = file ? dbg.source : "stdin";
    dbg.state = DBG_READY;
    return 1;
}

int debug_begin(Machine *m, const char *text, int flags) { return debug_begin_as(m, text, flags, "stdin", 0); }

int debug_load(Machine *m, const char *text) { return debug_begin(m, text, 0); }

/* Lets up to `budget` words run, then pauses before the next one (budget 0 only advances to
   the first word). `mode` is a STEP_* value. Returns the new DBG_* state. */
int debug_step(Machine *m, long budget, int mode) {
    if (dbg.state != DBG_READY && dbg.state != DBG_PAUSED) return dbg.state;
    jmp_buf jb;
    jmp_buf *saved_jmp = m->abort_jmp;
    m->abort_jmp = &jb;
    if (setjmp(jb)) {
        unwind_loading(m, 0);
        m->abort_jmp = saved_jmp;
        return debug_finish(m, bo_exit_status >= 0 ? DBG_EXIT : DBG_ERROR);
    }
    m->stepping = 1;
    m->paused = 0;
    m->in_pause = 0;
    m->resume = RESUME_NONE;
    m->catch_floor = 0;
    m->bp_hit = 0;
    m->step_base = m->base;
    m->step_budget = budget;
    m->step_mode = mode;
    for (;;) {
        if (m->ctl_len == m->base) {
            if (dbg.next == dbg.nprograms) {
                m->abort_jmp = saved_jmp;
                dbg.steps += budget - m->step_budget;
                return debug_finish(m, DBG_DONE);
            }
            m->line = dbg.lines[dbg.next];
            m->step_arm = 1;
            /* a new line starts at the first depth, whatever a tail call of the last one left */
            if (mode == STEP_OVER || mode == STEP_WORDS_OVER) m->step_depth = m->base + 1;
            push_code(m, dbg.programs[dbg.next++]);
            continue;
        }
        run_loop(m);
        if (m->paused) break;
    }
    m->abort_jmp = saved_jmp;
    m->stepping = m->paused = 0;
    trim(m); /* a BREAKPOINT leaves its own exhausted frames: the pause is in the code below them */
    m->in_pause = m->resume_host;
    m->catch_floor = m->ctl_len; /* what the prompt runs at the pause is not caught by the program */
    dbg.steps += budget;
    dbg.state = DBG_PAUSED;
    return DBG_PAUSED;
}

/* Drops the active program without running the rest of it. */
void debug_abort(Machine *m) {
    if (dbg.state == DBG_READY || dbg.state == DBG_PAUSED) debug_finish(m, DBG_IDLE);
}

/* ------------------------------------------------------------------ the prompt of a paused program */

/* Specialized operations on or off for the code that runs next: with them off, every op of
   code entered from now on is one list item, and a frame already running (its compiled code
   is now stale) runs its remaining ops through the slow path, where the step hook is. With
   `cold`, literals take that path too, for a stepper that stops at them. */
static void debug_specialize(Machine *m, int on, int cold) {
    int want = on ? dbg.saved_opt : 0;
    if (m->optimize_ops != want || m->step_cold != cold) {
        m->optimize_ops = want;
        m->step_cold = cold;
        m->epoch++;
    }
}

/* debug_step for a host that may step a program it started with specialized operations on
   (bo_debug_load_fast): anything but a free run needs one op per item. */
int debug_step_host(Machine *m, long budget, int mode) {
    if (dbg.state == DBG_READY || dbg.state == DBG_PAUSED) debug_specialize(m, mode == STEP_RUN, 0);
    /* over calls: no deeper than where the program is now (anywhere before it started) */
    if (mode == STEP_WORDS_OVER) m->step_depth = dbg.state == DBG_READY ? (size_t)-1 : m->ctl_len;
    return debug_step(m, budget, mode);
}

/* Runs a prompt line at the pause point, on the paused program's stacks. A line cannot pause
   again (it is a nested run), and it leaves the program's own state as it found it. Returns what
   execute returns; the line may have asked to resume (see debug_resume). */
int debug_eval(Machine *m, const char *text, size_t len) {
    int handling = m->handling, line = m->line;
    const char *source = m->source;
    m->resume = RESUME_NONE;
    int ok = execute(m, text, len, "stdin", 1);
    m->handling = handling;
    m->line = line;
    m->source = source;
    return ok;
}

/* Carries out the resume request that a prompt line made (RESUME_* in m->resume, which is
   cleared) and returns the new DBG_* state, or -1 if the line asked for nothing: the program
   stays paused. */
int debug_resume(Machine *m) {
    int request = m->resume;
    m->resume = RESUME_NONE;
    if (dbg.state != DBG_PAUSED || !request) return -1;
    switch (request) {
    case RESUME_STOP:
        debug_abort(m);
        return DBG_IDLE;
    case RESUME_CONTINUE:
        debug_specialize(m, 1, 0);
        return debug_step(m, 0, STEP_RUN);
    case RESUME_STEP:
        debug_specialize(m, 0, 1);
        return debug_step(m, 1, STEP_INTO);
    default: /* RESUME_NEXT */
        debug_specialize(m, 0, 1);
        m->step_depth = m->ctl_len;
        return debug_step(m, 1, STEP_OVER);
    }
}

/* a value as the REPL shows it, cut to `max` bytes */
static void render_short(Buf *o, Val v, size_t max) {
    Buf t = {0};
    render(&t, v);
    size_t n = t.n;
    int cut = n > max;
    if (cut) {
        n = max;
        while (n && ((unsigned char)t.s[n] & 0xC0) == 0x80) n--;
    }
    if (n) buf_put(o, t.s, n);
    if (cut) buf_str(o, "\xe2\x80\xa6");
    free(t.s);
}

/* Where the paused program stands, its default stack (bottom first) and what a step would do, as the prompt shows
   them after a pause. The text is owned by this file until the next call. */
const char *debug_where(Machine *m) {
    Buf o = {0};
    Frame *top = debug_top_code(m);
    buf_str(&o, "paused");
    if (top) {
        /* the nearest word of the user's code that called a frame on the way down: a branch or a
           callback has none, and the library's own words are not the user's business */
        for (Frame *f = top;; f--) {
            if (f->kind == FR_CODE && f->b && !in_library(m, f->a)) {
                buf_str(&o, " in ");
                render(&o, f->b);
                break;
            }
            if (f == &m->ctl[m->base]) break;
        }
    }
    buf_str(&o, "\n  stack:");
    size_t from = m->data.len > 10 ? m->data.len - 10 : 0;
    if (from) buf_str(&o, " \xe2\x80\xa6");
    if (m->data.len == 0) buf_str(&o, " (empty)");
    for (size_t i = from; i < m->data.len; i++) {
        buf_str(&o, " ");
        render_short(&o, m->data.items[i], 60);
    }
    buf_str(&o, "\n  step: ");
    if (top) {
        Op *op = &top->code->ops[top->idx];
        /* code compiled before the pause may have inlined a branch: only the guard ops then
           name no item of their own */
        int own = op->kind == OP_PUSH || op->kind == OP_SITE || op->kind == OP_SPECIALIZED;
        render_short(&o, own ? op->v : as_list(top->a)->items[op->src], 60);
    } else if (dbg.next < dbg.nprograms && as_list(dbg.programs[dbg.next])->len) {
        render_short(&o, as_list(dbg.programs[dbg.next])->items[0], 60); /* the next line of the program */
    } else {
        buf_str(&o, "(end)");
    }
    buf_str(&o, "\n");
    return finish_json(&o);
}

/* ------------------------------------------------------------------ starting a program

   The program of a command line (`bo --debug file.bo`, `-e CODE`). It starts with specialized
   operations on and runs to its first BREAKPOINT; or, with `stop`, stops before its first item.
   Both return the new DBG_* state, or -1 if the program could not be read (reported). */

static int debug_start(Machine *m, int stop) {
    if (!stop) return debug_step(m, 0, STEP_RUN);
    debug_specialize(m, 0, 1);
    return debug_step(m, 0, STEP_INTO);
}

int debug_start_text(Machine *m, const char *text, int stop) {
    return debug_begin(m, text, DEBUG_FAST) ? debug_start(m, stop) : -1;
}

int debug_start_file(Machine *m, const char *path, int stop) {
    char *name = find_include(m, path);
    mark_included(m, name);
    size_t len;
    char *text = read_file(name, &len);
    int state = -1;
    if (!text) {
        fprintf(stderr, "Cannot read %s: %s\n", name, strerror(errno));
    } else if (debug_begin_as(m, text, DEBUG_FAST, name, 1)) {
        state = debug_start(m, stop);
    }
    free(text);
    if (state < 0) { /* as include_file does when a file does not load */
        char *resolved = resolve_path(name);
        unmark_included(m, resolved);
        free(resolved);
    }
    free(name);
    return state;
}
