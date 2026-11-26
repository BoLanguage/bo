/* A bounded, optimistic direct-call model, not a general Bo runtime. */
#include "bo.h"
#include <errno.h>

typedef struct {
    Machine *m;
    Stack *step, *plus, *add, *push, *pop;
    Val step_definition, plus_definition, alt_definition, selector;
    Val step_call, plus_call, add_call, bound_alt;
    size_t dynamic, fallback_count;
    int stats;
} Model;

void model_step(Model *model);
void model_plus(Model *model);
void model_alt(Model *model);
void model_loop(Model *model, size_t limit, size_t rebind);

static void fail(const char *message) {
    fprintf(stderr, "AOT model: %s\n", message);
    exit(2);
}

static void push(Model *model, Val value) {
    Stack *stack = &model->m->data;
    if (stack->len == stack->cap) {
        size_t cap = stack->cap ? stack->cap * 2 : 16;
        if (cap < stack->cap || cap > SIZE_MAX / sizeof(Val)) fail("stack capacity overflow");
        Val *items = realloc(stack->items, cap * sizeof(Val));
        if (!items) fail("cannot grow data stack");
        stack->items = items;
        stack->cap = cap;
    }
    stack->items[stack->len++] = value;
}

static void primitive(Model *model, Stack *stack) {
    if (aot_model_primitive(model->m, stack)) fail("primitive failed");
}

static Val top(Stack *stack) {
    if (!stack || !stack->len) fail("unsupported empty named stack");
    return stack->items[stack->len - 1];
}

static void check_definitions(Model *model) {
    Val plus_word = from_word(as_list(str_list("+")));
    Val add_word = from_word(as_list(str_list("ADD")));
    if (!is_list(model->step_definition) || !is_list(model->plus_definition) ||
        !is_list(model->alt_definition)) fail("expected quotation definitions");
    List *step = as_list(model->step_definition);
    List *plus = as_list(model->plus_definition);
    List *alt = as_list(model->alt_definition);
    if (step->len != 2 || step->items[0] != from_num(1) ||
        !val_equal(step->items[1], plus_word) ||
        plus->len != 2 || !is_list(plus->items[0]) || as_list(plus->items[0])->len ||
        !val_equal(plus->items[1], add_word) ||
        alt->len != 5 || !is_list(alt->items[0]) || as_list(alt->items[0])->len ||
        !val_equal(alt->items[1], add_word) || alt->items[2] != from_num(1) ||
        !is_list(alt->items[3]) || as_list(alt->items[3])->len ||
        !val_equal(alt->items[4], add_word))
        fail("unexpected quotation definition");
    model->selector = plus->items[0];
}

void model_push_one(Model *model) { push(model, from_num(1)); }
void model_push_selector(Model *model) { push(model, model->selector); }

static void fallback(Model *model, Val call) {
    if (model->stats) model->fallback_count++;
    machine_run(model->m, call);
}

void model_call_add(Model *model) {
    if (model->add && !model->add->len && model->add->native)
        primitive(model, model->add);
    else fallback(model, model->add_call);
}

void model_call_plus(Model *model) {
    if (!model->plus || !model->plus->len) {
        fallback(model, model->plus_call);
        return;
    }
    Val definition = top(model->plus);
    if (definition == model->plus_definition) model_plus(model);
    else if (definition == model->alt_definition) model_alt(model);
    else fallback(model, model->plus_call);
}

void model_call_step(Model *model) {
    if (model->step && model->step->len && top(model->step) == model->step_definition)
        model_step(model);
    else fallback(model, model->step_call);
}

void model_bind_alt(Model *model) {
    if (model->dynamic) {
        List *alt = as_list(model->alt_definition);
        model->bound_alt = list_from(alt->items, alt->len);
    } else {
        model->bound_alt = model->alt_definition;
    }
    push(model, model->bound_alt);
    push(model, model->plus->key);
    primitive(model, model->push);
}

void model_unbind_alt(Model *model) {
    push(model, model->plus->key);
    primitive(model, model->pop);
    if (!model->m->data.len || model->m->data.items[model->m->data.len - 1] != model->bound_alt)
        fail("unexpected POP result");
    model->m->data.len--;
}

int model_continue(Model *model, size_t limit) {
    Stack *stack = &model->m->data;
    if (!stack->len || !is_num(stack->items[stack->len - 1]))
        fail("loop expects a number");
    return as_num(stack->items[stack->len - 1]) < (double)limit;
}

static void run(Machine *m, const char *source) {
    if (!execute(m, source, strlen(source), "aot-model", 1)) exit(1);
}

