/* The Bo machine: stacks, compiled code, interpreter loop, errors (README sections 4-6). */
#include "bo.h"
#include <float.h>

#include <errno.h>
#include <limits.h>
#include <sys/wait.h>
#include <unistd.h>

static double bo_h_div(double x, double y);
static double bo_h_idiv(double x, double y);
static void swap_data(Stack *a, Stack *b);

static Val op_unit(const char *name) { return list_of1(from_op(as_list(str_list(name)))); }

static int bo_err(Machine *m, const char *kind, const char *where, Val data) {
    m->err_kind = op_unit(kind);
    m->err_where = where;
    m->err_data = data;
    return 1;
}
static int bo_err0(Machine *m, const char *kind, const char *where) {
    return bo_err(m, kind, where, list_from(NULL, 0));
}
static int bo_err1(Machine *m, const char *kind, const char *where, Val a) {
    return bo_err(m, kind, where, list_of1(a));
}

/* ------------------------------------------------------------------ data stacks */

static void stack_grow(Stack *s) {
    s->cap = s->cap ? s->cap * 2 : 16;
    s->items = realloc(s->items, s->cap * sizeof(Val));
}
static void stack_reserve(Stack *s, size_t extra) {
    while (s->cap - s->len < extra) s->cap = s->cap ? s->cap * 2 : 16;
    s->items = realloc(s->items, s->cap * sizeof(Val));
}
static inline void spush(Stack *s, Val v) {
    if (s->len == s->cap) stack_grow(s);
    s->items[s->len++] = v;
}
static inline void data_push(Machine *m, Val v) { spush(&m->data, v); }
static inline void push_num(Machine *m, double d) { spush(&m->data, from_num(d)); }

static void table_grow(Machine *m) {
    size_t ncap = m->tcap ? m->tcap * 2 : 256;
    Stack **nt = calloc(ncap, sizeof(Stack *));
    for (size_t b = 0; b < m->tcap; b++) {
        Stack *s = m->table[b];
        while (s) {
            Stack *next = s->chain;
            size_t k = s->hash & (ncap - 1);
            s->chain = nt[k];
            nt[k] = s;
            s = next;
        }
    }
    free(m->table);
    m->table = nt;
    m->tcap = ncap;
}

static Stack *stack_insert(Machine *m, Val key, uint32_t h) {
    if (m->tcount >= m->tcap) table_grow(m);
    Stack *s = calloc(1, sizeof(Stack));
    s->key = key;
    s->hash = h;
    size_t k = h & (m->tcap - 1);
    s->chain = m->table[k];
    m->table[k] = s;
    m->tcount++;
    return s;
}

/* The stack whose key list is `key` (structural identity). A Stack is never freed, because compiled
   code keeps pointers to them; `exists` says whether it counts as a stack. create = 0 only finds an
   existing one, 1 also makes it exist (a new stack, or one deleted since), and 2 only reserves the
   place (start-up dependencies of specializations), leaving it as it is. */
static Stack *stack_lookup(Machine *m, Val key, int create) {
    uint32_t h = val_hash(key);
    Stack *found = NULL;
    if (m->tcap)
        for (Stack *s = m->table[h & (m->tcap - 1)]; s; s = s->chain)
            if (s->hash == h && val_equal(s->key, key)) { found = s; break; }
    if (!found) {
        if (!create) return NULL;
        found = stack_insert(m, key, h);
    }
    if (create == 1) {
        if (!found->exists) found->creator = m->cur_file;
        found->exists = 1;
    }
    return found->exists || create ? found : NULL;
}

/* a stack named by one private op */
static int stack_is_private(const Stack *s) {
    if (!s->key || !is_list(s->key)) return 0;
    List *key = as_list(s->key);
    return key->len == 1 && is_op(key->items[0]) && as_op(key->items[0])->owner;
}

/* ------------------------------------------------------------------ compiled code */

static Code *build_code(Machine *m, List *l);

/* ------------------------------------------------------------------ control stack */

static Frame *frame_push(Machine *m, int kind) {
    if (m->ctl_len == m->ctl_cap) {
        m->ctl_cap = m->ctl_cap ? m->ctl_cap * 2 : 256;
        m->ctl = realloc(m->ctl, m->ctl_cap * sizeof(Frame));
    }
    Frame *f = &m->ctl[m->ctl_len++];
    f->kind = kind;
    f->idx = 0;
    f->code = NULL;
    f->a = f->b = 0;
    return f;
}

/* drop exhausted frames so that tail calls do not grow the control stack */
static inline void trim(Machine *m) {
    while (m->ctl_len > m->base) {
        Frame *f = &m->ctl[m->ctl_len - 1];
        if (f->kind == FR_CODE && f->idx >= (size_t)f->code->n) m->ctl_len--;
        else break;
    }
}

static Frame *push_code(Machine *m, Val lst) {
    List *l = as_list(lst);
    if (!l->len) return NULL;
    if (!l->code || l->code->epoch != m->epoch) {
        Code *old = l->code;
        l->code = build_code(m, l);
        l->code->prev = old;
    }
    Frame *f = frame_push(m, FR_CODE);
    f->code = l->code;
    f->a = lst;
    return f;
}

/* execute a stack element: a list is unwrapped into the program, a number is pushed */
static void enter(Machine *m, Val el) {
    if (is_list(el)) {
        trim(m);
        push_code(m, el);
    } else {
        data_push(m, el);
    }
}

/* ------------------------------------------------------------------ rendering */

typedef struct { char *s; size_t n, cap; } Buf;

static void buf_put(Buf *b, const char *t, size_t k) {
    if (b->n + k + 1 > b->cap) {
        b->cap = (b->n + k + 1) * 2;
        b->s = realloc(b->s, b->cap);
    }
    memcpy(b->s + b->n, t, k);
    b->n += k;
    b->s[b->n] = 0;
}
static void buf_str(Buf *b, const char *t) { buf_put(b, t, strlen(t)); }

static size_t utf8_put(char *out, uint32_t cp) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) { out[0] = (char)(0xC0 | cp >> 6); out[1] = (char)(0x80 | (cp & 63)); return 2; }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | cp >> 12); out[1] = (char)(0x80 | ((cp >> 6) & 63));
        out[2] = (char)(0x80 | (cp & 63));
        return 3;
    }
    out[0] = (char)(0xF0 | cp >> 18); out[1] = (char)(0x80 | ((cp >> 12) & 63));
    out[2] = (char)(0x80 | ((cp >> 6) & 63)); out[3] = (char)(0x80 | (cp & 63));
    return 4;
}

/* code point list -> UTF-8; returns 0 if some element is not a valid code point */
static int codes_to_utf8(Val v, Buf *b) {
    List *l = as_list(v);
    for (uint32_t i = 0; i < l->len; i++) {
        Val e = l->items[i];
        if (!is_int(e)) return 1;
        double d = as_num(e);
        if (d < 0 || d > 0x10FFFF) return 2;
        char tmp[4];
        buf_put(b, tmp, utf8_put(tmp, (uint32_t)d));
    }
    return 0;
}

static void fmt_number(Buf *b, double d) {
    char tmp[40];
    if (num_is_int(d)) {
        snprintf(tmp, sizeof tmp, "%.0f", d);
    } else {
        for (int prec = 15; prec <= 17; prec++) {
            snprintf(tmp, sizeof tmp, "%.*g", prec, d);
            if (strtod(tmp, NULL) == d) break;
        }
    }
    buf_str(b, tmp);
}

static void render(Buf *b, Val v) {
    if (is_list(v)) {
        List *l = as_list(v);
        buf_str(b, "(");
        int first = 1;
        for (uint32_t i = 0; i < l->len; i++) {
            if (!first) buf_str(b, " ");
            first = 0;
            render(b, l->items[i]);
        }
        buf_str(b, ")");
    } else if (is_op(v)) {
        codes_to_utf8(from_list(as_op(v)), b);
    } else {
        fmt_number(b, as_num(v));
    }
}

static void root_add(Machine *m, Val value) {
    if (m->nroots == m->roots_cap) {
        m->roots_cap = m->roots_cap ? m->roots_cap * 2 : 64;
        m->roots = realloc(m->roots, m->roots_cap * sizeof(Val));
        if (!m->roots) {
            fputs("out of memory\n", stderr);
            exit(2);
        }
    }
    m->roots[m->nroots++] = value;
}

static void parallel_write(FILE *out, char tag, Val value) {
    Buf b = {0};
    render(&b, value);
    fputc(tag, out);
    if (b.n) fwrite(b.s, 1, b.n, out);
    fflush(out);
    free(b.s);
}

static Val parallel_abort_error(Machine *m) {
    Val parts[5] = {
        op_unit("Evaluation-Error"), op_unit("PARALLEL"),
        list_from(NULL, 0), str_list(m->source), from_num(m->line)
    };
    return list_from(parts, 5);
}

static void parallel_child(Machine *m, Val item, Val quotation, FILE *out) {
    if (m->selected && m->selected != &m->data)
        swap_data(&m->data, m->selected);
    m->selected = NULL;
    m->data.len = 0;
    data_push(m, item);

    Val marker = list_of1(from_num(0));
    Val default_stack = list_from(NULL, 0);
    Val apply_items[3] = {quotation, default_stack, from_op(as_list(str_list("APPLY")))};
    Val attempt = list_from(apply_items, 3);
    Val handler = list_of1(marker);
    Val catch_items[4] = {attempt, handler, default_stack, from_op(as_list(str_list("CATCH")))};
    Val catch_program = list_from(catch_items, 4);
    size_t root_mark = m->nroots;
    root_add(m, catch_program);

    jmp_buf worker_abort;
    jmp_buf *saved_abort = m->abort_jmp;
    m->abort_jmp = &worker_abort;
    if (setjmp(worker_abort) == 0) {
        machine_run(m, catch_program);
    } else {
        parallel_write(out, 'E', parallel_abort_error(m));
        m->abort_jmp = saved_abort;
        m->nroots = root_mark;
        return;
    }
    m->abort_jmp = saved_abort;

    if (m->data.len && m->data.items[m->data.len - 1] == marker) {
        parallel_write(out, 'E', m->data.items[m->data.len - 2]);
    } else {
        parallel_write(out, 'R', list_from(m->data.items, (uint32_t)m->data.len));
    }
    m->nroots = root_mark;
}

/* 0: valid record, 1: file error, 2: invalid or missing worker record */
static int parallel_read(FILE *in, char *tag, Val *value) {
    if (fseek(in, 0, SEEK_END)) return 1;
    long length = ftell(in);
    if (length < 0) return 1;
    if (length < 2) return 2;
    if (fseek(in, 0, SEEK_SET)) return 1;
    *tag = (char)fgetc(in);
    size_t text_len = (size_t)length - 1;
    char *text = malloc(text_len);
    if (!text) {
        fputs("out of memory\n", stderr);
        exit(2);
    }
    if (fread(text, 1, text_len, in) != text_len) {
        free(text);
        return 1;
    }
    Forms forms = {0};
    LowerErr error;
    int bad = lower_op_forms(text, text_len, 1, 0, &forms, &error);
    free(text);
    if (bad || forms.n != 1 || !is_list(forms.f[0].list) ||
        as_list(forms.f[0].list)->len != 1 ||
        !is_list(as_list(forms.f[0].list)->items[0])) {
        free(forms.f);
        return 2;
    }
    *value = as_list(forms.f[0].list)->items[0];
    free(forms.f);
    return 0;
}

#ifdef __EMSCRIPTEN__
extern int bo_exit_status;

/* WebAssembly has no fork(): a worker runs in this process on the machine state saved before
   the first one, which is restored afterwards. Stacks first created by a worker remain (empty),
   and a stream closed by a worker stays closed. */
typedef struct { Stack *stack; Val items; int locked; int exists; uint32_t *owners; size_t owners_len; } SavedStack;

typedef struct {
    SavedStack *stacks;
    size_t nstacks;
    Val data;
    Stack *selected;
    size_t ctl_len, base, nstreams, nincluded;
    int handling, line;
    const char *source, *err_where;
    Val err_kind, err_data, err_original;
    Stream *streams;
    int exit_status;
} SavedMachine;

static int saved_stack_cmp(const void *x, const void *y) {
    const Stack *a = ((const SavedStack *)x)->stack, *b = ((const SavedStack *)y)->stack;
    return (a > b) - (a < b);
}

/* Values are immutable lists, so each stack's items are kept (and GC-rooted) as one list. */
static void machine_save(Machine *m, SavedMachine *sv) {
    sv->nstacks = m->tcount;
    sv->stacks = malloc((m->tcount + 1) * sizeof(SavedStack));
    size_t n = 0;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            Val items = list_from(s->items, (uint32_t)s->len);
            root_add(m, items);
            size_t kept = s->owners_len < s->len ? s->owners_len : s->len;
            uint32_t *owners = kept ? memcpy(malloc(kept * sizeof *owners), s->owners, kept * sizeof *owners) : NULL;
            sv->stacks[n++] = (SavedStack){s, items, s->locked, s->exists, owners, kept};
        }
    qsort(sv->stacks, n, sizeof(SavedStack), saved_stack_cmp);
    sv->data = list_from(m->data.items, (uint32_t)m->data.len);
    root_add(m, sv->data);
    sv->selected = m->selected;
    sv->ctl_len = m->ctl_len; sv->base = m->base;
    sv->handling = m->handling; sv->line = m->line;
    sv->source = m->source; sv->err_where = m->err_where;
    sv->err_kind = m->err_kind; sv->err_data = m->err_data; sv->err_original = m->err_original;
    root_add(m, sv->err_kind); root_add(m, sv->err_data); root_add(m, sv->err_original);
    sv->exit_status = bo_exit_status;
    sv->nincluded = m->nincluded;
    sv->nstreams = m->nstreams;
    sv->streams = malloc(m->nstreams * sizeof(Stream));
    memcpy(sv->streams, m->streams, m->nstreams * sizeof(Stream));
}

static void stack_restore(Stack *s, Val items, int locked, const uint32_t *owners, size_t owners_len) {
    List *l = as_list(items);
    s->len = 0;
    if (l->len) {
        stack_reserve(s, l->len);
        memcpy(s->items, l->items, l->len * sizeof(Val));
        s->len = l->len;
    }
    s->locked = locked;
    s->owners_len = 0;
    if (owners_len) {
        if (s->owners_cap < owners_len) {
            s->owners = realloc(s->owners, owners_len * sizeof *s->owners);
            s->owners_cap = owners_len;
        }
        memcpy(s->owners, owners, owners_len * sizeof *s->owners);
        s->owners_len = owners_len;
    }
}

static void machine_restore(Machine *m, const SavedMachine *sv) {
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            SavedStack key = {s, 0, 0, 0, NULL, 0};
            SavedStack *found = bsearch(&key, sv->stacks, sv->nstacks, sizeof(SavedStack), saved_stack_cmp);
            if (found) {
                stack_restore(s, found->items, found->locked, found->owners, found->owners_len);
                s->exists = found->exists; /* a worker may have deleted it */
            } else { s->len = 0; s->locked = 0; s->owners_len = 0; }
        }
    stack_restore(&m->data, sv->data, 0, NULL, 0);
    m->selected = sv->selected;
    m->ctl_len = sv->ctl_len; m->base = sv->base;
    m->handling = sv->handling; m->line = sv->line;
    m->source = sv->source; m->err_where = sv->err_where;
    m->err_kind = sv->err_kind; m->err_data = sv->err_data; m->err_original = sv->err_original;
    if (m->nincluded > sv->nincluded) {
        for (size_t i = sv->nincluded; i < m->nincluded; i++) free(m->included[i]);
        m->nincluded = sv->nincluded;
    }
    bo_exit_status = sv->exit_status;
    for (size_t i = sv->nstreams; i < m->nstreams; i++)
        if (m->streams[i].f) fclose(m->streams[i].f);
    m->nstreams = sv->nstreams;
    memcpy(m->streams, sv->streams, sv->nstreams * sizeof(Stream));
    m->epoch++; /* restored stacks may be dependencies of compiled specializations */
}
#endif

