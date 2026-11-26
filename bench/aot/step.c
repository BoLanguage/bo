/* Isolated AOT experiment: a preassembled STEP and the ordinary Bo runtime. */
#include "bo.h"

#include <errno.h>

void aot_step(Machine *m, Val call);

void aot_push_one(Machine *m) {
    Stack *s = &m->data;
    if (s->len == s->cap) {
        size_t cap = s->cap ? s->cap * 2 : 16;
        if (cap < s->cap || cap > SIZE_MAX / sizeof(Val)) {
            fputs("AOT experiment: data stack capacity overflow\n", stderr);
            exit(2);
        }
        Val *items = realloc(s->items, cap * sizeof(Val));
        if (!items) {
            fputs("AOT experiment: cannot grow data stack\n", stderr);
            exit(2);
        }
        s->items = items;
        s->cap = cap;
    }
    s->items[s->len++] = from_num(1);
}

void aot_call_word(Machine *m, Val call) {
    machine_run(m, call);
}

static void run(Machine *m, const char *code) {
    if (!execute(m, code, strlen(code), "aot-experiment", 1)) exit(1);
}

static void step(Machine *m, int aot, Val call, Val reference) {
    if (aot) aot_step(m, call);
    else machine_run(m, reference);
}

static size_t iterations(const char *text) {
    char *end;
    errno = 0;
    unsigned long n = strtoul(text, &end, 10);
    if (errno || !*text || *text == '-' || *end || !n || n > 100000000) {
        fputs("AOT experiment: iterations must be between 1 and 100000000\n", stderr);
        exit(2);
    }
    return (size_t)n;
}

int main(int argc, char **argv) {
    if (argc != 4 || (strcmp(argv[1], "aot") && strcmp(argv[1], "reference"))) {
        fputs("usage: step aot|reference normal|rebind|number|empty|missing|underflow ITERATIONS\n", stderr);
        return 2;
    }
    int aot = !strcmp(argv[1], "aot");
    const char *scenario = argv[2];
    size_t count = iterations(argv[3]);
    if (strcmp(scenario, "normal") && strcmp(scenario, "rebind") &&
        strcmp(scenario, "number") && strcmp(scenario, "empty") && strcmp(scenario, "missing") &&
        strcmp(scenario, "underflow")) {
        fprintf(stderr, "AOT experiment: unknown scenario: %s\n", scenario);
        return 2;
    }
    Machine m;
    machine_init(&m);
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    Val plus = from_word(as_list(str_list("+")));
    Val call = list_of1(plus);
    Val reference = list_of2(from_num(1), plus);
    if (m.roots_cap < m.nroots + 2) {
        size_t cap = m.nroots + 2;
        Val *roots = realloc(m.roots, cap * sizeof(Val));
        if (!roots) {
            fputs("AOT experiment: cannot allocate roots\n", stderr);
            return 2;
        }
        m.roots = roots;
        m.roots_cap = cap;
    }
    m.roots[m.nroots++] = call;
    m.roots[m.nroots++] = reference;
    if (strcmp(scenario, "underflow")) run(&m, "0");
    if (!strcmp(scenario, "missing")) run(&m, "(+) CLEAR");
    if (!strcmp(scenario, "number")) run(&m, "42 (+) PUSH");
    if (!strcmp(scenario, "empty")) run(&m, "() (+) PUSH");
    if (!strcmp(scenario, "rebind")) {
        step(&m, aot, call, reference);
        run(&m, "(() ADD 1 () ADD) unconsl consl (+) PUSH");
        gc_collect(&m);
        step(&m, aot, call, reference);
        run(&m, "(+) POP () DROP");
        gc_collect(&m);
    }
    for (size_t i = 0; i < count; i++) step(&m, aot, call, reference);
    dump_stack(&m, stdout);
    return 0;
}