static size_t iterations(const char *text) {
    char *end;
    errno = 0;
    unsigned long count = strtoul(text, &end, 10);
    if (errno || !*text || *text == '-' || *end || !count || count > 10000000)
        fail("iterations must be between 1 and 10000000");
    return (size_t)count;
}

typedef struct { const char *name, *setup, *program; } Probe;
static const Probe probes[] = {
    {"number", "42 (+) PUSH 0", "42 (+) PUSH 0 STEP"},
    {"empty", "() (+) PUSH 0", "() (+) PUSH 0 STEP"},
    {"step", "(2 +) (STEP) PUSH 0", "(2 +) (STEP) PUSH 0 STEP"},
    {"add", "(ADD) UNLOCK (99) (ADD) PUSH 0", "(ADD) UNLOCK (99) (ADD) PUSH 0 STEP"},
    {"missing", "(+) CLEAR 0", "(+) CLEAR 0 STEP"},
};

int main(int argc, char **argv) {
    const Probe *probe = NULL;
    if (argc == 4) {
        for (size_t i = 0; i < sizeof probes / sizeof probes[0]; i++)
            if (!strcmp(argv[2], probes[i].name)) probe = &probes[i];
    }
    if (argc != 4 || (strcmp(argv[1], "model") && strcmp(argv[1], "reference") &&
                      strcmp(argv[1], "native")) ||
        (!probe && strcmp(argv[2], "calls") && strcmp(argv[2], "rebind") && strcmp(argv[2], "dynamic"))) {
        fputs("usage: model model|reference|native calls|rebind|dynamic|number|empty|step|add|missing ITERATIONS\n", stderr);
        return 2;
    }
    size_t count = iterations(argv[3]);
    if (probe && count != 1) fail("probe iterations must be 1");
    int dynamic = !strcmp(argv[2], "dynamic");
    int rebind = strcmp(argv[2], "calls") != 0;
    Machine m;
    machine_init(&m);
    if (strcmp(argv[1], "native")) m.native = 0;
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    run(&m, "(1 +) (STEP) PUSH (() ADD 1 () ADD) (AOT-MODEL-ALT) PUSH");
    if (strcmp(argv[1], "model") && probe) {
        run(&m, probe->program);
    } else if (strcmp(argv[1], "model")) {
        char source[256];
        const char *format = dynamic ?
            "0 (dup %zu <) (STEP (() ADD 1 () ADD) unconsl consl (+) PUSH STEP (+) POP drop) loop" :
            rebind ?
            "0 (dup %zu <) (STEP (() ADD 1 () ADD) (+) PUSH STEP (+) POP drop) loop" :
            "0 (dup %zu <) (STEP) loop";
        int written = snprintf(source, sizeof source, format, count * (rebind ? 3 : 1));
        if (written < 0 || (size_t)written >= sizeof source) fail("workload too long");
        run(&m, source);
    } else {
        Model model = {.m = &m};
        model.step = aot_model_lookup(&m, "STEP");
        model.plus = aot_model_lookup(&m, "+");
        model.add = aot_model_lookup(&m, "ADD");
        model.push = aot_model_lookup(&m, "PUSH");
        model.pop = aot_model_lookup(&m, "POP");
        model.step_definition = top(model.step);
        model.plus_definition = top(model.plus);
        model.alt_definition = top(aot_model_lookup(&m, "AOT-MODEL-ALT"));
        check_definitions(&model);
        model.dynamic = dynamic;
        model.stats = getenv("BO_AOT_MODEL_STATS") != NULL;
        model.step_call = list_of1(as_list(model.step->key)->items[0]);
        model.plus_call = list_of1(as_list(model.plus->key)->items[0]);
        model.add_call = list_of1(as_list(model.add->key)->items[0]);
        m.roots = realloc(m.roots, (m.nroots + 3) * sizeof(Val));
        if (!m.roots) fail("cannot allocate GC roots");
        m.roots_cap = m.nroots + 3;
        m.roots[m.nroots++] = model.step_call;
        m.roots[m.nroots++] = model.plus_call;
        m.roots[m.nroots++] = model.add_call;
        if (probe) {
            run(&m, probe->setup);
            m.source = "aot-model-probe";
            m.line = 1;
            model_call_step(&model);
        } else {
            push(&model, from_num(0));
            model_loop(&model, count * (rebind ? 3 : 1), rebind);
            if (top(model.plus) != model.plus_definition) fail("+ was not restored");
        }
        if (model.stats)
            fprintf(stderr, "BO_AOT_MODEL_STATS fallbacks=%zu\n", model.fallback_count);
    }
    dump_stack(&m, stdout);
    return 0;
}