static int n_parallel(Machine *m, Val *a) {
    if (!is_list(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    if (!is_list(a[1])) return bo_err1(m, "Type-Error", NULL, a[1]);
    List *inputs = as_list(a[0]);
    if (!inputs->len) {
        data_push(m, list_from(NULL, 0));
        return 0;
    }

#ifdef __EMSCRIPTEN__
    size_t workers = 1;
#else
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    size_t workers = online > 0 ? (size_t)online : 1;
    if (workers > inputs->len) workers = inputs->len;
#endif
    Val *results = calloc(inputs->len, sizeof(Val));
    pid_t *pids = calloc(workers, sizeof(pid_t));
    FILE **files = calloc(workers, sizeof(FILE *));
    if (!results || !pids || !files) {
        fputs("out of memory\n", stderr);
        exit(2);
    }

    size_t root_mark = m->nroots;
    root_add(m, a[0]);
    root_add(m, a[1]);
#ifdef __EMSCRIPTEN__
    SavedMachine saved;
    machine_save(m, &saved);
#endif
    Val first_error = 0;
    int io_error = 0;
    int io_errno = 0;
    for (uint32_t start = 0; start < inputs->len && !io_error;) {
        size_t count = inputs->len - start;
        if (count > workers) count = workers;
        size_t launched = 0;
        for (; launched < count; launched++) {
            files[launched] = tmpfile();
            if (!files[launched]) { io_error = 1; io_errno = errno; break; }
            if (fflush(NULL) == EOF) {
                io_error = 1;
                io_errno = errno ? errno : EIO;
                break;
            }
#ifdef __EMSCRIPTEN__
            parallel_child(m, inputs->items[start + launched], a[1], files[launched]);
            machine_restore(m, &saved);
#else
            pids[launched] = fork();
            if (pids[launched] < 0) { io_error = 1; io_errno = errno; break; }
            if (!pids[launched]) {
                parallel_child(m, inputs->items[start + launched], a[1], files[launched]);
                _exit(0);
            }
#endif
        }
        for (size_t i = 0; i < launched; i++) {
#ifndef __EMSCRIPTEN__
            int status;
            pid_t waited;
            do {
                waited = waitpid(pids[i], &status, 0);
            } while (waited < 0 && errno == EINTR);
            if (waited < 0 || !WIFEXITED(status)) {
                io_error = 1;
                if (!io_errno) io_errno = waited < 0 ? errno : EIO;
                continue;
            }
            if (WEXITSTATUS(status)) {
                if (!first_error) first_error = parallel_abort_error(m);
                continue;
            }
#endif
            char tag;
            Val value;
            int read_status = parallel_read(files[i], &tag, &value);
            if (read_status == 1) {
                io_error = 1;
                if (!io_errno) io_errno = EIO;
                continue;
            }
            if (read_status == 2 || (tag != 'R' && tag != 'E')) {
                if (!first_error) first_error = parallel_abort_error(m);
                continue;
            }
            if (tag == 'E') {
                if (!first_error) first_error = value;
            } else {
                results[start + i] = value;
                root_add(m, value);
            }
        }
        for (size_t i = 0; i < count; i++) {
            if (files[i]) fclose(files[i]);
            files[i] = NULL;
        }
        if (launched != count) io_error = 1;
        if (!io_error) start += count;
    }

    if (first_error) {
        spush(m->diagnostics, first_error);
        m->err_original = first_error;
    }
    if (!first_error && !io_error)
        data_push(m, list_from(results, inputs->len));
    m->nroots = root_mark;
#ifdef __EMSCRIPTEN__
    free(saved.stacks);
    free(saved.streams);
#endif
    free(results);
    free(pids);
    free(files);
    if (first_error) return 2;
    if (io_error) return bo_err1(m, "Io-Error", NULL, from_num(io_errno ? io_errno : EIO));
    return 0;
}

/* ------------------------------------------------------------------ errors */

static void default_handler(Machine *m, Val el) {
    List *l = as_list(el);
    Buf kind = {0}, where = {0}, data = {0}, source = {0};
    render(&kind, as_list(l->items[0])->items[0]);
    render(&where, as_list(l->items[1])->items[0]);
    codes_to_utf8(l->items[3], &source);
    render(&data, l->items[2]);
    fflush(stdout);
    fprintf(stderr, "Uncaught Exception -- %s:%.0f %s (%s) %s\n",
            source.s ? source.s : "", as_num(l->items[4]),
            kind.s ? kind.s : "", where.s ? where.s : "", data.s ? data.s : "");
    free(kind.s); free(where.s); free(data.s); free(source.s);
    if (m->abort_jmp) longjmp(*m->abort_jmp, 1);
    exit(1);
}

/* whether a CATCH or CALL body of an enclosing run, below the segment of this one, is active */
static int outer_catcher(Machine *m) {
    for (size_t d = m->base; d > m->catch_floor; d--) {
        if ((m->ctl[d - 1].kind == FR_CALL && m->ctl[d - 1].idx == 1) || m->ctl[d - 1].kind == FR_CATCH)
            return 1;
    }
    return 0;
}

/* An error is pending in m->err_*: build the error list, unwind to the nearest CATCH of
   this run, else hand it to a CATCH of an enclosing run (an INCLUDE nested in it ends with the
   error), else run the EXCEPTION handler, else abort. */
static void fail(Machine *m) {
    Val el;
    if (m->err_original) {
        el = m->err_original;
        m->err_original = 0;
    } else {
        Val parts[5] = {m->err_kind, op_unit(m->err_where ? m->err_where : "EXECUTE"), m->err_data,
                        str_list(m->source), from_num(m->line)};
        el = list_from(parts, 5);
        spush(m->diagnostics, el);
    }
    data_push(m, el);
    for (size_t d = m->ctl_len; d > m->base; d--) {
        if (m->ctl[d - 1].kind == FR_CALL && m->ctl[d - 1].idx == 1) {
            for (size_t i = d; i < m->ctl_len; i++)
                if (m->ctl[i].kind == FR_END) m->handling = 0;
            m->ctl_len = d;
            Frame *f = &m->ctl[d - 1];
            f->idx = 3;
            f->b = el;
            m->data.len--;
            push_code(m, as_list(f->a)->items[3]);
            return;
        }
        if (m->ctl[d - 1].kind == FR_CATCH) {
            Val h = m->ctl[d - 1].a;
            for (size_t i = d - 1; i < m->ctl_len; i++)
                if (m->ctl[i].kind == FR_END) m->handling = 0;
            m->ctl_len = d - 1;
            enter(m, h);
            return;
        }
    }
    if (outer_catcher(m)) {
        for (size_t i = m->base; i < m->ctl_len; i++)
            if (m->ctl[i].kind == FR_END) m->handling = 0;
        m->ctl_len = m->base;
        m->data.len--;
        m->err_original = el;
        m->propagating = 1;
        return;
    }
    Stack *ex = m->exception;
    if (m->handling || !ex->len) {
        m->data.len--;
        default_handler(m, el);
    }
    m->handling = 1;
    frame_push(m, FR_END);
    enter(m, ex->items[ex->len - 1]);
}

/* ------------------------------------------------------------------ native calls */

static int get_ref(Machine *m, Val ref, int create, Stack **s, int *is_default);
static void stack_changed(Machine *m, Stack *s);

static int n_lock(Machine *m, Val *a);
static int n_unlock(Machine *m, Val *a);

static void swap_data(Stack *a, Stack *b) {
    Val *items = a->items; a->items = b->items; b->items = items;
    size_t len = a->len; a->len = b->len; b->len = len;
    size_t cap = a->cap; a->cap = b->cap; b->cap = cap;
}

static int call_native(Machine *m, const Native *nat) {
    Stack *d = &m->data;
    int ar = nat->arity;
    if (!nat->transfer) {
        if (!d->len) return bo_err0(m, "Stack-Error", nat->name);
        Val selector = d->items[d->len - 1];
        Stack *selected;
        int is_default;
        if (get_ref(m, selector, 1, &selected, &is_default)) {
            if (!m->err_where) m->err_where = nat->name;
            return 1;
        }
        d->len--;
        if (!is_default && selected->locked &&
            (ar || !strcmp(nat->name, "CLEAR") || !strcmp(nat->name, "DELETE")))
            return bo_err1(m, "Permission-Error", nat->name, selector);
        if (!is_default) swap_data(d, selected);
        m->selected = selected;
        if (d->len < (size_t)ar) {
            if (!is_default) swap_data(d, selected);
            m->selected = NULL;
            return bo_err0(m, "Stack-Error", nat->name);
        }
        /* INCLUDE can execute code while the selected stack is swapped in. */
        if (!is_default) stack_changed(m, selected);
        Val a[4];
        d->len -= ar;
        for (int i = 0; i < ar; i++) a[i] = d->items[d->len + i];
        int rc = nat->fn(m, a);
        if (rc == 1) {
            for (int i = 0; i < ar; i++) spush(d, a[i]);
            if (!m->err_where) m->err_where = nat->name;
        }
        if (!is_default) swap_data(d, selected);
        m->selected = NULL;
        /* the operation may have moved entries around, so who pushed them is no longer known */
        if (!is_default && selected->owners_len && nat->fn != n_lock && nat->fn != n_unlock)
            selected->owners_len = 0;
        if (!is_default) stack_changed(m, selected);
        return rc;
    }
    if (d->len < (size_t)ar) return bo_err0(m, "Stack-Error", nat->name);
    Val a[4];
    d->len -= ar;
    for (int i = 0; i < ar; i++) a[i] = d->items[d->len + i];
    int rc = nat->fn(m, a);
    if (rc == 1) {
        for (int i = 0; i < ar; i++) spush(d, a[i]);
        if (!m->err_where) m->err_where = nat->name;
    }
    return rc;
}

static double floordiv(double x, double y);

/* ------------------------------------------------------------------ compiler */

static int hot_of(const Instr *ins) {
    switch (ins->kind) {
    case I_PUSH: return H_PUSH;
    case I_SPECIALIZED: return ins->hot;
    case I_IFTE_GUARD: return H_NOP; /* hot code runs only at its compiled epoch */
    case I_JMP: return H_JMP;
    case I_BR: case I_BRL: return H_BR;
    case I_LOOP_GUARD: return H_NOP;
    }
    return H_COLD;
}

typedef struct { Instr *instrs; int n, cap, src; } Cb;

static int cb_emit(Cb *b, Instr ins) {
    if (b->n == b->cap) {
        b->cap = b->cap ? b->cap * 2 : 32;
        b->instrs = realloc(b->instrs, (size_t)b->cap * sizeof(Instr));
    }
    ins.src = b->src;
    b->instrs[b->n] = ins;
    return b->n++;
}

#define INLINE_MAX_OPS 4000
#define INLINE_MAX_DEPTH 6

static int pushed_list(Cb *b, int i) { return b->instrs[i].kind == I_PUSH && is_list(b->instrs[i].v); }

static int name_is(Val name, const char *text) {
    List *codes = is_op(name) ? as_op(name) : is_list(name) ? as_list(name) : NULL;
    if (!codes || codes->len != strlen(text)) return 0;
    for (uint32_t i = 0; i < codes->len; i++)
        if (!is_int(codes->items[i]) || as_num(codes->items[i]) != (unsigned char)text[i])
            return 0;
    return 1;
}

static const struct { const char *op, *primitive; int hot; } specializations[] = {
    {"drop", "DROP", H_DROP}, {"pick", "PICK", H_COLD}, {"roll", "ROLL", H_COLD},
    {"ifte", "IFTE", H_COLD}, {"+", "ADD", H_ADD}, {"-", "SUB", H_SUB},
    {"*", "MUL", H_MUL}, {"/", "DIV", H_DIV}, {"//", "IDIV", H_IDIV},
    {"=", "EQUAL", H_EQ}, {"rec", "REC", H_REC0},
    {"loop", "LOOP", H_COLD}, /* compiled to jumps in compile_list; listed to track its definition */
};

static Stack *primitive_stack(Machine *m, const char *name) {
    Val op = from_op(as_list(str_list(name)));
    return stack_lookup(m, list_of1(op), 0);
}

static int is_default_wrapper(Machine *m, Stack *st, Val name,
                              const char *op, const char *primitive) {
    if (!st || !st->len || !name_is(name, op) || !is_list(st->items[st->len - 1]))
        return 0;
    List *definition = as_list(st->items[st->len - 1]);
    if (!definition->len || !is_list(definition->items[0]) ||
        as_list(definition->items[0])->len != 0)
        return 0;
    int primitive_match = definition->len == 2 && is_op(definition->items[1]) &&
                          name_is(definition->items[1], primitive);
    Stack *target = primitive_match ? primitive_stack(m, primitive) : NULL;
    return target && target->native && !target->len &&
           !strcmp(target->native->name, primitive);
}

static int wrapper_specialization(Machine *m, Stack *st, Val name) {
    for (size_t i = 0; i < sizeof specializations / sizeof specializations[0]; i++) {
        if (specializations[i].hot != H_COLD &&
            is_default_wrapper(m, st, name, specializations[i].op, specializations[i].primitive))
            return specializations[i].hot;
    }
    return H_COLD;
}

static int fold_literal_site(Machine *m, Cb *b, Stack *st, Val name,
                             int fence, int can) {
    int literal = b->n - 1;
    if (!can || literal < fence || b->instrs[literal].kind != I_PUSH)
        return 0;
    Val value = b->instrs[literal].v;
    int pick = is_default_wrapper(m, st, name, "pick", "PICK");
    int roll = is_default_wrapper(m, st, name, "roll", "ROLL");
    if ((pick || roll) && is_int(value) && as_num(value) >= 0 && as_num(value) < 64) {
        int hot = pick ? H_PICKK : H_ROLLK;
        b->n = literal;
        cb_emit(b, (Instr){.kind = I_SPECIALIZED, .hot = hot, .st = st, .v = name,
                        .a = (int)as_num(value) + 1});
        return 1;
    }
    return 0;
}

/* Inline literal default-stack branches and recognize direct kernel wrappers. */
static void compile_list(Machine *m, Cb *b, List *l, int depth) {
    int fence = b->n; /* instructions before this index belong to an enclosing structure */
    int can = m->optimize_instrs && depth < INLINE_MAX_DEPTH;
    for (uint32_t i = 0; i < l->len; i++) {
        if (depth == 0) b->src = (int)i;
        Val v = l->items[i];
        if (is_op(v)) {
            Val key = list_of1(v);
            Stack *st = stack_lookup(m, key, 0);
            int n = b->n;
            if (can && i >= 3 && n < INLINE_MAX_OPS && n - fence >= 3 &&
                is_default_wrapper(m, st, v, "ifte", "IFTE") &&
                pushed_list(b, n - 3) && pushed_list(b, n - 2) && pushed_list(b, n - 1) &&
                b->instrs[n - 3].v == l->items[i - 3] &&
                b->instrs[n - 2].v == l->items[i - 2] &&
                b->instrs[n - 1].v == l->items[i - 1]) {
                Val c = b->instrs[n - 3].v, t = b->instrs[n - 2].v, e = b->instrs[n - 1].v;
                b->n -= 3;
                int guard = cb_emit(b, (Instr){.kind = I_IFTE_GUARD, .st = st,
                                            .v = from_list(l), .a = (int)i});
                compile_list(m, b, as_list(c), depth + 1);
                int br = cb_emit(b, (Instr){.kind = I_BR});
                compile_list(m, b, as_list(t), depth + 1);
                int jmp = cb_emit(b, (Instr){.kind = I_JMP});
                b->instrs[br].a = b->n;
                compile_list(m, b, as_list(e), depth + 1);
                b->instrs[guard].b = b->instrs[jmp].a = b->instrs[br].b = b->n;
                fence = b->n;
                continue;
            }
            /* (c) (b) loop: c; leave when false; b; back to the start. */
            if (can && i >= 2 && n < INLINE_MAX_OPS && n - fence >= 2 &&
                is_default_wrapper(m, st, v, "loop", "LOOP") &&
                pushed_list(b, n - 2) && pushed_list(b, n - 1) &&
                b->instrs[n - 2].v == l->items[i - 2] &&
                b->instrs[n - 1].v == l->items[i - 1]) {
                Val c = b->instrs[n - 2].v, body = b->instrs[n - 1].v;
                b->n -= 2;
                int guard = cb_emit(b, (Instr){.kind = I_LOOP_GUARD, .st = st,
                                            .v = from_list(l), .a = (int)i});
                int top = b->n;
                compile_list(m, b, as_list(c), depth + 1);
                int br = cb_emit(b, (Instr){.kind = I_BRL});
                compile_list(m, b, as_list(body), depth + 1);
                cb_emit(b, (Instr){.kind = I_JMP, .a = top});
                b->instrs[guard].b = b->instrs[br].a = b->instrs[br].b = b->n;
                fence = b->n;
                continue;
            }
            if (fold_literal_site(m, b, st, v, fence, can)) continue;
            cb_emit(b, (Instr){.kind = I_SITE, .st = st, .v = v});
            continue;
        }
        cb_emit(b, (Instr){.kind = I_PUSH, .v = v});
    }
}

/* nothing runs after instruction i in this code, following the forward jumps that end a branch */
static int is_tail(Code *c, int i) {
    int j = i + 1;
    while (j < c->n && c->instrs[j].kind == I_JMP && c->instrs[j].a > j) j = c->instrs[j].a;
    return j >= c->n;
}

static Code *build_code(Machine *m, List *l) {
    Cb b = {0};
    compile_list(m, &b, l, 0);
    size_t bytes = sizeof(Code) + ((size_t)b.n + 1) * sizeof(Instr); /* one spare instruction: the end sentinel */
    Code *c = malloc(bytes);
    heap_alloc += bytes;
    memcpy(c->instrs, b.instrs, (size_t)b.n * sizeof(Instr));
    free(b.instrs);
    c->instrs[b.n] = (Instr){.kind = I_END};
    c->n = b.n;
    c->keep = 0;
    c->prev = NULL;
    c->epoch = m->epoch;
    for (int i = 0; i < c->n; i++) {
        Instr *ins = &c->instrs[i];
        if (ins->kind == I_SPECIALIZED) {
            ins->tail = is_tail(c, i);
            continue;
        }
        if (ins->kind != I_SITE) continue;
        ins->tail = is_tail(c, i);
        int specialization = m->optimize_instrs ? wrapper_specialization(m, ins->st, ins->v) : H_COLD;
        if (m->optimize_instrs && specialization == H_COLD && ins->st && ins->st->native &&
            !ins->st->len && !strcmp(ins->st->native->name, "REC"))
            specialization = H_REC;
        /* only a REC with nothing after it can be a jump: it replaces its own frame */
        if ((specialization == H_REC || specialization == H_REC0) && !ins->tail)
            specialization = H_COLD;
        if (specialization != H_COLD) {
            ins->kind = I_SPECIALIZED;
            ins->hot = specialization;
        }
    }
    for (int i = 0; i <= c->n; i++)
        /* a stepper that stops at literals must see them: they leave the register loop */
        c->instrs[i].hot = m->step_cold && c->instrs[i].kind == I_PUSH ? H_COLD : hot_of(&c->instrs[i]);
    return c;
}

/* a call site run the ordinary way: execute the top definition, or the kernel routine */
static int site_slow(Machine *m, Instr *ins) {
    Stack *s = ins->st;
    if (!s) s = stack_lookup(m, list_of1(ins->v), 0);
    if (s && s->len) {
        Val top = s->items[s->len - 1];
        if (is_list(top)) {
            trim(m);
            Frame *f = push_code(m, top);
            if (f) f->b = ins->v; /* the frame remembers the op that called it, for the backtrace */
        } else {
            data_push(m, top);
        }
        return 0;
    }
    if (s && s->native) {
        return call_native(m, s->native);
    }
    return bo_err1(m, "Existence-Error", "EXECUTE", list_of1(ins->v));
}

static int do_branch(Machine *m, Val then, Val otherwise) {
    if (!m->data.len) return bo_err0(m, "Stack-Error", "IFTE");
    Val truth = m->data.items[--m->data.len];
    if (!is_num(truth)) {
        data_push(m, truth);
        return bo_err1(m, "Type-Error", "IFTE", truth);
    }
    enter(m, as_num(truth) > 0 ? then : otherwise);
    return 0;
}

static int debug_counts(Machine *m, Instr *ins);

/* Does the stepper pause before instruction ins (index i of frame f)? If so the frame is left
   to resume at it; if the instruction is a step that may run, it is paid for. */
static inline int step_gate(Machine *m, Frame *f, size_t i, Instr *ins) {
    if (!m->stepping || m->base != m->step_base || !debug_counts(m, ins)) return 0;
    if (m->step_budget <= 0) { f->idx = i; m->paused = 1; return 1; }
    m->step_budget--;
    m->step_arm = 0;
    /* a tail call leaves no frame of its caller: what it runs is deeper than that */
    if ((m->step_mode == STEP_OVER || m->step_mode == STEP_OPS_OVER) && ins->tail && m->ctl_len)
        m->step_depth = m->ctl_len - 1;
    return 0;
}

static void run_loop(Machine *m) {
    while (m->ctl_len > m->base) {
        if (heap_alloc > heap_gc_at) gc_collect(m);
        Frame *f = &m->ctl[m->ctl_len - 1];
        int rc = 0;
        switch (f->kind) {
        case FR_CODE: {
            Code *c = f->code;
            Stack *d = &m->data;
            size_t i = f->idx, n = (size_t)c->n;
            /* A frame keeps running its compiled version; stale specialized sites use normal calls. */
            int stale = c->epoch != m->epoch;
            for (;;) {
                Instr *ins;
                /* Hot part: literals, jumps and compiler specializations run on the data stack held
                   in locals. Anything else (or any failed check) leaves through "cold" with
                   the stack written back, and the ordinary code below deals with it. */
                if (!stale) {
                    size_t need = 2 * n + 4; /* most an instruction sequence without a backward jump can push */
                    if (d->cap - d->len < need) stack_reserve(d, need);
                    Val *it = d->items;
                    size_t len = d->len;
                    static const void *const T[H_COUNT] = {
                        &&L_COLD, &&L_PUSH, &&L_NOP, &&L_JMP, &&L_BR, &&L_DROP, &&L_ADD,
                        &&L_SUB, &&L_MUL, &&L_EQ, &&L_DIV, &&L_IDIV, &&L_PICKK, &&L_ROLLK,
                        &&L_REC, &&L_REC0};
#define NEXT() do { ins = &c->instrs[i]; goto *T[ins->hot]; } while (0)
#define NUM2 (len >= 2 && is_num(it[len - 2]) && is_num(it[len - 1]))
#define XY double x = as_num(it[len - 2]), y = as_num(it[len - 1])
#define SETT(t) do { it[len - 2] = from_num(t); len--; i++; NEXT(); } while (0)
#define NEED(k) if (len < (k)) goto L_COLD
#define ARITH(lbl, expr) lbl: { if (!NUM2) goto L_COLD; XY; double r = (expr); if (!isfinite(r)) goto L_COLD; SETT(r); }
                    NEXT();
                L_PUSH: it[len++] = ins->v; i++; NEXT();
                L_NOP: i++; NEXT();
                L_JMP:
                    if ((size_t)ins->a <= i) {
                        d->len = len;
                        if (heap_alloc > heap_gc_at) { f->idx = (size_t)ins->a; goto next; }
                        if (d->cap - len < need) stack_reserve(d, need);
                        it = d->items;
                    }
                    i = (size_t)ins->a;
                    NEXT();
                L_BR: {
                    if (!len || !is_num(it[len - 1])) goto L_COLD;
                    double t = as_num(it[--len]);
                    i = t > 0 ? i + 1 : (size_t)ins->a;
                    NEXT();
                }
                L_DROP: NEED(1); len--; i++; NEXT();
                ARITH(L_ADD, x + y)
                ARITH(L_SUB, x - y)
                ARITH(L_MUL, x * y)
                L_EQ: {
                    NEED(2);
                    Val a2 = it[len - 2], b2 = it[len - 1];
                    SETT(val_equal(a2, b2));
                }
#define DIVOP(lbl, fn) lbl: { if (!NUM2) goto L_COLD; XY; double r = fn(x, y); if (r != r) goto L_COLD; \
                    it[len - 2] = from_num(r); len--; i++; NEXT(); }
                DIVOP(L_DIV, bo_h_div)
                DIVOP(L_IDIV, bo_h_idiv)
                L_PICKK: {
                    size_t k = (size_t)ins->a - 1;
                    NEED(k + 1); it[len] = it[len - 1 - k]; len++; i++; NEXT();
                }
                L_ROLLK: {
                    size_t k = (size_t)ins->a - 1;
                    NEED(k + 1);
                    Val t = it[len - 1 - k];
                    memmove(&it[len - 1 - k], &it[len - k], k * sizeof(Val));
                    it[len - 1] = t; i++; NEXT();
                }
                /* REC, when the lambda it re-enters is the frame right below this one running the
                   same list: the frame would be replaced by an identical one, so start over. */
#define RECJUMP(match, drop_label) do { \
                    Frame *lf = m->ctl_len >= m->base + 2 ? &m->ctl[m->ctl_len - 2] : NULL; \
                    if (!lf || lf->kind != FR_LAMBDA || lf->b != f->a || !(match)) goto L_COLD; \
                    len -= (drop_label); \
                    d->len = len; \
                    if (heap_alloc > heap_gc_at) { f->idx = 0; goto next; } \
                    if (d->cap - len < need) stack_reserve(d, need); \
                    it = d->items; \
                    i = 0; \
                    NEXT(); \
                } while (0)
                L_REC: NEED(1); RECJUMP(val_equal(lf->a, it[len - 1]), 1);
                L_REC0: RECJUMP(is_list(lf->a) && as_list(lf->a)->len == 0, 0);
                L_COLD:
                    d->len = len;
                }
                if (i >= n) { m->ctl_len--; goto next; }
                ins = &c->instrs[i];
                switch (ins->kind) {
                case I_PUSH:
                    if (step_gate(m, f, i, ins)) return;
                    spush(d, ins->v); i++; continue;
                case I_IFTE_GUARD:
                    if (is_default_wrapper(m, ins->st, as_list(ins->v)->items[ins->a],
                                           "ifte", "IFTE")) { i++; continue; }
                    {
                        /* A stale frame must call the replacement with the original operands. */
                        List *source = as_list(ins->v);
                        spush(d, source->items[ins->a - 3]);
                        spush(d, source->items[ins->a - 2]);
                        spush(d, source->items[ins->a - 1]);
                        f->idx = (size_t)ins->b;
                        Instr site = *ins;
                        site.v = source->items[ins->a];
                        rc = site_slow(m, &site);
                        if (rc) goto done;
                        goto next;
                    }
                case I_LOOP_GUARD:
                    if (is_default_wrapper(m, ins->st, as_list(ins->v)->items[ins->a],
                                           "loop", "LOOP")) { i++; continue; }
                    {
                        List *source = as_list(ins->v);
                        spush(d, source->items[ins->a - 2]);
                        spush(d, source->items[ins->a - 1]);
                        f->idx = (size_t)ins->b;
                        Instr site = *ins;
                        site.v = source->items[ins->a];
                        rc = site_slow(m, &site);
                        if (rc) goto done;
                        goto next;
                    }
                case I_JMP:
                    if ((size_t)ins->a <= i && heap_alloc > heap_gc_at) { f->idx = (size_t)ins->a; goto next; }
                    i = (size_t)ins->a;
                    continue;
                case I_BR: case I_BRL: {
                    const char *where = ins->kind == I_BRL ? "LOOP" : "IFTE";
                    if (!d->len) { f->idx = (size_t)ins->b; rc = bo_err0(m, "Stack-Error", where); goto done; }
                    Val truth = d->items[--d->len];
                    if (is_num(truth)) { i = as_num(truth) > 0 ? i + 1 : (size_t)ins->a; continue; }
                    f->idx = (size_t)ins->b;
                    spush(d, truth);
                    rc = bo_err1(m, "Type-Error", where, truth);
                    goto done;
                }
                case I_SPECIALIZED:
                    if (ins->a) spush(d, from_num((double)(ins->a - 1)));
                    break;
                default: break;
                }
                if (step_gate(m, f, i, ins)) return;
                size_t depth = m->ctl_len;
                f->idx = ins->tail ? n : i + 1;
                rc = site_slow(m, ins);
                if (rc) goto done;
                if (m->paused) return; /* a BREAKPOINT paused the program: its frames stay */
                if (ins->tail || m->ctl_len != depth) goto next;
                i++;
                stale = c->epoch != m->epoch;
            }
        }
        case FR_BRANCH: {
            Val then = f->a, otherwise = f->b;
            m->ctl_len--;
            rc = do_branch(m, then, otherwise);
            break;
        }
        case FR_CATCH: m->ctl_len--; continue;
        case FR_LAMBDA: m->ctl_len--; continue;
        case FR_LOOP: {
            /* idx 0: the condition has just run; idx 1: the body has just run */
            Val cond = f->a, body = f->b;
            if (f->idx == 1) {
                f->idx = 0;
                push_code(m, cond);
                continue;
            }
            Stack *d = &m->data;
            if (!d->len) { m->ctl_len--; rc = bo_err0(m, "Stack-Error", "LOOP"); break; }
            Val truth = d->items[--d->len];
            if (!is_num(truth)) {
                m->ctl_len--;
                data_push(m, truth);
                rc = bo_err1(m, "Type-Error", "LOOP", truth);
                break;
            }
            if (as_num(truth) > 0) {
                f->idx = 1;
                push_code(m, body);
            } else {
                m->ctl_len--;
            }
            continue;
        }
        case FR_CALL: {
            List *programs = as_list(f->a);
            if (f->idx == 0) {
                f->idx = 1;
                push_code(m, programs->items[1]);
            } else if (f->idx == 1) {
                f->idx = 2;
                push_code(m, programs->items[3]);
            } else {
                Val error = f->b, catcher = programs->items[2];
                size_t stage = f->idx;
                m->ctl_len--;
                if (stage == 3) {
                    data_push(m, error);
                    push_code(m, catcher);
                }
            }
            continue;
        }
        default: m->ctl_len--; m->handling = 0; continue;
        }
    done:
        if (rc) fail(m);
    next:;
    }
}

