/* Heap: immutable lists, structural hash/equality, mark-sweep collector. */
#include "bo.h"

static List *all_lists;
size_t heap_alloc;
size_t heap_gc_at = 32u << 20;
static size_t heap_live;

/* Small lists (capacity up to POOL_MAX, which includes every slice header) come from
   per-size free lists refilled in 256 KB chunks, so allocating and sweeping them costs no
   malloc/free; larger ones use malloc. Chunks are kept for the life of the process. */
#define POOL_MAX 8
#define CHUNK_BYTES (256u << 10)
static List *pool_free[POOL_MAX + 1];

static List *pool_take(uint32_t cap) {
    List *l = pool_free[cap];
    if (l) { pool_free[cap] = l->next; return l; }
    size_t size = sizeof(List) + (size_t)cap * sizeof(Val);
    size_t count = CHUNK_BYTES / size;
    char *chunk = malloc(count * size);
    if (!chunk) return NULL;
    for (size_t i = 1; i < count; i++) {
        List *f = (List *)(chunk + i * size);
        f->next = pool_free[cap];
        pool_free[cap] = f;
    }
    return (List *)chunk;
}

static void list_free(List *l) {
    if (l->cap <= POOL_MAX) { l->next = pool_free[l->cap]; pool_free[l->cap] = l; }
    else free(l);
}

static List *list_alloc(uint32_t cap) {
    size_t size = sizeof(List) + (size_t)cap * sizeof(Val);
    List *l = cap <= POOL_MAX ? pool_take(cap) : malloc(size);
    if (!l) {
        fputs("out of memory\n", stderr);
        exit(2);
    }
    l->next = all_lists;
    all_lists = l;
    l->code = NULL;
    l->hash = 0;
    l->mark = 0;
    l->owner = 0;
    l->base = NULL;
    l->items = l->inl;
    l->used = l->len = 0;
    l->cap = cap;
    heap_alloc += size;
    return l;
}

List *list_new(uint32_t len) {
    List *l = list_alloc(len);
    l->len = l->used = len;
    return l;
}

/* A slice shares its parent's storage (UNCONS is O(1)); short ones are copied so they
   do not keep a big buffer alive. */
Val list_slice(List *l, uint32_t off, uint32_t len) {
    if (len <= 4) return list_from(l->items + off, len);
    List *v = list_alloc(0);
    v->base = l->base ? l->base : l;
    v->items = l->items + off;
    v->len = len;
    return from_list(v);
}

/* CONSR: grows in place (amortized O(1)) when l ends exactly where its storage is filled */
Val list_append(List *l, Val x) {
    List *o = l->base ? l->base : l;
    if (l->items + l->len == o->items + o->used && o->used < o->cap) {
        o->items[o->used++] = x;
        List *v = list_alloc(0);
        v->base = o;
        v->items = l->items;
        v->len = l->len + 1;
        return from_list(v);
    }
    List *r = list_alloc(l->len * 2 + 4);
    if (l->len) memcpy(r->items, l->items, (size_t)l->len * sizeof(Val));
    r->items[l->len] = x;
    r->len = r->used = l->len + 1;
    return from_list(r);
}

Val list_from(const Val *items, uint32_t len) {
    List *l = list_new(len);
    if (len) memcpy(l->items, items, (size_t)len * sizeof(Val));
    return from_list(l);
}

Val list_of1(Val a) { return list_from(&a, 1); }

Val list_of2(Val a, Val b) {
    Val v[2] = {a, b};
    return list_from(v, 2);
}

/* UTF-8 text to a list of code points */
Val str_list(const char *s) {
    size_t n = strlen(s), count = 0;
    Val *tmp = malloc((n + 1) * sizeof(Val));
    for (size_t i = 0; i < n;) {
        unsigned char c = (unsigned char)s[i];
        uint32_t cp = c;
        int extra = 0;
        if (c >= 0xF0) { cp = c & 7; extra = 3; }
        else if (c >= 0xE0) { cp = c & 15; extra = 2; }
        else if (c >= 0xC0) { cp = c & 31; extra = 1; }
        i++;
        while (extra-- > 0 && i < n && ((unsigned char)s[i] & 0xC0) == 0x80)
            cp = (cp << 6) | ((unsigned char)s[i++] & 63);
        tmp[count++] = from_num((double)cp);
    }
    Val r = list_from(tmp, (uint32_t)count);
    free(tmp);
    return r;
}