/* run a list on its own control segment (errors do not unwind past it) */
void machine_run(Machine *m, Val lst) {
    size_t saved = m->base;
    m->base = m->ctl_len;
    push_code(m, lst);
    run_loop(m);
    m->base = saved;
}

/* The elements written on one source line run as one program, so that a literal
   ( cond ) ( body ) loop or ( c ) ( t ) ( e ) IFTE on that line is compiled to jumps. List
   literals written on lines of their own (the vertical style) join the program of the op
   that follows them. Errors report the line of the first form that is not a list literal. */
static int is_literal(Forms *forms, size_t i) {
    List *l = as_list(forms->f[i].list);
    return l->len == 1 && is_list(l->items[0]);
}

static void run_forms(Machine *m, Forms *forms, const char *source) {
    const char *saved_src = m->source;
    int saved_line = m->line;
    m->source = source;
    size_t root_mark = m->nroots;
    size_t ngroups = 0;
    size_t *start = malloc((forms->n + 1) * sizeof(size_t));
    int only_literals = 0; /* every form of the group so far is a list literal */
    for (size_t i = 0; i < forms->n; i++) {
        int lit = is_literal(forms, i);
        if (m->optimize_instrs && i && (forms->f[i].line == forms->f[i - 1].line ||
                            (only_literals && is_literal(forms, i - 1)))) {
            only_literals = only_literals && lit;
            continue;
        }
        only_literals = lit;
        start[ngroups++] = i;
    }
    start[ngroups] = forms->n;
    Val *groups = malloc((ngroups + 1) * sizeof(Val));
    for (size_t g = 0; g < ngroups; g++) {
        size_t lo = start[g], hi = start[g + 1];
        if (hi == lo + 1) {
            groups[g] = forms->f[lo].list;
        } else {
            size_t total = 0;
            for (size_t i = lo; i < hi; i++) total += as_list(forms->f[i].list)->len;
            Val *items = malloc(total * sizeof(Val));
            size_t k = 0;
            for (size_t i = lo; i < hi; i++) {
                List *l = as_list(forms->f[i].list);
                memcpy(items + k, l->items, l->len * sizeof(Val));
                k += l->len;
            }
            groups[g] = list_from(items, (uint32_t)total);
            free(items);
        }
        if (m->nroots == m->roots_cap) {
            m->roots_cap = m->roots_cap ? m->roots_cap * 2 : 64;
            m->roots = realloc(m->roots, m->roots_cap * sizeof(Val));
        }
        m->roots[m->nroots++] = groups[g];
    }
    for (size_t g = 0; g < ngroups; g++) {
        size_t at = start[g];
        while (at + 1 < start[g + 1] && is_literal(forms, at)) at++;
        m->line = forms->f[at].line;
        machine_run(m, groups[g]);
        if (m->propagating) break;
    }
    free(groups);
    free(start);
    m->nroots = root_mark;
    m->source = saved_src;
    m->line = saved_line;
}

/* ------------------------------------------------------------------ primitives */

static int need_list(Machine *m, Val v) { return is_list(v) ? 0 : bo_err1(m, "Type-Error", NULL, v); }

/* resolve a stack reference; *s is the data stack for (), NULL if it does not exist */
static int get_ref(Machine *m, Val ref, int create, Stack **s, int *is_default) {
    if (!is_list(ref)) return bo_err1(m, "Type-Error", NULL, ref);
    if (as_list(ref)->len == 0) {
        *s = &m->data;
        *is_default = 1;
        return 0;
    }
    Val text;
    int rc = selector_to_name(ref, &text);
    if (rc == NAME_TYPE_ERROR) return bo_err1(m, "Type-Error", NULL, ref);
    if (rc == NAME_REPRESENTATION_ERROR) return bo_err1(m, "Representation-Error", NULL, ref);
    *is_default = 0;
    *s = stack_lookup(m, ref, create);
    return 0;
}

static void stack_changed(Machine *m, Stack *s) {
    if (s->invalidates_code) m->epoch++;
}

/* Records that the file being loaded pushed the item now on top of s. */
static void tag_pushed(Stack *s, uint32_t file) {
    size_t at = s->len - 1;
    if (s->owners_len > at) s->owners_len = at;
    if (s->owners_cap <= at) {
        size_t cap = s->owners_cap ? s->owners_cap : 8;
        while (cap <= at) cap *= 2;
        s->owners = realloc(s->owners, cap * sizeof *s->owners);
        s->owners_cap = cap;
    }
    while (s->owners_len < at) s->owners[s->owners_len++] = 0;
    s->owners[at] = file;
    s->owners_len = at + 1;
}

static int n_push(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[1], 1, &s, &def)) return 1;
    if (s->locked) return bo_err1(m, "Permission-Error", NULL, a[1]);
    spush(s, a[0]);
    if (m->cur_file && !def) tag_pushed(s, m->cur_file);
    stack_changed(m, s);
    return 0;
}

static int empty_stack_err(Machine *m, int def, Val ref) {
    return def ? bo_err0(m, "Stack-Error", NULL) : bo_err1(m, "Stack-Error", NULL, ref);
}

static int n_pop(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    if (s && s->locked) return bo_err1(m, "Permission-Error", NULL, a[0]);
    if (!s || !s->len) return empty_stack_err(m, def, a[0]);
    Val v = s->items[--s->len];
    if (s->owners_len > s->len) s->owners_len = s->len;
    stack_changed(m, s);
    data_push(m, v);
    return 0;
}

static int n_top(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    if (!s || !s->len) return empty_stack_err(m, def, a[0]);
    data_push(m, s->items[s->len - 1]);
    return 0;
}

static int n_see(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    data_push(m, s ? list_from(s->items, (uint32_t)s->len) : list_from(NULL, 0));
    return 0;
}

static int n_depth(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    push_num(m, s ? (double)s->len : 0);
    return 0;
}

static int n_exists(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    push_num(m, s != NULL);
    return 0;
}

static int n_locked(Machine *m, Val *a) {
    Stack *s; int def;
    if (get_ref(m, a[0], 0, &s, &def)) return 1;
    push_num(m, s != NULL && s->locked);
    return 0;
}

/* The names of two stacks, as code points, in order. */
static int stack_name_cmp(const void *x, const void *y) {
    const List *a = as_op(as_list((*(Stack *const *)x)->key)->items[0]);
    const List *b = as_op(as_list((*(Stack *const *)y)->key)->items[0]);
    uint32_t n = a->len < b->len ? a->len : b->len;
    for (uint32_t i = 0; i < n; i++) {
        double p = as_num(a->items[i]), q = as_num(b->items[i]);
        if (p != q) return p < q ? -1 : 1;
    }
    return (a->len > b->len) - (a->len < b->len);
}

/* Every stack that exists, whatever it holds: the primitives', the library's, the program's, and any
   emptied since or only selected. Sorted by name, which is the same in both runtimes. */
static int n_lexicon(Machine *m, Val *a) {
    (void)a;
    size_t n = 0;
    Stack **found = malloc((m->tcount + 1) * sizeof *found);
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain)
            if (s->exists && s->key && !stack_is_private(s)) found[n++] = s;
    qsort(found, n, sizeof *found, stack_name_cmp);
    Val *keys = malloc((n + 1) * sizeof *keys);
    for (size_t i = 0; i < n; i++) keys[i] = found[i]->key;
    Val result = list_from(keys, (uint32_t)n);
    free(keys);
    free(found);
    data_push(m, result);
    return 0;
}

/* The selected stack stops existing and its values are lost (its Stack stays allocated: compiled
   code points to it, and pushing to it again makes it exist again). The data stack and a locked
   stack, which includes every primitive, cannot be deleted; the locked ones are refused before this. */
static int n_delete(Machine *m, Val *a) {
    (void)a;
    if (m->selected == &m->data) return bo_err1(m, "Permission-Error", NULL, list_from(NULL, 0));
    m->data.len = 0; /* the selected stack's contents: they are swapped in during the call */
    m->selected->exists = m->selected->native != NULL; /* a primitive's stack always exists */
    m->epoch++; /* a definition is gone: compiled code must not keep the old one */
    return 0;
}

static int n_unit(Machine *m, Val *a) {
    data_push(m, list_of1(a[0]));
    return 0;
}

static int n_clr(Machine *m, Val *a) {
    (void)a;
    if (m->selected && m->selected->locked) return bo_err0(m, "Permission-Error", NULL);
    m->data.len = 0;
    return 0;
}

static int n_lock(Machine *m, Val *a) {
    (void)a;
    if (!m->selected || m->selected == &m->data) return bo_err1(m, "Permission-Error", NULL, list_from(NULL, 0));
    if (!m->selected->locked) m->selected->locked_by = m->cur_file;
    m->selected->locked = 1;
    return 0;
}
static int n_unlock(Machine *m, Val *a) {
    (void)a;
    if (m->selected && m->selected != &m->data) {
        m->selected->locked = 0;
        m->selected->locked_by = 0;
    }
    return 0;
}

static int n_drop(Machine *m, Val *a) { (void)m; (void)a; return 0; }

static int index_arg(Machine *m, Val n) {
    if (!is_int(n)) return bo_err1(m, "Type-Error", NULL, n);
    double d = as_num(n);
    if (d < 0 || d >= (double)m->data.len) return bo_err1(m, "Stack-Error", NULL, n);
    return 0;
}

static int n_pick(Machine *m, Val *a) {
    if (index_arg(m, a[0])) return 1;
    data_push(m, m->data.items[m->data.len - 1 - (size_t)as_num(a[0])]);
    return 0;
}

static int n_roll(Machine *m, Val *a) {
    if (index_arg(m, a[0])) return 1;
    size_t pos = m->data.len - 1 - (size_t)as_num(a[0]);
    Val v = m->data.items[pos];
    memmove(&m->data.items[pos], &m->data.items[pos + 1], (m->data.len - pos - 1) * sizeof(Val));
    m->data.items[m->data.len - 1] = v;
    return 0;
}

static int n_consl(Machine *m, Val *a) {
    if (need_list(m, a[0])) return 1;
    List *l = as_list(a[0]);
    List *r = list_new(l->len + 1);
    r->items[0] = a[1];
    if (l->len) memcpy(&r->items[1], l->items, l->len * sizeof(Val));
    data_push(m, from_list(r));
    return 0;
}

static int n_consr(Machine *m, Val *a) {
    if (need_list(m, a[0])) return 1;
    List *l = as_list(a[0]);
    data_push(m, list_append(l, a[1]));
    return 0;
}

static int uncons(Machine *m, Val *a, int right) {
    if (need_list(m, a[0])) return 1;
    List *l = as_list(a[0]);
    if (!l->len) return bo_err1(m, "Stack-Error", NULL, a[0]);
    Val rest = list_slice(l, right ? 0 : 1, l->len - 1);
    data_push(m, rest);
    data_push(m, l->items[right ? l->len - 1 : 0]);
    return 0;
}
static int n_unconsl(Machine *m, Val *a) { return uncons(m, a, 0); }
static int n_unconsr(Machine *m, Val *a) { return uncons(m, a, 1); }

static int n_type(Machine *m, Val *a) {
    push_num(m, is_list(a[0]) ? 1 : is_op(a[0]) ? 2 : 0);
    return 0;
}

static int n_unit_consl(Machine *m, Val *a) {
    Val result;
    if (unit_cons(a[0], a[1], 0, &result))
        return bo_err1(m, "Type-Error", NULL, is_list(a[0]) ? a[1] : a[0]);
    data_push(m, result);
    return 0;
}

static int n_unit_consr(Machine *m, Val *a) {
    Val result;
    if (unit_cons(a[0], a[1], 1, &result))
        return bo_err1(m, "Type-Error", NULL, is_list(a[0]) ? a[1] : a[0]);
    data_push(m, result);
    return 0;
}

static int unit_uncons_op(Machine *m, Val *a, int right) {
    Val rest, unit;
    int rc = unit_uncons(a[0], right, &rest, &unit);
    if (rc) return bo_err1(m, rc == UNIT_STACK_ERROR ? "Stack-Error" : "Type-Error", NULL, a[0]);
    data_push(m, rest);
    data_push(m, unit);
    return 0;
}

static int n_unit_unconsl(Machine *m, Val *a) { return unit_uncons_op(m, a, 0); }
static int n_unit_unconsr(Machine *m, Val *a) { return unit_uncons_op(m, a, 1); }

static int n_utype(Machine *m, Val *a) {
    int type;
    if (unit_type(a[0], &type)) return bo_err1(m, "Type-Error", NULL, a[0]);
    push_num(m, type);
    return 0;
}

/* the empty name and the default-stack selector are both (), so () converts to itself either way */
static int n_selector(Machine *m, Val *a) {
    if (is_list(a[0]) && !as_list(a[0])->len) {
        data_push(m, a[0]);
        return 0;
    }
    Val unit;
    int rc = name_to_selector(a[0], &unit);
    if (rc) return bo_err1(m, rc == NAME_TYPE_ERROR ? "Type-Error" : "Representation-Error", NULL, a[0]);
    data_push(m, unit);
    return 0;
}

static int n_name(Machine *m, Val *a) {
    if (is_list(a[0]) && !as_list(a[0])->len) {
        data_push(m, a[0]);
        return 0;
    }
    Val text;
    int rc = selector_to_name(a[0], &text);
    if (rc) return bo_err1(m, rc == NAME_TYPE_ERROR ? "Type-Error" : "Representation-Error", NULL, a[0]);
    data_push(m, text);
    return 0;
}