static inline uint32_t mix(uint32_t h, uint32_t x) {
    return h ^ (x + 0x9e3779b9u + (h << 6) + (h >> 2));
}

static uint32_t list_hash(List *l) {
    if (l->hash) return l->hash;
    uint32_t h = 0x811c9dc5u;
    for (uint32_t i = 0; i < l->len; i++) h = mix(h, val_hash(l->items[i]));
    if (!h) h = 1;
    return l->hash = h;
}

uint32_t val_hash(Val v) {
    if (is_list(v)) return list_hash(as_list(v));
    if (is_word(v)) {
        uint32_t h = mix(0x776f7264u, list_hash(as_word(v)));
        return as_word(v)->owner ? mix(h, as_word(v)->owner) : h;
    }
    uint64_t bits = v;
    return (uint32_t)((bits ^ (bits >> 32)) * 2654435761u);
}

int val_equal(Val a, Val b) {
    if (a == b) return 1;
    if (is_word(a) && is_word(b))
        return as_word(a)->owner == as_word(b)->owner &&
               val_equal(from_list(as_word(a)), from_list(as_word(b)));
    if (is_list(a) && is_list(b)) {
        List *x = as_list(a), *y = as_list(b);
        if (x->len != y->len) return 0;
        if (x->hash && y->hash && x->hash != y->hash) return 0;
        for (uint32_t i = 0; i < x->len; i++)
            if (!val_equal(x->items[i], y->items[i])) return 0;
        return 1;
    }
    if (is_num(a) && is_num(b)) return as_num(a) == as_num(b);
    return 0;
}

/* ------------------------------------------------------------------ collector */

static List **work;
static size_t work_n, work_cap;

static void mark_val(Val v) {
    if (!is_list(v) && !is_word(v)) return;
    List *l = is_word(v) ? as_word(v) : as_list(v);
    if (!l || l->mark) return;
    l->mark = 1;
    if (l->base) mark_val(from_list(l->base));
    if (work_n == work_cap) {
        work_cap = work_cap ? work_cap * 2 : 1024;
        work = realloc(work, work_cap * sizeof(List *));
    }
    work[work_n++] = l;
}

static void mark_stack(Stack *s) {
    mark_val(s->key);
    for (size_t i = 0; i < s->len; i++) mark_val(s->items[i]);
}

/* Called only at the interpreter's safe point, so every live value is reachable from
   the data stack, the named stacks, the control stack or the explicit root vector. */
void gc_collect(Machine *m) {
    mark_stack(&m->data);
    for (size_t b = 0; b < m->tcap; b++)
        for (Stack *s = m->table[b]; s; s = s->chain) mark_stack(s);
    for (size_t i = 0; i < m->ctl_len; i++) {
        if (m->ctl[i].kind == FR_CODE) m->ctl[i].code->keep = 1;
        mark_val(m->ctl[i].a);
        mark_val(m->ctl[i].b);
    }
    for (size_t i = 0; i < m->nroots; i++) mark_val(m->roots[i]);
    while (work_n) {
        List *l = work[--work_n];
        for (uint32_t i = 0; i < l->len; i++) mark_val(l->items[i]);
    }
    size_t live = 0;
    List **link = &all_lists;
    while (*link) {
        List *l = *link;
        if (l->mark) {
            l->mark = 0;
            live += sizeof(List) + (size_t)l->cap * sizeof(Val);
            if (l->code) {
                l->code->keep = 0;
                for (Code **cp = &l->code->prev; *cp;) { /* drop old versions no frame runs */
                    Code *o = *cp;
                    if (o->keep) { o->keep = 0; cp = &o->prev; }
                    else { *cp = o->prev; free(o); }
                }
                for (Code *c = l->code; c; c = c->prev) live += sizeof(Code) + (size_t)c->n * sizeof(Op);
            }
            link = &l->next;
        } else {
            *link = l->next;
            while (l->code) { Code *o = l->code; l->code = o->prev; free(o); }
            list_free(l);
        }
    }
    heap_live = live;
    heap_alloc = 0;
    heap_gc_at = live > (32u << 20) ? live : (32u << 20);
}