static int n_ratio(Machine *m, Val *a) {
    if (!is_num(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    double x = as_num(a[0]);
    if (num_is_int(x) || fabs(x) >= INT_LIMIT) {
        push_num(m, x);
        push_num(m, 1);
        return 0;
    }
    int e;
    double frac = frexp(x, &e);
    double mant = ldexp(frac, 53);
    int exp2 = e - 53;
    while (exp2 < 0 && fmod(mant, 2) == 0) {
        mant /= 2;
        exp2++;
    }
    double den = ldexp(1.0, -exp2);
    if (!isfinite(den)) return bo_err1(m, "Evaluation-Error", NULL, a[0]);
    push_num(m, mant);
    push_num(m, den);
    return 0;
}

static int n_apply(Machine *m, Val *a) {
    if (need_list(m, a[0])) return 1;
    enter(m, a[0]);
    return 0;
}

/* a LAMBDA label is an op unit, or () for the anonymous one; it names no stack */
static int label_check(Machine *m, Val ref) {
    if (!is_list(ref)) return bo_err1(m, "Type-Error", NULL, ref);
    if (as_list(ref)->len == 0) return 0;
    Val text;
    int rc = selector_to_name(ref, &text);
    if (rc == NAME_TYPE_ERROR) return bo_err1(m, "Type-Error", NULL, ref);
    if (rc == NAME_REPRESENTATION_ERROR) return bo_err1(m, "Representation-Error", NULL, ref);
    return 0;
}

static int n_lambda(Machine *m, Val *a) {
    if (need_list(m, a[0]) || label_check(m, a[1])) return 1;
    for (;;) {
        trim(m);
        /* an exhausted marker of the same lambda is interchangeable with the new one:
           re-entering the program through either runs the same code */
        if (m->ctl_len > m->base) {
            Frame *top = &m->ctl[m->ctl_len - 1];
            if (top->kind == FR_LAMBDA && top->b == a[0] && val_equal(top->a, a[1])) {
                m->ctl_len--;
                continue;
            }
        }
        break;
    }
    Frame *f = frame_push(m, FR_LAMBDA);
    f->a = a[1];
    f->b = a[0];
    push_code(m, a[0]);
    return 0;
}

static int n_rec(Machine *m, Val *a) {
    if (label_check(m, a[0])) return 1;
    for (size_t d = m->ctl_len; d > m->base; d--) {
        Frame *f = &m->ctl[d - 1];
        if (f->kind == FR_LAMBDA && val_equal(f->a, a[0])) {
            Val program = f->b;
            trim(m);
            push_code(m, program);
            return 0;
        }
    }
    return bo_err1(m, "Existence-Error", NULL, a[0]);
}

static int n_ifte(Machine *m, Val *a) {
    for (int i = 0; i < 3; i++)
        if (need_list(m, a[i])) return 1;
    trim(m);
    Frame *f = frame_push(m, FR_BRANCH);
    f->a = a[1];
    f->b = a[2];
    push_code(m, a[0]);
    return 0;
}

static int n_loop(Machine *m, Val *a) {
    for (int i = 0; i < 2; i++)
        if (need_list(m, a[i])) return 1;
    trim(m);
    Frame *f = frame_push(m, FR_LOOP);
    f->a = a[0];
    f->b = a[1];
    push_code(m, a[0]);
    return 0;
}

static int n_catch(Machine *m, Val *a) {
    for (int i = 0; i < 2; i++)
        if (need_list(m, a[i])) return 1;
    trim(m);
    Frame *f = frame_push(m, FR_CATCH);
    f->a = a[1];
    push_code(m, a[0]);
    return 0;
}

static int n_call(Machine *m, Val *a) {
    for (int i = 0; i < 4; i++)
        if (need_list(m, a[i])) return 1;
    Val programs = list_from(a, 4);
    trim(m);
    Frame *f = frame_push(m, FR_CALL);
    f->a = programs;
    push_code(m, a[0]);
    return 0;
}

static int error_op_unit(Val value) {
    Val text;
    return selector_to_name(value, &text) == NAME_OK;
}

static int valid_error_text(Val value) {
    if (!is_list(value)) return 0;
    List *text = as_list(value);
    for (uint32_t i = 0; i < text->len; i++) {
        Val v = text->items[i];
        if (!is_int(v)) return 0;
        double c = as_num(v);
        if (c < 0 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return 0;
    }
    return 1;
}

static int n_rethrow(Machine *m, Val *a) {
    Val error = a[0];
    if (!is_list(error)) return bo_err1(m, "Type-Error", NULL, error);
    List *l = as_list(error);
    if (l->len != 5 || !error_op_unit(l->items[0]) ||
        !error_op_unit(l->items[1]) || !is_list(l->items[2]) ||
        !valid_error_text(l->items[3]) || !is_int(l->items[4]))
        return bo_err1(m, "Type-Error", NULL, error);
    m->err_original = error;
    return 2;
}

static int arith_args(Machine *m, Val *a) {
    if (!is_num(a[0]) || !is_num(a[1])) return bo_err(m, "Type-Error", NULL, list_of2(a[0], a[1]));
    return 0;
}

static int arith_result(Machine *m, Val *a, double r) {
    if (!isfinite(r)) return bo_err(m, "Evaluation-Error", NULL, list_of2(a[0], a[1]));
    push_num(m, r);
    return 0;
}

static int n_add(Machine *m, Val *a) { return arith_args(m, a) ? 1 : arith_result(m, a, as_num(a[0]) + as_num(a[1])); }
static int n_sub(Machine *m, Val *a) { return arith_args(m, a) ? 1 : arith_result(m, a, as_num(a[0]) - as_num(a[1])); }
static int n_mul(Machine *m, Val *a) { return arith_args(m, a) ? 1 : arith_result(m, a, as_num(a[0]) * as_num(a[1])); }
static int n_pow(Machine *m, Val *a) {
    if (arith_args(m, a)) return 1;
    double x = as_num(a[0]), y = as_num(a[1]), r = pow(x, y);
    if (isnan(r) || (x == 0 && y < 0)) return bo_err(m, "Domain-Error", NULL, list_of2(a[0], a[1]));
    return arith_result(m, a, r);
}

static int n_div(Machine *m, Val *a) {
    if (arith_args(m, a)) return 1;
    double y = as_num(a[1]);
    if (y == 0) return bo_err(m, "Domain-Error", NULL, list_of2(a[0], a[1]));
    return arith_result(m, a, as_num(a[0]) / y);
}

/* floor division with the semantics of Python's float floor division */
static double floordiv(double x, double y) {
    double mod = fmod(x, y);
    double div = (x - mod) / y;
    if (mod != 0 && ((y < 0) != (mod < 0))) div -= 1.0;
    if (div == 0) return 0;
    double fd = floor(div);
    if (div - fd > 0.5) fd += 1.0;
    return fd;
}

static int n_idiv(Machine *m, Val *a) {
    if (arith_args(m, a)) return 1;
    double x = as_num(a[0]), y = as_num(a[1]);
    if (y == 0) return bo_err(m, "Domain-Error", NULL, list_of2(a[0], a[1]));
    return arith_result(m, a, floordiv(x, y));
}

static int range_error(Machine *m, const char *kind, Val *operands, int count) {
    return bo_err(m, kind, NULL, list_from(operands, (uint32_t)count));
}

static int n_range_values(Machine *m, double start, double step, double end,
                          Val *operands, int operand_count) {
    if (!isfinite(start) || !isfinite(step) || !isfinite(end))
        return range_error(m, "Domain-Error", operands, operand_count);
    if (step == 0 || (step > 0 && start > end) || (step < 0 && start < end)) {
        data_push(m, list_from(NULL, 0));
        return 0;
    }

    double span = step > 0 ? end - start : start - end;
    double quotient = span / fabs(step);
    if (!isfinite(span) || !isfinite(quotient))
        return range_error(m, "Resource-Error", operands, operand_count);

    double nearest = floor(quotient + 0.5);
    double tolerance = 4 * DBL_EPSILON * fmax(1.0, fabs(quotient));
    int snap_endpoint = fabs(quotient - nearest) <= tolerance;
    double intervals = snap_endpoint ? nearest : floor(quotient);
    if (intervals > (double)UINT32_MAX - 1)
        return range_error(m, "Resource-Error", operands, operand_count);

    uint32_t count = (uint32_t)intervals + 1;
    List *values = list_new(count);
    for (uint32_t i = 0; i < count; i++) {
        double value = start + (double)i * step;
        if (!isfinite(value))
            return range_error(m, "Evaluation-Error", operands, operand_count);
        if (i == (uint32_t)intervals && snap_endpoint) value = end;
        else if ((step > 0 && value > end) || (step < 0 && value < end))
            return range_error(m, "Evaluation-Error", operands, operand_count);
        values->items[i] = from_num(value);
    }
    data_push(m, from_list(values));
    return 0;
}

static int n_colon(Machine *m, Val *a) {
    Val operands[3] = {a[0], a[1], a[2]};
    for (int i = 0; i < 3; i++)
        if (!is_num(a[i])) return range_error(m, "Type-Error", operands, 3);
    return n_range_values(m, as_num(a[0]), as_num(a[1]), as_num(a[2]), operands, 3);
}

static int tensor_shape(Val shape, uint32_t *rank, uint32_t *len) {
    if (!is_list(shape)) return 1;
    List *dimensions = as_list(shape);
    uint64_t size = 1;
    for (uint32_t i = 0; i < dimensions->len; i++) {
        if (!is_int(dimensions->items[i])) return 1;
        double dimension = as_num(dimensions->items[i]);
        if (dimension < 0) return 2;
        if (dimension && size > UINT32_MAX / (uint32_t)dimension) return 4;
        size *= (uint32_t)dimension;
    }
    *rank = dimensions->len;
    *len = (uint32_t)size;
    return 0;
}

/* Decode results: 1 operand of the wrong type, 2 value outside the domain, 3 shapes that do not
   fit, 4 size over the limit. */
static const char *tensor_kind(int rc) {
    static const char *const kinds[] = {"Type-Error", "Domain-Error", "Shape-Error", "Resource-Error"};
    return kinds[rc - 1];
}

static int tensor_error(Machine *m, const char *kind, Val *a, int arity) {
    return bo_err(m, kind, NULL, list_from(a, (uint32_t)arity));
}

typedef struct { List *data, *shape; uint32_t rank, len; } TensorParts;

static int tensor_parts(Val value, TensorParts *parts) {
    if (!is_list(value) || as_list(value)->len != 2) return 1;
    List *outer = as_list(value);
    if (!is_list(outer->items[0]) || !is_list(outer->items[1])) return 1;
    parts->data = as_list(outer->items[0]);
    parts->shape = as_list(outer->items[1]);
    for (uint32_t i = 0; i < parts->data->len; i++) {
        if (!is_num(parts->data->items[i])) return 1;
        if (!isfinite(as_num(parts->data->items[i]))) return 2;
    }
    int rc = tensor_shape(outer->items[1], &parts->rank, &parts->len);
    if (rc) return rc;
    return parts->data->len == parts->len ? 0 : 3;
}

static int n_tensor(Machine *m, Val *a) {
    Val tensor = list_of2(a[0], a[1]);
    TensorParts parts;
    int rc = tensor_parts(tensor, &parts);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    data_push(m, tensor);
    return 0;
}

static int n_shape(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return bo_err1(m, tensor_kind(rc), NULL, a[0]);
    data_push(m, from_list(tensor.shape));
    return 0;
}

static int n_rank(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return bo_err1(m, tensor_kind(rc), NULL, a[0]);
    push_num(m, tensor.rank);
    return 0;
}

static int n_reshape(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    uint32_t rank, len;
    rc = tensor_shape(a[1], &rank, &len);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    if (tensor.len != len) return tensor_error(m, "Shape-Error", a, 2);
    data_push(m, list_of2(from_list(tensor.data), a[1]));
    return 0;
}

static int tensor_offset(Val tensor_value, Val indices_value, TensorParts *tensor,
                         uint32_t *out) {
    int rc = tensor_parts(tensor_value, tensor);
    if (rc || !is_list(indices_value)) return rc ? rc : 1;
    List *indices = as_list(indices_value);
    for (uint32_t i = 0; i < indices->len; i++)
        if (!is_int(indices->items[i])) return 1;
    if (indices->len != tensor->rank) return 3;
    uint32_t offset = 0;
    for (uint32_t i = 0; i < tensor->rank; i++) {
        double index = as_num(indices->items[i]);
        double dimension = as_num(tensor->shape->items[i]);
        if (index < 0 || index >= dimension) return 2;
        offset = offset * (uint32_t)dimension + (uint32_t)index;
    }
    *out = offset;
    return 0;
}

static int n_tget(Machine *m, Val *a) {
    TensorParts tensor;
    uint32_t offset;
    int rc = tensor_offset(a[0], a[1], &tensor, &offset);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    data_push(m, tensor.data->items[offset]);
    return 0;
}

static int n_tset(Machine *m, Val *a) {
    TensorParts tensor;
    uint32_t offset;
    int rc = tensor_offset(a[0], a[1], &tensor, &offset);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 3);
    if (!is_num(a[2])) return tensor_error(m, "Type-Error", a, 3);
    if (!isfinite(as_num(a[2]))) return tensor_error(m, "Domain-Error", a, 3);
    List *data = list_new(tensor.len);
    if (tensor.len) memcpy(data->items, tensor.data->items, (size_t)tensor.len * sizeof(Val));
    data->items[offset] = a[2];
    data_push(m, list_of2(from_list(data), from_list(tensor.shape)));
    return 0;
}

static int n_tsplit(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    if (!is_int(a[1])) return tensor_error(m, "Type-Error", a, 2);
    double requested = as_num(a[1]);
    if (requested <= 0) return tensor_error(m, "Domain-Error", a, 2);
    if (requested > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
    if (tensor.rank != 1) return tensor_error(m, "Shape-Error", a, 2);

    uint32_t count = (uint32_t)requested;
    uint32_t base = tensor.len / count, remainder = tensor.len % count, offset = 0;
    List *chunks = list_new(count);
    for (uint32_t index = 0; index < count; index++) {
        uint32_t len = base + (index < remainder);
        Val data = list_from(tensor.data->items + offset, len);
        Val shape = list_of1(from_num(len));
        chunks->items[index] = list_of2(data, shape);
        offset += len;
    }
    data_push(m, from_list(chunks));
    return 0;
}

static int n_tconcat(Machine *m, Val *a) {
    if (!is_list(a[0])) return tensor_error(m, "Type-Error", a, 1);
    List *chunks = as_list(a[0]);
    uint64_t total = 0;
    for (uint32_t index = 0; index < chunks->len; index++) {
        TensorParts chunk;
        Val value = chunks->items[index];
        if (is_list(value) && as_list(value)->len == 1)
            value = as_list(value)->items[0];
        int rc = tensor_parts(value, &chunk);
        if (rc) return tensor_error(m, tensor_kind(rc), a, 1);
        if (chunk.rank != 1) return tensor_error(m, "Shape-Error", a, 1);
        if (total + chunk.len > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 1);
        total += chunk.len;
    }

    List *data = list_new((uint32_t)total);
    uint32_t offset = 0;
    for (uint32_t index = 0; index < chunks->len; index++) {
        Val value = chunks->items[index];
        if (as_list(value)->len == 1)
            value = as_list(value)->items[0];
        List *chunk_data = as_list(as_list(value)->items[0]);
        if (chunk_data->len)
            memcpy(data->items + offset, chunk_data->items, (size_t)chunk_data->len * sizeof(Val));
        offset += chunk_data->len;
    }
    data_push(m, list_of2(from_list(data), list_of1(from_num(total))));
    return 0;
}

static int n_tmean(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    int all_axes = is_list(a[1]) && !as_list(a[1])->len;
    if (!all_axes && !is_int(a[1])) return tensor_error(m, "Type-Error", a, 2);
    uint32_t axis = 0;
    if (!all_axes) {
        double requested = as_num(a[1]);
        if (requested < 0 || requested >= tensor.rank) return tensor_error(m, "Domain-Error", a, 2);
        axis = (uint32_t)requested;
    }
    uint64_t outer = 1, width = 1;
    if (!all_axes) {
        for (uint32_t i = 0; i < axis; i++) {
            outer *= (uint32_t)as_num(tensor.shape->items[i]);
            if (outer > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
        }
        for (uint32_t i = axis + 1; i < tensor.rank; i++) {
            width *= (uint32_t)as_num(tensor.shape->items[i]);
            if (width > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
        }
    }
    uint32_t dimension = all_axes ? tensor.len : (uint32_t)as_num(tensor.shape->items[axis]);
    uint64_t count = outer * width;
    if (count > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
    if (!dimension) return tensor_error(m, "Domain-Error", a, 2);
    List *data = list_new((uint32_t)count);
    for (uint64_t o = 0; o < outer; o++) for (uint64_t w = 0; w < width; w++) {
        double total = 0;
        for (uint32_t i = 0; i < dimension; i++) {
            total += as_num(tensor.data->items[((uint64_t)o * dimension + i) * width + w]);
            if (!isfinite(total)) return tensor_error(m, "Evaluation-Error", a, 2);
        }
        data->items[o * width + w] = from_num(total / dimension);
    }
    if (all_axes) { push_num(m, as_num(data->items[0])); return 0; }
    List *shape = list_new(tensor.rank - 1);
    for (uint32_t i = 0, out = 0; i < tensor.rank; i++) if (i != axis) shape->items[out++] = tensor.shape->items[i];
    data_push(m, list_of2(from_list(data), from_list(shape)));
    return 0;
}

static int compare_doubles(const void *left, const void *right) {
    double a = *(const double *)left, b = *(const double *)right;
    return (a > b) - (a < b);
}

static int n_tmedian(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 2);
    int all_axes = is_list(a[1]) && !as_list(a[1])->len;
    if (!all_axes && !is_int(a[1])) return tensor_error(m, "Type-Error", a, 2);
    uint32_t axis = 0;
    if (!all_axes) {
        double requested = as_num(a[1]);
        if (requested < 0 || requested >= tensor.rank) return tensor_error(m, "Domain-Error", a, 2);
        axis = (uint32_t)requested;
    }
    uint64_t outer = 1, width = 1;
    if (!all_axes) {
        for (uint32_t i = 0; i < axis; i++) {
            outer *= (uint32_t)as_num(tensor.shape->items[i]);
            if (outer > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
        }
        for (uint32_t i = axis + 1; i < tensor.rank; i++) {
            width *= (uint32_t)as_num(tensor.shape->items[i]);
            if (width > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
        }
    }
    uint32_t dimension = all_axes ? tensor.len : (uint32_t)as_num(tensor.shape->items[axis]);
    uint64_t count = outer * width;
    if (count > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 2);
    if (!dimension) return tensor_error(m, "Domain-Error", a, 2);
    List *data = list_new((uint32_t)count);
    double *slice = malloc((size_t)dimension * sizeof(double));
    if (!slice) abort();
    for (uint64_t o = 0; o < outer; o++) for (uint64_t w = 0; w < width; w++) {
        for (uint32_t i = 0; i < dimension; i++)
            slice[i] = as_num(tensor.data->items[((uint64_t)o * dimension + i) * width + w]);
        qsort(slice, dimension, sizeof(double), compare_doubles);
        uint32_t middle = dimension / 2;
        double result = dimension & 1 ? slice[middle] : slice[middle - 1] / 2 + slice[middle] / 2;
        data->items[o * width + w] = from_num(result);
    }
    free(slice);
    if (all_axes) { push_num(m, as_num(data->items[0])); return 0; }
    List *shape = list_new(tensor.rank - 1);
    for (uint32_t i = 0, out = 0; i < tensor.rank; i++) if (i != axis) shape->items[out++] = tensor.shape->items[i];
    data_push(m, list_of2(from_list(data), from_list(shape)));
    return 0;
}

static int n_tdot(Machine *m, Val *a) {
    TensorParts left, right;
    int lrc = tensor_parts(a[0], &left), rrc = tensor_parts(a[1], &right);
    if (lrc || rrc) {
        int rc = lrc ? lrc : rrc;
        return tensor_error(m, tensor_kind(rc), a, 2);
    }
    if (left.rank != 1 || right.rank != 1)
        return tensor_error(m, "Shape-Error", a, 2);
    if (left.len != right.len) return tensor_error(m, "Shape-Error", a, 2);

    double total = 0;
    for (uint32_t index = 0; index < left.len; index++) {
        double product = as_num(left.data->items[index]) * as_num(right.data->items[index]);
        total += product;
        if (!isfinite(product) || !isfinite(total))
            return tensor_error(m, "Evaluation-Error", a, 2);
    }
    push_num(m, total);
    return 0;
}

static int n_ttranspose(Machine *m, Val *a) {
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 1);
    if (tensor.rank != 2) return tensor_error(m, "Shape-Error", a, 1);
    uint32_t rows = (uint32_t)as_num(tensor.shape->items[0]);
    uint32_t columns = (uint32_t)as_num(tensor.shape->items[1]);
    List *data = list_new(tensor.len);
    for (uint32_t column = 0; column < columns; column++)
        for (uint32_t row = 0; row < rows; row++)
            data->items[(uint64_t)column * rows + row] = tensor.data->items[(uint64_t)row * columns + column];
    data_push(m, list_of2(from_list(data), list_of2(from_num(columns), from_num(rows))));
    return 0;
}

static int n_touter(Machine *m, Val *a) {
    TensorParts left, right;
    int lrc = tensor_parts(a[0], &left), rrc = tensor_parts(a[1], &right);
    if (lrc || rrc) return tensor_error(m, tensor_kind(lrc ? lrc : rrc), a, 2);
    if (left.rank != 1 || right.rank != 1) return tensor_error(m, "Shape-Error", a, 2);
    if (left.len && right.len > UINT32_MAX / left.len) return tensor_error(m, "Resource-Error", a, 2);
    List *data = list_new(left.len * right.len);
    for (uint32_t i = 0; i < left.len; i++) for (uint32_t j = 0; j < right.len; j++) {
        double value = as_num(left.data->items[i]) * as_num(right.data->items[j]);
        if (!isfinite(value)) return tensor_error(m, "Evaluation-Error", a, 2);
        data->items[(uint64_t)i * right.len + j] = from_num(value);
    }
    data_push(m, list_of2(from_list(data), list_of2(from_num(left.len), from_num(right.len))));
    return 0;
}

static int n_tmatmul(Machine *m, Val *a) {
    TensorParts left, right;
    int lrc = tensor_parts(a[0], &left), rrc = tensor_parts(a[1], &right);
    if (lrc || rrc) return tensor_error(m, tensor_kind(lrc ? lrc : rrc), a, 2);
    if (left.rank != 2 || right.rank != 2) return tensor_error(m, "Shape-Error", a, 2);
    uint32_t rows = (uint32_t)as_num(left.shape->items[0]), inner = (uint32_t)as_num(left.shape->items[1]);
    uint32_t right_inner = (uint32_t)as_num(right.shape->items[0]), columns = (uint32_t)as_num(right.shape->items[1]);
    if (inner != right_inner) return tensor_error(m, "Shape-Error", a, 2);
    if (rows && columns > UINT32_MAX / rows) return tensor_error(m, "Resource-Error", a, 2);
    List *data = list_new(rows * columns);
    for (uint32_t row = 0; row < rows; row++) for (uint32_t column = 0; column < columns; column++) {
        double total = 0;
        for (uint32_t index = 0; index < inner; index++) {
            total += as_num(left.data->items[(uint64_t)row * inner + index]) *
                     as_num(right.data->items[(uint64_t)index * columns + column]);
            if (!isfinite(total)) return tensor_error(m, "Evaluation-Error", a, 2);
        }
        data->items[(uint64_t)row * columns + column] = from_num(total);
    }
    data_push(m, list_of2(from_list(data), list_of2(from_num(rows), from_num(columns))));
    return 0;
}

/* native binary operations an op may stand for (see op_operation) */
enum { B_NONE = -1, B_ADD, B_SUB, B_MUL, B_DIV, B_IDIV, B_POW };

static int broadcast_shape(Machine *m, Val *a, TensorParts *left, TensorParts *right,
                           List **out, uint32_t *out_len) {
    uint32_t left_rank = left ? left->rank : 0;
    uint32_t right_rank = right ? right->rank : 0;
    uint32_t rank = left_rank > right_rank ? left_rank : right_rank;
    uint64_t len = 1;
    List *shape = list_new(rank);
    for (uint32_t axis = 0; axis < rank; axis++) {
        uint32_t left_dimension = axis < left_rank ? (uint32_t)as_num(left->shape->items[left_rank - 1 - axis]) : 1;
        uint32_t right_dimension = axis < right_rank ? (uint32_t)as_num(right->shape->items[right_rank - 1 - axis]) : 1;
        uint32_t dimension;
        if (left_dimension == right_dimension) dimension = left_dimension;
        else if (left_dimension == 1) dimension = right_dimension;
        else if (right_dimension == 1) dimension = left_dimension;
        else {
            return tensor_error(m, "Shape-Error", a, 3);
        }
        if (dimension && len > UINT32_MAX / dimension) {
            return tensor_error(m, "Resource-Error", a, 3);
        }
        len *= dimension;
        shape->items[rank - 1 - axis] = from_num(dimension);
    }
    *out = shape;
    *out_len = (uint32_t)len;
    return 0;
}

static Val broadcast_element(TensorParts *tensor, List *shape, const uint32_t *coordinates) {
    if (!tensor) return 0;
    uint32_t offset = 0;
    uint32_t start = shape->len - tensor->rank;
    for (uint32_t axis = 0; axis < tensor->rank; axis++) {
        uint32_t dimension = (uint32_t)as_num(tensor->shape->items[axis]);
        uint32_t coordinate = dimension == 1 ? 0 : coordinates[start + axis];
        offset = offset * dimension + coordinate;
    }
    return tensor->data->items[offset];
}

/* The native binary operation an op runs on a pair of numbers, or B_NONE: the op must
   currently be a default-stack wrapper (() ADD), (() SUB), ... of an unmodified primitive. */
static int op_operation(Machine *m, Val op) {
    static const char *const names[] = {"ADD", "SUB", "MUL", "DIV", "IDIV", "POW"};
    Stack *st = stack_lookup(m, list_of1(op), 0);
    if (!st || !st->len || !is_list(st->items[st->len - 1])) return B_NONE;
    List *definition = as_list(st->items[st->len - 1]);
    if (definition->len != 2 || !is_list(definition->items[0]) ||
        as_list(definition->items[0])->len != 0 || !is_op(definition->items[1]))
        return B_NONE;
    for (int i = 0; i < 6; i++) {
        if (!name_is(definition->items[1], names[i])) continue;
        Stack *target = primitive_stack(m, names[i]);
        return target && target->native && !target->len && !strcmp(target->native->name, names[i])
                   ? i : B_NONE;
    }
    return B_NONE;
}

/* 0 and *out set, or 1 when the primitive would raise an error */
static int op_binary(int operation, double x, double y, double *out) {
    double value;
    switch (operation) {
    case B_ADD: value = x + y; break;
    case B_SUB: value = x - y; break;
    case B_MUL: value = x * y; break;
    case B_DIV: if (y == 0) return 1; value = x / y; break;
    case B_IDIV: if (y == 0) return 1; value = floordiv(x, y); break;
    default: value = pow(x, y); break;
    }
    if (!isfinite(value)) return 1;
    *out = value;
    return 0;
}

static void op_restore(Stack *d, Val saved) {
    List *items = as_list(saved);
    d->len = 0;
    for (uint32_t i = 0; i < items->len; i++) spush(d, items->items[i]);
}

/* Runs `program` (the op of the operation under CATCH) on the selected stack with the pair on top.
   0 and *out set; 1 with an error pending: the op's own error, or a Stack-Error/Type-Error
   when it does not leave exactly one number. The stack is restored on failure. */
static int op_call(Machine *m, Val program, Val marker, Val saved, Val x, Val y,
                          double *out) {
    Stack *d = &m->data;
    size_t base = as_list(saved)->len;
    spush(d, x);
    spush(d, y);
    machine_run(m, program);
    if (d->len > base && d->items[d->len - 1] == marker) {
        m->err_original = d->items[d->len - 2];
        op_restore(d, saved);
        return 1;
    }
    if (d->len != base + 1 || !is_num(d->items[d->len - 1])) {
        const char *kind = d->len == base + 1 ? "Type-Error" : "Stack-Error";
        op_restore(d, saved);
        return bo_err(m, kind, NULL, list_of2(x, y));
    }
    *out = as_num(d->items[--d->len]);
    return 0;
}

static int n_broadcast(Machine *m, Val *a) {
    if (!is_list(a[2]) || as_list(a[2])->len != 1 || !is_op(as_list(a[2])->items[0]))
        return tensor_error(m, "Type-Error", a, 3);
    Val op = as_list(a[2])->items[0];
    TensorParts left_parts, right_parts;
    TensorParts *left = is_num(a[0]) ? NULL : &left_parts;
    TensorParts *right = is_num(a[1]) ? NULL : &right_parts;
    int left_rc = left ? tensor_parts(a[0], left) : 0;
    int right_rc = right ? tensor_parts(a[1], right) : 0;
    if (left_rc || right_rc)
        return tensor_error(m, tensor_kind(left_rc ? left_rc : right_rc), a, 3);
    if ((is_num(a[0]) && !isfinite(as_num(a[0]))) ||
        (is_num(a[1]) && !isfinite(as_num(a[1]))))
        return tensor_error(m, "Domain-Error", a, 3);

    List *shape;
    uint32_t len;
    if (broadcast_shape(m, a, left, right, &shape, &len)) return 1;
    uint32_t *coordinates = shape->len ? malloc((size_t)shape->len * sizeof(uint32_t)) : NULL;
    if (shape->len && !coordinates) {
        fputs("out of memory\n", stderr);
        exit(2);
    }
    List *data = list_new(len);

    /* the op runs nested, so everything held in C must stay reachable */
    size_t root_mark = m->nroots;
    for (int i = 0; i < 3; i++) root_add(m, a[i]);
    root_add(m, from_list(shape));
    root_add(m, from_list(data));
    Val marker = list_of1(from_num(0));
    Val catch_items[4] = {list_of1(op), list_of1(marker), list_from(NULL, 0),
                          from_op(as_list(str_list("CATCH")))};
    Val program = list_from(catch_items, 4);
    Val saved = list_from(m->data.items, (uint32_t)m->data.len);
    root_add(m, program);
    root_add(m, saved);

    int operation = op_operation(m, op);
    double result = 0;
    for (int pass = 0; pass < 2; pass++) {
        int fell_back = 0;
        for (uint32_t index = 0; index < len; index++) {
            uint32_t remaining = index;
            for (uint32_t axis = shape->len; axis-- > 0;) {
                uint32_t dimension = (uint32_t)as_num(shape->items[axis]);
                coordinates[axis] = remaining % dimension;
                remaining /= dimension;
            }
            Val x = left ? broadcast_element(left, shape, coordinates) : a[0];
            Val y = right ? broadcast_element(right, shape, coordinates) : a[1];
            if (operation != B_NONE) {
                if (op_binary(operation, as_num(x), as_num(y), &result)) {
                    /* run the op itself so that the failure is the one it raises */
                    operation = B_NONE;
                    fell_back = 1;
                    break;
                }
            } else {
                int rc = op_call(m, program, marker, saved, x, y, &result);
                if (rc) {
                    free(coordinates);
                    m->nroots = root_mark;
                    return rc;
                }
            }
            data->items[index] = from_num(result);
        }
        if (!fell_back) break;
    }
    free(coordinates);
    m->nroots = root_mark;
    if (!left && !right) data_push(m, from_num(result));
    else data_push(m, list_of2(from_list(data), from_list(shape)));
    return 0;
}

/* A, B, C ... T axis U REDUCE: folds each slice of T along `axis` (or all of T for `()`)
   from left to right with the op of unit U, starting from the slice's first element. */
static int n_reduce(Machine *m, Val *a) {
    if (!is_list(a[2]) || as_list(a[2])->len != 1 || !is_op(as_list(a[2])->items[0]))
        return tensor_error(m, "Type-Error", a, 3);
    Val op = as_list(a[2])->items[0];
    TensorParts tensor;
    int rc = tensor_parts(a[0], &tensor);
    if (rc) return tensor_error(m, tensor_kind(rc), a, 3);

    int all_axes = is_list(a[1]) && !as_list(a[1])->len;
    if (!all_axes && !is_int(a[1])) return tensor_error(m, "Type-Error", a, 3);
    uint32_t axis = 0;
    if (!all_axes) {
        double requested = as_num(a[1]);
        if (requested < 0 || requested >= tensor.rank)
            return tensor_error(m, "Domain-Error", a, 3);
        axis = (uint32_t)requested;
    }

    uint64_t outer = 1, width = 1;
    if (!all_axes) {
        for (uint32_t index = 0; index < axis; index++) {
            outer *= (uint32_t)as_num(tensor.shape->items[index]);
            if (outer > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 3);
        }
        for (uint32_t index = axis + 1; index < tensor.rank; index++) {
            width *= (uint32_t)as_num(tensor.shape->items[index]);
            if (width > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 3);
        }
    }
    uint32_t dimension = all_axes ? tensor.len : (uint32_t)as_num(tensor.shape->items[axis]);
    uint64_t count = outer * width;
    if (count > UINT32_MAX) return tensor_error(m, "Resource-Error", a, 3);
    if (count && !dimension) return tensor_error(m, "Domain-Error", a, 3);
    List *data = list_new((uint32_t)count);

    /* the op runs nested, so everything held in C must stay reachable */
    size_t root_mark = m->nroots;
    for (int i = 0; i < 3; i++) root_add(m, a[i]);
    root_add(m, from_list(data));
    Val marker = list_of1(from_num(0));
    Val catch_items[4] = {list_of1(op), list_of1(marker), list_from(NULL, 0),
                          from_op(as_list(str_list("CATCH")))};
    Val program = list_from(catch_items, 4);
    Val saved = list_from(m->data.items, (uint32_t)m->data.len);
    root_add(m, program);
    root_add(m, saved);

    int operation = op_operation(m, op);
    for (int pass = 0; pass < 2; pass++) {
        int fell_back = 0;
        for (uint64_t outer_index = 0; outer_index < outer && !fell_back; outer_index++) {
            for (uint64_t inner_index = 0; inner_index < width; inner_index++) {
                double result = as_num(tensor.data->items[
                    (uint64_t)outer_index * dimension * width + inner_index]);
                for (uint32_t index = 1; index < dimension; index++) {
                    Val element = tensor.data->items[
                        ((uint64_t)outer_index * dimension + index) * width + inner_index];
                    if (operation != B_NONE) {
                        if (op_binary(operation, result, as_num(element), &result)) {
                            /* run the op itself so that the failure is the one it raises */
                            operation = B_NONE;
                            fell_back = 1;
                            break;
                        }
                    } else {
                        int rc = op_call(m, program, marker, saved, from_num(result), element,
                                           &result);
                        if (rc) {
                            m->nroots = root_mark;
                            return rc;
                        }
                    }
                }
                if (fell_back) break;
                data->items[outer_index * width + inner_index] = from_num(result);
            }
        }
        if (!fell_back) break;
    }
    m->nroots = root_mark;

    if (all_axes) {
        push_num(m, as_num(data->items[0]));
        return 0;
    }
    List *shape = list_new(tensor.rank - 1);
    for (uint32_t index = 0, output = 0; index < tensor.rank; index++)
        if (index != axis) shape->items[output++] = tensor.shape->items[index];
    data_push(m, list_of2(from_list(data), from_list(shape)));
    return 0;
}

static int n_eq(Machine *m, Val *a) {
    push_num(m, val_equal(a[0], a[1]) ? 1 : 0);
    return 0;
}

/* ---- I/O */

static int io_error(Machine *m, const char *path) {
    char msg[512];
    if (path) snprintf(msg, sizeof msg, "[Errno %d] %s: '%s'", errno, strerror(errno), path);
    else snprintf(msg, sizeof msg, "[Errno %d] %s", errno, strerror(errno));
    return bo_err1(m, "Io-Error", NULL, str_list(msg));
}

static Stream *get_stream(Machine *m, Val handle, int *rc) {
    *rc = 0;
    if (!is_int(handle)) { *rc = bo_err1(m, "Type-Error", NULL, handle); return NULL; }
    double h = as_num(handle);
    if (h < 0 || h >= (double)m->nstreams || !m->streams[(size_t)h].f) {
        *rc = bo_err1(m, "Existence-Error", NULL, handle);
        return NULL;
    }
    return &m->streams[(size_t)h];
}

/* list of code points -> NUL-terminated UTF-8 string (caller frees) */
static int to_cstr(Machine *m, Val v, char **out) {
    if (!is_list(v)) return bo_err1(m, "Type-Error", NULL, v);
    Buf b = {0};
    buf_put(&b, "", 0);
    int rc = codes_to_utf8(v, &b);
    if (rc) {
        free(b.s);
        return bo_err1(m, rc == 1 ? "Type-Error" : "Domain-Error", NULL, v);
    }
    *out = b.s;
    return 0;
}

static int n_open(Machine *m, Val *a) {
    char *path, *mode;
    if (to_cstr(m, a[0], &path)) return 1;
    if (to_cstr(m, a[1], &mode)) { free(path); return 1; }
    static const char *modes[] = {"r", "w", "a", "rb", "wb", "ab"};
    int ok = 0;
    for (int i = 0; i < 6; i++) ok |= strcmp(mode, modes[i]) == 0;
    if (!ok) {
        free(path); free(mode);
        return bo_err1(m, "Domain-Error", NULL, a[1]);
    }
    int binary = strchr(mode, 'b') != NULL;
    FILE *f = fopen(path, mode);
    if (!f) {
        int rc = io_error(m, path);
        free(path); free(mode);
        return rc;
    }
    free(path); free(mode);
    if (m->nstreams == m->streams_cap) {
        m->streams_cap *= 2;
        m->streams = realloc(m->streams, m->streams_cap * sizeof(Stream));
    }
    m->streams[m->nstreams] = (Stream){f, binary};
    push_num(m, (double)m->nstreams++);
    return 0;
}

static int n_close(Machine *m, Val *a) {
    int rc;
    Stream *s = get_stream(m, a[0], &rc);
    if (!s) return rc;
    if (as_num(a[0]) < 3) return bo_err1(m, "Permission-Error", NULL, a[0]);
    FILE *f = s->f;
    s->f = NULL;
    if (fclose(f)) return io_error(m, NULL);
    return 0;
}

static int n_read(Machine *m, Val *a) {
    int rc;
    Stream *s = get_stream(m, a[0], &rc);
    if (!s) return rc;
    if (s->f == stdin) fflush(stdout);
    int c = fgetc(s->f);
    if (c == EOF) {
        push_num(m, -1);
        return 0;
    }
    if (!s->binary && c >= 0xC0) {
        uint32_t cp;
        int extra;
        if (c >= 0xF0) { cp = c & 7; extra = 3; }
        else if (c >= 0xE0) { cp = c & 15; extra = 2; }
        else { cp = c & 31; extra = 1; }
        while (extra-- > 0) {
            int d = fgetc(s->f);
            if (d == EOF) break;
            if ((d & 0xC0) != 0x80) { ungetc(d, s->f); break; }
            cp = (cp << 6) | (d & 63);
        }
        c = (int)cp;
    }
    push_num(m, c);
    return 0;
}

int bo_stdout_midline;

static int n_write(Machine *m, Val *a) {
    int rc;
    Stream *s = get_stream(m, a[1], &rc);
    if (!s) return rc;
    if (!is_int(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    double d = as_num(a[0]);
    if (s->binary ? (d < 0 || d > 255) : (d < 0 || d > 0x10FFFF))
        return bo_err1(m, "Domain-Error", NULL, a[0]);
    if (s->binary) {
        if (fputc((int)d, s->f) == EOF) return io_error(m, NULL);
        if (s->f == stdout) bo_stdout_midline = (int)d != '\n';
    } else {
        char tmp[4];
        size_t k = utf8_put(tmp, (uint32_t)d);
        if (fwrite(tmp, 1, k, s->f) != k) return io_error(m, NULL);
        if (s->f == stdout) bo_stdout_midline = tmp[k - 1] != '\n';
    }
    if (as_num(a[1]) == 2) fflush(s->f);
    return 0;
}

static char *resolve_path(const char *p) {
    char *r = realpath(p, NULL);
    if (r) return r;
    if (p[0] == '/') return strdup(p);
    char cwd[PATH_MAX];
    if (!getcwd(cwd, sizeof cwd)) return strdup(p);
    char *out = malloc(strlen(cwd) + strlen(p) + 2);
    sprintf(out, "%s/%s", cwd, p);
    return out;
}

static void mark_included(Machine *m, const char *path) {
    m->included = realloc(m->included, (m->nincluded + 1) * sizeof(char *));
    m->included[m->nincluded++] = resolve_path(path);
}

/* A file that did not finish loading no longer counts as included, so that `include` tries it again. */
static void unmark_included(Machine *m, const char *resolved) {
    size_t kept = 0;
    for (size_t i = 0; i < m->nincluded; i++) {
        if (!strcmp(m->included[i], resolved)) free(m->included[i]);
        else m->included[kept++] = m->included[i];
    }
    m->nincluded = kept;
}

/* Ends the loads in progress above `depth`: an error aborted them. */
static void unwind_loading(Machine *m, size_t depth) {
    while (m->nloading > depth) {
        char *path = m->loading[--m->nloading];
        unmark_included(m, path);
        free(path);
    }
}

static char *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    size_t cap = 4096, n = 0;
    char *buf = malloc(cap);
    size_t got;
    while ((got = fread(buf + n, 1, cap - n, f)) > 0) {
        n += got;
        if (n == cap) buf = realloc(buf, cap *= 2);
    }
    fclose(f);
    buf[n] = 0;
    *len = n;
    return buf;
}

/* The id of the source file at `path`: it stays the same for as long as the machine lives, and
   tags what the file's load pushes and locks. It is also the owner of the private ops (`__name`)
   the file writes, unless private ops are switched off. */
static uint32_t file_id(Machine *m, const char *path) {
    char *resolved = resolve_path(path);
    for (size_t i = 0; i < m->nowners; i++)
        if (!strcmp(m->owners[i], resolved)) {
            free(resolved);
            return (uint32_t)i + 1;
        }
    if (m->nowners == m->owners_cap) {
        m->owners_cap = m->owners_cap ? m->owners_cap * 2 : 16;
        m->owners = realloc(m->owners, m->owners_cap * sizeof *m->owners);
    }
    m->owners[m->nowners++] = resolved;
    return (uint32_t)m->nowners;
}

/* Loading a file again first takes out what its earlier load left: the items it pushed, the locks
   it set and the stacks it made, once nothing is left in them. What other files, or the program
   after the load, put in the same stacks stays where it is. */
static void wipe_file(Machine *m, uint32_t file) {
    if (!file) return;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            if (s->locked && s->locked_by == file) {
                s->locked = 0;
                s->locked_by = 0;
                s->unlocked_for = file;
            }
            size_t n = s->owners_len < s->len ? s->owners_len : s->len;
            if (!s->locked && n) {
                size_t kept = 0;
                for (size_t i = 0; i < n; i++) {
                    if (s->owners[i] == file) continue;
                    s->items[kept] = s->items[i];
                    s->owners[kept++] = s->owners[i];
                }
                if (kept < n) {
                    memmove(s->items + kept, s->items + n, (s->len - n) * sizeof *s->items);
                    s->len -= n - kept;
                    s->owners_len = kept;
                    m->epoch++;
                }
            }
            if (s->exists && s->creator == file && !s->len && !s->locked && !s->native) {
                s->exists = 0;
                s->creator = 0;
                s->owners_len = 0;
                s->unlocked_for = 0;
                m->epoch++;
            }
        }
}

/* Ends a file's load. A lock that its reload lifted and that it did not set again stays lifted,
   unless the load failed, which puts it back. `file` 0 stands for every file: an error abandoned
   all the loads in progress. */
static void finish_load(Machine *m, uint32_t file, int failed) {
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) {
            if (!s->unlocked_for || (file && s->unlocked_for != file)) continue;
            if (failed && !s->locked) {
                s->locked = 1;
                s->locked_by = s->unlocked_for;
            }
            s->unlocked_for = 0;
        }
}

/* A file that is loaded again starts from scratch: the private ops of its earlier load go. */
static void discard_private_stacks(Machine *m, uint32_t owner) {
    if (!owner) return;
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain)
            if (s->exists && stack_is_private(s) && as_op(as_list(s->key)->items[0])->owner == owner) {
                s->len = 0;
                s->owners_len = 0;
                s->exists = 0;
                m->epoch++;
            }
}

/* Where a relative include path is found: next to the including file, then relative to the
   current directory, then under the library home. Without a match the path is left as it is. */
static char *find_include(Machine *m, const char *path) {
    if (path[0] != '/') {
        const char *slash = strcmp(m->source, "stdin") ? strrchr(m->source, '/') : NULL;
        if (slash) {
            size_t prefix = (size_t)(slash - m->source + 1);
            char *relative = malloc(prefix + strlen(path) + 1);
            memcpy(relative, m->source, prefix);
            strcpy(relative + prefix, path);
            if (!access(relative, R_OK)) return relative;
            free(relative);
        }
        if (!access(path, R_OK)) return strdup(path);
        if (m->home) {
            char *under_home = malloc(strlen(m->home) + strlen(path) + 2);
            sprintf(under_home, "%s/%s", m->home, path);
            if (!access(under_home, R_OK)) return under_home;
            free(under_home);
        }
    }
    return strdup(path);
}

static char *include_path(Machine *m, char *path) {
    char *found = find_include(m, path);
    free(path);
    return found;
}

static int n_include(Machine *m, Val *a) {
    char *path;
    if (to_cstr(m, a[0], &path)) return 1;
    path = include_path(m, path);
    char *resolved_path = resolve_path(path);
    for (size_t i = 0; i < m->nloading; i++)
        if (!strcmp(m->loading[i], resolved_path)) {
            free(resolved_path);
            Val name = str_list(path);
            free(path);
            return bo_err1(m, "Cycle-Error", NULL, name);
        }
    free(resolved_path);
    size_t len;
    char *text = read_file(path, &len);
    if (!text) {
        int rc = io_error(m, path);
        free(path);
        return rc;
    }
    Forms forms;
    LowerErr le;
    uint32_t file = file_id(m, path);
    uint32_t owner = m->private_ops ? file : 0;
    int bad = lower_op_forms(text, len, 1, owner, &forms, &le);
    if (bad) {
        free(forms.f); free(text); free(path);
        Val d[2] = {str_list(le.msg), from_num(le.line)};
        return bo_err(m, "Syntax-Error", NULL, list_from(d, 2));
    }
    free(text);
    mark_included(m, path);
    m->loading = realloc(m->loading, (m->nloading + 1) * sizeof(char *));
    m->loading[m->nloading++] = resolve_path(path);
    discard_private_stacks(m, owner);
    wipe_file(m, file);
    uint32_t outer_file = m->cur_file;
    m->cur_file = file;
    run_forms(m, &forms, path);
    m->cur_file = outer_file;
    finish_load(m, file, m->propagating);
    free(forms.f);
    /* the source name must outlive error lists only while running: they copy it */
    free(path);
    if (m->propagating) {
        m->propagating = 0;
        unwind_loading(m, m->nloading - 1);
        return 2;
    }
    free(m->loading[--m->nloading]);
    return 0;
}

static int n_included(Machine *m, Val *a) {
    char *path;
    if (to_cstr(m, a[0], &path)) return 1;
    path = include_path(m, path);
    char *r = resolve_path(path);
    int found = 0;
    for (size_t i = 0; i < m->nincluded; i++) found |= strcmp(m->included[i], r) == 0;
    free(r);
    free(path);
    push_num(m, found);
    return 0;
}

static int n_parse(Machine *m, Val *a) {
    if (!is_list(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    Buf b = {0};
    buf_put(&b, "", 0);
    int rc = codes_to_utf8(a[0], &b);
    if (rc) {
        free(b.s);
        return bo_err1(m, rc == 1 ? "Type-Error" : "Domain-Error", NULL, a[0]);
    }
    Forms forms;
    LowerErr le;
    int bad = lower_op_forms(b.s, b.n, 1, 0, &forms, &le);
    free(b.s);
    if (bad) {
        free(forms.f);
        Val d[2] = {str_list(le.msg), from_num(le.line)};
        return bo_err(m, "Syntax-Error", NULL, list_from(d, 2));
    }
    size_t total = 0;
    for (size_t i = 0; i < forms.n; i++) total += as_list(forms.f[i].list)->len;
    List *program = list_new((uint32_t)total);
    size_t k = 0;
    for (size_t i = 0; i < forms.n; i++) {
        List *l = as_list(forms.f[i].list);
        for (uint32_t j = 0; j < l->len; j++) program->items[k++] = l->items[j];
    }
    free(forms.f);
    data_push(m, from_list(program));
    return 0;
}

static int n_throw(Machine *m, Val *a) {
    if (!is_list(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    Val name;
    int rc = selector_to_name(a[1], &name);
    if (rc) return bo_err1(m, rc == NAME_TYPE_ERROR ? "Type-Error" : "Representation-Error", NULL, a[1]);
    m->err_kind = a[1];
    m->err_where = "THROW";
    m->err_data = a[0];
    return 1;
}

int bo_exit_status = -1; /* set when a program called exit under WebAssembly, where the host module itself keeps running */

static int n_exit(Machine *m, Val *a) {
    (void)m;
    if (!is_int(a[0])) return bo_err1(m, "Type-Error", NULL, a[0]);
    double status = as_num(a[0]);
    if (status < 0 || status > 255) return bo_err1(m, "Domain-Error", NULL, a[0]);
    fflush(stdout);
#ifdef __EMSCRIPTEN__
    bo_exit_status = (int)status;
    if (m->abort_jmp) longjmp(*m->abort_jmp, 1);
#endif
    exit((int)status);
}

static int n_abort(Machine *m, Val *a) {
    (void)a;
    if (m->abort_jmp) longjmp(*m->abort_jmp, 1);
    exit(1);
}

/* ---- debugging: pause and resume (debugger.inc drives the paused program) */

/* A program that is not run by the step driver (a script, an included file, a nested run such
   as PARALLEL) cannot be paused, so the breakpoint does nothing there. */
static int n_breakpoint(Machine *m, Val *a) {
    (void)a;
    if (m->stepping && m->base == m->step_base) m->paused = m->bp_hit = 1;
    return 0;
}

static int resume_request(Machine *m, int request, const char *where) {
    if (!m->in_pause) return bo_err0(m, "Debug-Error", where);
    m->resume = request;
    return 0;
}

static int n_step(Machine *m, Val *a) { (void)a; return resume_request(m, RESUME_STEP, "STEP"); }
static int n_next(Machine *m, Val *a) { (void)a; return resume_request(m, RESUME_NEXT, "NEXT"); }
static int n_continue(Machine *m, Val *a) { (void)a; return resume_request(m, RESUME_CONTINUE, "CONTINUE"); }
static int n_stop(Machine *m, Val *a) { (void)a; return resume_request(m, RESUME_STOP, "STOP"); }

/* The code frames of the control stack, innermost first, as (NAME LIST INDEX): the op that
   called the frame (a unit, or () if none did), the list it runs, and the number of its items
   that already ran. */
static int n_backtrace(Machine *m, Val *a) {
    (void)a;
    size_t n = 0;
    for (size_t i = m->ctl_len; i-- > 0;) n += m->ctl[i].kind == FR_CODE;
    Val *frames = malloc((n + 1) * sizeof *frames);
    size_t k = 0;
    for (size_t i = m->ctl_len; i-- > 0;) {
        Frame *f = &m->ctl[i];
        if (f->kind != FR_CODE) continue;
        List *program = as_list(f->a);
        size_t done = f->idx < (size_t)f->code->n ? (size_t)f->code->instrs[f->idx].src : program->len;
        Val parts[3] = {f->b ? list_of1(f->b) : list_from(NULL, 0), f->a, from_num((double)done)};
        frames[k++] = list_from(parts, 3);
    }
    Val result = list_from(frames, (uint32_t)n);
    free(frames);
    data_push(m, result);
    return 0;
}

static const Native NATIVES[] = {
    {"PUSH", 2, 1, n_push},     {"LAMBDA", 2, 1, n_lambda},
    {"REC", 1, 1, n_rec},       {"POP", 1, 1, n_pop},       {"TOP", 1, 1, n_top},
    {"SNAPSHOT", 1, 1, n_see},       {"DEPTH", 1, 1, n_depth},   {"EXISTS", 1, 1, n_exists},
    {"LOCKED", 1, 1, n_locked},
    {"CLEAR", 0, 0, n_clr},     {"LEXICON", 0, 0, n_lexicon}, {"DELETE", 0, 0, n_delete},
    {"LOCK", 0, 0, n_lock},     {"UNLOCK", 0, 0, n_unlock}, {"DROP", 1, 0, n_drop},
    {"PICK", 1, 0, n_pick},     {"ROLL", 1, 0, n_roll},     {"UNIT", 1, 0, n_unit}, {"CONSL", 2, 0, n_consl},
    {"CONSR", 2, 0, n_consr},   {"UNCONSL", 1, 0, n_unconsl},{"UNCONSR", 1, 0, n_unconsr},
    {"TYPE", 1, 0, n_type},     {"RATIO", 1, 0, n_ratio},   {"APPLY", 1, 0, n_apply},
    {"IFTE", 3, 0, n_ifte},     {"LOOP", 2, 0, n_loop},     {"PARALLEL", 2, 0, n_parallel},
    {"ADD", 2, 0, n_add},       {"SUB", 2, 0, n_sub},
    {"MUL", 2, 0, n_mul},       {"DIV", 2, 0, n_div},       {"IDIV", 2, 0, n_idiv},
    {"POW", 2, 0, n_pow},       {"RANGE", 3, 0, n_colon},
    {"BROADCAST", 3, 0, n_broadcast},
    {"ARRAY", 2, 0, n_tensor}, {"SHAPE", 1, 0, n_shape}, {"RANK", 1, 0, n_rank},
    {"RESHAPE", 2, 0, n_reshape}, {"FETCH", 2, 0, n_tget}, {"STORE", 3, 0, n_tset},
    {"CHUNK", 2, 0, n_tsplit}, {"CONCAT", 1, 0, n_tconcat}, {"REDUCE", 3, 0, n_reduce},
    {"DOT", 2, 0, n_tdot},
    {"MEAN", 2, 0, n_tmean}, {"MEDIAN", 2, 0, n_tmedian},
    {"TRANSPOSE", 1, 0, n_ttranspose},
    {"OUTER", 2, 0, n_touter}, {"MATMUL", 2, 0, n_tmatmul},
    {"EQUAL", 2, 0, n_eq},        {"OPEN", 2, 0, n_open},     {"CLOSE", 1, 0, n_close},
    {"READ", 1, 0, n_read},     {"WRITE", 2, 0, n_write},       {"INCLUDE", 1, 0, n_include},
    {"INCLUDED", 1, 0, n_included}, {"PARSE", 1, 0, n_parse}, {"CATCH", 2, 0, n_catch}, {"CALL", 4, 0, n_call},
    {"THROW", 2, 0, n_throw}, {"RETHROW", 1, 0, n_rethrow},
    {"EXIT", 1, 0, n_exit},     {"ABORT", 0, 0, n_abort},
    {"BREAKPOINT", 0, 0, n_breakpoint}, {"STEP", 0, 0, n_step}, {"NEXT", 0, 0, n_next},
    {"CONTINUE", 0, 0, n_continue}, {"STOP", 0, 0, n_stop}, {"BACKTRACE", 0, 0, n_backtrace},
};

static const Native OP_NATIVES[] = {
    {"CONSL", 2, 0, n_unit_consl}, {"CONSR", 2, 0, n_unit_consr},
    {"UNCONSL", 1, 0, n_unit_unconsl}, {"UNCONSR", 1, 0, n_unit_unconsr},
    {"UNITTYPE", 1, 0, n_utype}, {"SELECTOR", 1, 0, n_selector}, {"NAME", 1, 0, n_name},
};

/* ------------------------------------------------------------------ top level */

void machine_init(Machine *m) {
    memset(m, 0, sizeof *m);
    m->source = "stdin";
    m->line = 1;
    m->streams_cap = 16;
    m->streams = calloc(m->streams_cap, sizeof(Stream));
    m->streams[0] = (Stream){stdin, 0};
    m->streams[1] = (Stream){stdout, 0};
    m->streams[2] = (Stream){stderr, 0};
    m->nstreams = 3;
    for (size_t i = 0; i < sizeof NATIVES / sizeof NATIVES[0]; i++) {
        Val op = from_op(as_list(str_list(NATIVES[i].name)));
        Stack *op_stack = stack_lookup(m, list_of1(op), 1);
        op_stack->native = &NATIVES[i];
        op_stack->locked = 1;
    }
    for (size_t i = 0; i < sizeof OP_NATIVES / sizeof OP_NATIVES[0]; i++) {
        Val op = from_op(as_list(str_list(OP_NATIVES[i].name)));
        Stack *s = stack_lookup(m, list_of1(op), 1);
        s->native = &OP_NATIVES[i];
        s->locked = 1;
    }
    for (size_t i = 0; i < sizeof specializations / sizeof specializations[0]; i++) {
        Val op = from_op(as_list(str_list(specializations[i].op)));
        Val primitive = from_op(as_list(str_list(specializations[i].primitive)));
        stack_lookup(m, list_of1(op), 2)->invalidates_code = 1;
        stack_lookup(m, list_of1(primitive), 2)->invalidates_code = 1;
    }
    m->exception = stack_lookup(m, list_of1(from_op(as_list(str_list("EXCEPTION")))), 2);
    m->diagnostics = stack_lookup(m, list_of1(from_op(as_list(str_list("DIAGNOSTICS")))), 1);
    m->diagnostics->locked = 1;
    m->optimize_instrs = !getenv("BO_NO_OP_OPTIMIZATIONS");
    m->private_ops = !getenv("BO_NO_PRIVATE");
    m->epoch++;
}


static int execute_text(Machine *m, const char *text, size_t len, const char *source, int first_line,
                        int file) {
    jmp_buf jb;
    jmp_buf *saved_jmp = m->abort_jmp;
    const char *saved_src = m->source;
    int saved_line = m->line;
    size_t saved_base = m->base, saved_len = m->ctl_len, saved_roots = m->nroots;
    size_t saved_loading = m->nloading;
    uint32_t saved_file = m->cur_file;
    m->abort_jmp = &jb;
    if (setjmp(jb)) {
        unwind_loading(m, saved_loading);
        m->cur_file = saved_file;
        finish_load(m, 0, 1);
        m->base = saved_base;
        m->ctl_len = saved_len;
        m->nroots = saved_roots;
        m->source = saved_src;
        m->line = saved_line;
        m->handling = 0;
        m->abort_jmp = saved_jmp;
        return 0;
    }
    Forms forms;
    LowerErr le;
    uint32_t file_tag = file ? file_id(m, source) : 0;
    uint32_t owner = m->private_ops ? file_tag : 0;
    int bad = lower_op_forms(text, len, first_line, owner, &forms, &le);
    if (bad) {
        free(forms.f);
        m->source = source;
        m->line = le.line;
        bo_err1(m, "Syntax-Error", "LOWER", str_list(le.msg));
        m->base = m->ctl_len;
        fail(m);
        run_loop(m);
        m->base = saved_base;
        m->source = saved_src;
        m->line = saved_line;
        m->handling = 0;
        m->abort_jmp = saved_jmp;
        return 0;
    }
    discard_private_stacks(m, owner);
    wipe_file(m, file_tag);
    if (file) {
        m->loading = realloc(m->loading, (m->nloading + 1) * sizeof(char *));
        m->loading[m->nloading++] = resolve_path(source);
    }
    m->cur_file = file_tag;
    run_forms(m, &forms, source);
    m->cur_file = saved_file;
    finish_load(m, file_tag, 0);
    if (file) free(m->loading[--m->nloading]);
    free(forms.f);
    m->handling = 0;
    m->abort_jmp = saved_jmp;
    return 1;
}

int execute(Machine *m, const char *text, size_t len, const char *source, int first_line) {
    return execute_text(m, text, len, source, first_line, 0);
}

/* the text of a source file: its `__` ops are private to it */
int execute_file(Machine *m, const char *text, size_t len, const char *source) {
    return execute_text(m, text, len, source, 1, 1);
}

int include_file(Machine *m, const char *path) {
    char *name = find_include(m, path);
    mark_included(m, name);
    size_t len;
    char *text = read_file(name, &len);
    if (!text) {
        fprintf(stderr, "Cannot read %s: %s\n", name, strerror(errno));
        free(name);
        return 0;
    }
    int ok = execute_file(m, text, len, name);
    free(text);
    if (!ok) {
        char *r = resolve_path(name);
        unmark_included(m, r);
        free(r);
    }
    free(name);
    return ok;
}

/* Like include_file, but a file that is already loaded is left alone (what `require` does). */
int include_file_once(Machine *m, const char *path) {
    char *name = find_include(m, path);
    char *resolved = resolve_path(name);
    int loaded = 0;
    for (size_t i = 0; i < m->nincluded; i++) loaded |= strcmp(m->included[i], resolved) == 0;
    free(resolved);
    free(name);
    return loaded || include_file(m, path);
}

static void dump_val(FILE *out, Val v) {
    if (is_list(v)) {
        List *l = as_list(v);
        fputc('(', out);
        for (uint32_t i = 0; i < l->len; i++) {
            if (i) fputc(' ', out);
            dump_val(out, l->items[i]);
        }
        fputc(')', out);
    } else if (is_op(v)) {
        Buf name = {0};
        codes_to_utf8(from_list(as_op(v)), &name);
        if (name.s) fputs(name.s, out);
        free(name.s);
    } else {
        fprintf(out, "%.17g", as_num(v));
    }
}

void dump_stack(Machine *m, FILE *out) {
    for (size_t i = 0; i < m->data.len; i++) {
        if (i) fputc(' ', out);
        dump_val(out, m->data.items[i]);
    }
    fputc('\n', out);
}

static double bo_h_div(double x, double y) {
    if (y == 0) return NAN;
    double r = x / y;
    return isfinite(r) ? r : NAN;
}
static double bo_h_idiv(double x, double y) {
    if (y == 0) return NAN;
    double r = floordiv(x, y);
    return isfinite(r) ? r : NAN;
}

#include "debugger.inc"
