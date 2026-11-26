#include "bo.h"
#include <assert.h>

static Val wu(const char *name) { return list_of1(from_word(as_list(str_list(name)))); }

static void run(Machine *m, const char *code) {
    assert(execute(m, code, strlen(code), "test", 1));
}

static void check_equal(Machine *m, Val a, Val b, int equal) {
    for (int i = 0; i < 120; i++) {
        m->data.items[0] = a;
        m->data.items[1] = b;
        m->data.len = 2;
        run(m, "WORD-EQ");
        assert(m->data.len == 3 && as_num(m->data.items[2]) == equal);
        m->data.len = 2;
        run(m, "WORD-NE");
        assert(m->data.len == 3 && as_num(m->data.items[2]) == !equal);
    }
}

static Code *direct_word_code(Machine *m, const char *name) {
    Val key = list_of1(from_word(as_list(str_list(name))));
    for (size_t i = 0; i < m->tcap; i++) {
        for (Stack *s = m->table[i]; s; s = s->chain) {
            if (val_equal(s->key, key) && s->len && is_list(s->items[s->len - 1]))
                return as_list(s->items[s->len - 1])->code;
        }
    }
    return NULL;
}

static void check_units(Val word) {
    Val items[] = {from_num(42), list_of2(from_num(1), from_num(2)), word};
    Val empty = list_from(NULL, 0), rest, unit, combined, element;
    int type;
    for (int i = 0; i < 3; i++) {
        unit = list_of1(items[i]);
        assert(unit_type(unit, &type) == UNIT_OK && type == i);
        for (int right = 0; right < 2; right++) {
            Val original[] = {items[i], from_num(3), from_num(4)};
            if (right) {
                original[0] = from_num(3);
                original[1] = from_num(4);
                original[2] = items[i];
            }
            Val list = list_from(original, 3);
            assert(unit_uncons(list, right, &rest, &unit) == UNIT_OK);
            assert(unit_element(unit, &element) == UNIT_OK && val_equal(element, items[i]));
            assert(unit_cons(rest, unit, right, &combined) == UNIT_OK);
            assert(val_equal(combined, list));
        }
    }
    assert(unit_element(empty, &element) == UNIT_TYPE_ERROR);
    assert(unit_type(list_of2(from_num(1), from_num(2)), &type) == UNIT_TYPE_ERROR);
    assert(unit_cons(empty, empty, 0, &combined) == UNIT_TYPE_ERROR);
    assert(unit_cons(from_num(1), list_of1(from_num(2)), 0, &combined) == UNIT_TYPE_ERROR);
    assert(unit_uncons(empty, 0, &rest, &unit) == UNIT_STACK_ERROR);
    assert(unit_uncons(from_num(1), 0, &rest, &unit) == UNIT_TYPE_ERROR);
}

static void check_word_conversions(void) {
    const char *names[] = {"OP", "op", "+", "@", "$", "DOTTED.NAME",
                           "π", "😀", "١٢٣", "１２３", "1١", "١.2", "1e٢"};
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        Val text = str_list(names[i]), unit, result;
        assert(text_to_word(text, &unit) == WORD_OK);
        assert(as_list(unit)->len == 1 && is_word(as_list(unit)->items[0]));
        assert(word_to_text(unit, &result) == WORD_OK && val_equal(text, result));
        Val another;
        assert(text_to_word(result, &another) == WORD_OK && val_equal(unit, another));
    }
    const char *invalid[] = {"", "a b", "a\nb", "(OP)", "\"OP\"", "123",
                             "1.5", "1e999", "\xc2\xa0", "\xe2\x80\xa8"};
    for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
        Val unit;
        assert(text_to_word(str_list(invalid[i]), &unit) == WORD_REPRESENTATION_ERROR);
    }
    Val unit, text;
    Val invalid_codepoints[] = {from_num(0), from_num(-1), from_num(0x110000), from_num(0xd800)};
    for (size_t i = 0; i < sizeof invalid_codepoints / sizeof invalid_codepoints[0]; i++)
        assert(text_to_word(list_of1(invalid_codepoints[i]), &unit) == WORD_REPRESENTATION_ERROR);
    assert(text_to_word(from_num(1), &unit) == WORD_TYPE_ERROR);
    assert(text_to_word(list_of1(from_num(1.5)), &unit) == WORD_TYPE_ERROR);
    assert(text_to_word(list_of1(list_of1(from_num(65))), &unit) == WORD_TYPE_ERROR);
    assert(word_to_text(list_of1(from_num(1)), &text) == WORD_TYPE_ERROR);
    assert(word_to_text(list_from(NULL, 0), &text) == WORD_TYPE_ERROR);
    assert(word_to_text(list_of2(from_num(1), from_num(2)), &text) == WORD_TYPE_ERROR);
    assert(word_to_text(list_of1(from_word(as_list(str_list("a b")))), &text)
           == WORD_REPRESENTATION_ERROR);
}

static void check_word_render(Machine *m) {
    m->data.items = realloc(m->data.items, sizeof(Val));
    assert(m->data.items);
    m->data.cap = 1;
    m->data.items[0] = from_word(as_list(str_list("@")));
    m->data.len = 1;
    FILE *output = tmpfile();
    assert(output);
    dump_stack(m, output);
    rewind(output);
    char rendered[8];
    assert(fgets(rendered, sizeof rendered, output));
    assert(!strcmp(rendered, "@\n"));
    assert(!fclose(output));
    m->data.len = 0;
}

static void check_default_wrappers(Machine *m) {
    static const struct { const char *name, *primitive; } wrappers[] = {
        {"snapshot", "SNAPSHOT"}, {"depth", "DEPTH"}, {"clear", "CLEAR"}, {"lock", "LOCK"},
        {"unlock", "UNLOCK"}, {"drop", "DROP"}, {"pick", "PICK"}, {"roll", "ROLL"},
        {"unit", "UNIT"},
        {"consl", "CONSL"}, {"consr", "CONSR"}, {"unconsl", "UNCONSL"},
        {"unconsr", "UNCONSR"}, {"type", "TYPE"}, {"ratio", "RATIO"},
        {"apply", "APPLY"}, {"ifte", "IFTE"}, {"+", "ADD"}, {"-", "SUB"},
        {"*", "MUL"}, {"/", "DIV"}, {"//", "IDIV"}, {"^", "POW"}, {"=", "EQUAL"},
        {".", "BROADCAST"}, {"..", "REDUCE"}, {"::", "RANGE"},
        {"open", "OPEN"}, {"close", "CLOSE"}, {"read", "READ"}, {"write", "WRITE"},
        {"catch", "CATCH"}, {"call", "CALL"}, {"throw", "THROW"}, {"rethrow", "RETHROW"},
        {"exit", "EXIT"}, {"abort", "ABORT"},
        {"@", "BREAKPOINT"}, {"step", "STEP"}, {"next", "NEXT"}, {"continue", "CONTINUE"},
        {"stop", "STOP"}, {"backtrace", "BACKTRACE"},
        {"unittype", "UNITTYPE"}, {"word", "WORD"}, {"text", "TEXT"},
        {"included", "INCLUDED"},
        {"array", "ARRAY"}, {"shape", "SHAPE"}, {"rank", "RANK"},
        {"reshape", "RESHAPE"}, {"->", "FETCH"}, {"<-", "STORE"},
        {"chunk", "CHUNK"}, {"concat", "CONCAT"}, {"dot", "DOT"},
        {"mean", "MEAN"}, {"median", "MEDIAN"}, {"transpose", "TRANSPOSE"},
        {"outer", "OUTER"}, {"matmul", "MATMUL"},
    };
    assert(!m->data.len);
    gc_collect(m);
    for (size_t i = 0; i < sizeof wrappers / sizeof wrappers[0]; i++) {
        Val word = from_word(as_list(str_list(wrappers[i].name)));
        Val primitive = from_word(as_list(str_list(wrappers[i].primitive)));
        Val key = list_of1(word);
        Val expected = list_of2(list_from(NULL, 0), primitive);
        Stack *found = NULL;
        for (size_t j = 0; j < m->tcap; j++)
            for (Stack *s = m->table[j]; s; s = s->chain)
                if (val_equal(s->key, key)) found = s;
        assert(found && !found->locked && found->len == 1);
        assert(val_equal(found->items[0], expected));
    }
    run(m, "1 2 + 9 0.5 ^");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 3 && as_num(m->data.items[1]) == 3);
    m->data.len = 0;
}

static void check_no_initial_wrappers(Machine *m) {
    static const char *names[] = {
        "snapshot", "depth", "clear", "lock", "unlock", "drop", "pick", "roll",
        "unit", "consl", "consr", "unconsl", "unconsr", "type", "ratio",
        "apply", "ifte", "+", "-", "*", "/", "//", "^", "=", ".", "..",
        "open", "close", "read", "write", "catch", "call",
        "throw", "rethrow", "exit", "abort", "@", "step", "next", "continue", "stop", "backtrace",
        "unittype", "word", "text",
        "include", "included", "require", "array", "shape", "rank", "reshape", "->",
        "<-", ":", "::",
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        Val word = from_word(as_list(str_list(names[i])));
        Stack *found = NULL;
        Val key = list_of1(word);
        for (size_t j = 0; j < m->tcap; j++)
            for (Stack *s = m->table[j]; s; s = s->chain)
                if (val_equal(s->key, key)) found = s;
        assert(!found || !found->len);
    }
}

static void check_word_lowering(void) {
    const char *source = "\n(OP 1 2) \"OP\" OP word text ١٢٣";
    Forms forms;
    LowerErr error;
    assert(!lower_word_forms(source, strlen(source), 1, 0, &forms, &error));
    assert(forms.n == 6);
    for (size_t i = 0; i < forms.n; i++) assert(forms.f[i].line == 2);
    Val op_unit, word_unit, text_unit, unicode_unit;
    assert(text_to_word(str_list("OP"), &op_unit) == WORD_OK);
    assert(text_to_word(str_list("word"), &word_unit) == WORD_OK);
    assert(text_to_word(str_list("text"), &text_unit) == WORD_OK);
    assert(text_to_word(str_list("١٢٣"), &unicode_unit) == WORD_OK);
    Val elements[] = {as_list(op_unit)->items[0], from_num(1), from_num(2)};
    assert(val_equal(forms.f[0].list, list_of1(list_from(elements, 3))));
    assert(val_equal(forms.f[1].list, list_of1(str_list("OP"))));
    assert(val_equal(forms.f[2].list, op_unit));
    assert(val_equal(forms.f[3].list, word_unit));
    assert(val_equal(forms.f[4].list, text_unit));
    assert(val_equal(forms.f[5].list, unicode_unit));
    free(forms.f);
    /* in a file (owner 3) a `__` word is private: unequal to the plain word, and `text` then `word` cannot bring it back */
    const char *private_source = "__a __a a";
    assert(!lower_word_forms(private_source, strlen(private_source), 1, 3, &forms, &error));
    Val first = as_list(forms.f[0].list)->items[0], second = as_list(forms.f[1].list)->items[0];
    Val plain = as_list(forms.f[2].list)->items[0], back, text, again;
    assert(as_word(first)->owner == 3 && as_word(plain)->owner == 0);
    assert(val_equal(list_of1(first), list_of1(second)) && !val_equal(list_of1(first), list_of1(plain)));
    assert(val_hash(first) != val_hash(from_word(as_list(str_list("__a")))));
    assert(word_to_text(list_of1(first), &text) == WORD_OK && text_to_word(text, &again) == WORD_OK);
    back = as_list(again)->items[0];
    assert(as_word(back)->owner == 0 && !val_equal(back, first));
    free(forms.f);
    assert(!lower_word_forms(private_source, strlen(private_source), 1, 0, &forms, &error));
    assert(as_word(as_list(forms.f[0].list)->items[0])->owner == 0);
    free(forms.f);
    const char nul[] = {'\0'};
    assert(lower_word_forms(nul, sizeof nul, 1, 0, &forms, &error));
    free(forms.f);
    assert(lower_word_forms("1e999", 5, 1, 0, &forms, &error));
    free(forms.f);
}

static void run_words(Machine *m, const char *source) {
    Forms forms;
    LowerErr error;
    assert(!lower_word_forms(source, strlen(source), 1, 0, &forms, &error));
    Val *items = malloc(forms.n * sizeof *items);
    assert(items || !forms.n);
    for (size_t i = 0; i < forms.n; i++) {
        List *form = as_list(forms.f[i].list);
        assert(form->len == 1);
        items[i] = form->items[0];
    }
    Val program = list_from(items, (uint32_t)forms.n);
    free(items);
    free(forms.f);
    machine_run(m, program);
}

static void assert_compiled_word(Machine *m, const char *name) {
    Code *code = direct_word_code(m, name);
    assert(code);
}

static void check_initial_specializations(Machine *m) {
    static const struct { const char *source, *name; int hot; double result; } cases[] = {
        {"(1 2 drop) (CHECK-DROP) PUSH CHECK-DROP", "CHECK-DROP", H_DROP, 1},
        {"(6 2 +) (CHECK-ADD) PUSH CHECK-ADD", "CHECK-ADD", H_ADD, 8},
        {"(6 2 -) (CHECK-SUB) PUSH CHECK-SUB", "CHECK-SUB", H_SUB, 4},
        {"(6 2 *) (CHECK-MUL) PUSH CHECK-MUL", "CHECK-MUL", H_MUL, 12},
        {"(7 2 /) (CHECK-DIV) PUSH CHECK-DIV", "CHECK-DIV", H_DIV, 3.5},
        {"(7 2 //) (CHECK-IDIV) PUSH CHECK-IDIV", "CHECK-IDIV", H_IDIV, 3},
        {"(6 6 =) (CHECK-EQU) PUSH CHECK-EQU", "CHECK-EQU", H_EQ, 1},
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        run(m, cases[i].source);
        assert(m->data.len == 1 && as_num(m->data.items[0]) == cases[i].result);
        m->data.len = 0;
        Code *code = direct_word_code(m, cases[i].name);
        assert(code);
        int matches = 0;
        for (int j = 0; j < code->n; j++)
            matches += code->ops[j].kind == OP_SPECIALIZED && code->ops[j].hot == cases[i].hot;
        assert(matches == !!m->optimize_ops);
    }
}

static void check_literal_stack_specializations(Machine *m) {
    static const struct { const char *word; int hot; } cases[] = {
        {"pick", H_PICKK}, {"roll", H_ROLLK},
    };
    const int indexes[] = {0, 63, 64};
    if (m->data.cap < 65) {
        m->data.items = realloc(m->data.items, 65 * sizeof(Val));
        assert(m->data.items);
        m->data.cap = 65;
    }
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        for (size_t j = 0; j < sizeof indexes / sizeof indexes[0]; j++) {
            char source[128], name[64];
            assert(snprintf(name, sizeof name, "CHECK-%s-%d", cases[i].word, indexes[j])
                   < (int)sizeof name);
            assert(snprintf(source, sizeof source, "(%d %s) (%s) PUSH",
                            indexes[j], cases[i].word, name) < (int)sizeof source);
            m->data.len = 0;
            run(m, source);
            for (int k = 0; k < 65; k++) m->data.items[k] = from_num(k);
            m->data.len = 65;
            run(m, name);
            assert(m->data.len == (cases[i].hot == H_PICKK ? 66 : 65));
            assert(as_num(m->data.items[m->data.len - 1]) == 64 - indexes[j]);
            Code *code = direct_word_code(m, name);
            assert(code);
            int matches = 0;
            for (int k = 0; k < code->n; k++)
                matches += code->ops[k].kind == OP_SPECIALIZED && code->ops[k].hot == cases[i].hot;
            assert(matches == (m->optimize_ops && indexes[j] < 64));
            m->data.len = 0;
        }
    }
}

static void check_selected_stack_invalidation(const char *directory, const char *default_path,
                                              const char *core_path) {
    Machine m;
    machine_init(&m);
    assert(include_file(&m, core_path));
    assert(include_file(&m, default_path));
    static const char *const names[] = {
        "drop", "pick", "roll", "ifte", "+", "-", "*", "/", "//", "=",
        "DROP", "PICK", "ROLL", "ADD", "SUB", "MUL", "DIV", "IDIV", "EQUAL", "IFTE",
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        char source[128];
        assert(snprintf(source, sizeof source, "(%s) UNLOCK", names[i]) < (int)sizeof source);
        run(&m, source);
        uint64_t before = m.epoch;
        assert(snprintf(source, sizeof source, "0 (%s) PUSH", names[i]) < (int)sizeof source);
        run(&m, source);
        assert(m.epoch > before);
        before = m.epoch;
        assert(snprintf(source, sizeof source, "(%s) POP drop", names[i]) < (int)sizeof source);
        run(&m, source);
        assert(m.epoch > before && !m.data.len);
    }

    uint64_t before = m.epoch;
    run(&m, "1 (WORK) PUSH (WORK) DEPTH drop (WORK) CLEAR "
            "1 (pick-EXTRA) PUSH (pick-EXTRA) CLEAR");
    assert(m.epoch == before && !m.data.len);
    run(&m, "0 \"pick\" word PUSH");
    assert(m.epoch > before);
    run(&m, "(pick) POP drop");

    run(&m, "(0 1 (pick) PUSH 0 pick) (TEST-SELECT-PICK) PUSH 42 TEST-SELECT-PICK");
    assert(m.data.len == 4 && as_num(m.data.items[0]) == 42 &&
           as_num(m.data.items[1]) == 0 && as_num(m.data.items[2]) == 0 &&
           as_num(m.data.items[3]) == 1);
    m.data.len = 0;
    run(&m, "(pick) POP drop "
            "(1 (ifte) PUSH (1) (11) (22) ifte) (TEST-SELECT-IFTE) PUSH TEST-SELECT-IFTE");
    assert(m.data.len == 4 && as_num(m.data.items[3]) == 1);
    for (int i = 0; i < 3; i++)
        assert(val_equal(m.data.items[i], list_of1(from_num(i == 0 ? 1 : i == 1 ? 11 : 22))));
    m.data.len = 0;
    run(&m, "(ifte) POP drop "
            "(0 (IFTE) PUSH (1) (11) (22) () IFTE) (TEST-SELECT-PRIM-IFTE) PUSH "
            "TEST-SELECT-PRIM-IFTE");
    assert(m.data.len == 5 && as_num(m.data.items[4]) == 0);
    assert(is_list(m.data.items[3]) && !as_list(m.data.items[3])->len);
    m.data.len = 0;
    run(&m, "(IFTE) POP drop (0 (ADD) PUSH 2 3 +) (TEST-SELECT-ADD) PUSH TEST-SELECT-ADD");
    assert(m.data.len == 4 && as_num(m.data.items[0]) == 2 &&
           as_num(m.data.items[1]) == 3 && is_list(m.data.items[2]) &&
           !as_list(m.data.items[2])->len && as_num(m.data.items[3]) == 0);
    m.data.len = 0;
    run(&m, "(ADD) POP drop");

    run(&m, "((pick) CLEAR 0 pick) (TEST-SELECT-CLR) PUSH (TEST-SELECT-CLR) () catch");
    assert(m.data.len == 2 && as_num(m.data.items[0]) == 0 && is_list(m.data.items[1]));
    List *error = as_list(m.data.items[1]);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    m.data.len = 0;
    run(&m, "(() PICK) (pick) PUSH");

    run(&m, "((pick) LOCK (pick) CLEAR) () catch");
    assert(m.data.len == 1 && is_list(m.data.items[0]));
    error = as_list(m.data.items[0]);
    assert(val_equal(error->items[0], wu("Permission-Error")));
    assert(val_equal(error->items[1], wu("CLEAR")));
    m.data.len = 0;
    run(&m, "(pick) UNLOCK ((pick) ADD) () catch");
    assert(m.data.len == 1 && is_list(m.data.items[0]));
    error = as_list(m.data.items[0]);
    assert(val_equal(error->items[0], wu("Stack-Error")));
    assert(val_equal(error->items[1], wu("ADD")));
    m.data.len = 0;
    run(&m, "42 0 pick");
    assert(m.data.len == 2 && as_num(m.data.items[0]) == 42 && as_num(m.data.items[1]) == 42);
    m.data.len = 0;

    char path[1024], source[4096];
    assert(snprintf(path, sizeof path, "%s/selected-invalidation.bo", directory) < (int)sizeof path);
    FILE *f = fopen(path, "w");
    assert(f && fputs("(0 pick) (TEST-NESTED-PICK) PUSH TEST-NESTED-PICK 7\n", f) >= 0);
    assert(!fclose(f));
    assert(snprintf(source, sizeof source,
                    "(() PICK) \"%s\" (pick) PUSH (pick) INCLUDE 42 TEST-NESTED-PICK",
                    path) < (int)sizeof source);
    run(&m, source);
    assert(m.data.len == 4 && val_equal(m.data.items[0],
           list_of2(list_from(NULL, 0), from_word(as_list(str_list("PICK"))))));
    assert(as_num(m.data.items[1]) == 42 && as_num(m.data.items[2]) == 0 &&
           as_num(m.data.items[3]) == 7);
    assert(!remove(path));
}

static void check_warmed_redefinition(Machine *m) {
    m->data.len = 0;
    run(m, "(1) (OPT-VALUE) PUSH () (OPT-MUTATE) PUSH "
           "(OPT-VALUE OPT-MUTATE OPT-VALUE) (OPT-CALL) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "OPT-CALL");
        assert(m->data.len == 2 && as_num(m->data.items[0]) == 1
               && as_num(m->data.items[1]) == 1);
        m->data.len = 0;
    }
    assert_compiled_word(m, "OPT-CALL");
    Code *caller = direct_word_code(m, "OPT-CALL");
    run(m, "((2) (OPT-VALUE) PUSH) (OPT-MUTATE) PUSH OPT-CALL");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 1
           && as_num(m->data.items[1]) == 2);
    m->data.len = 0;
    run(m, "(OPT-MUTATE) POP drop OPT-CALL");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 2
           && as_num(m->data.items[1]) == 2);
    m->data.len = 0;
    run(m, "(OPT-VALUE) POP drop OPT-CALL");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 1
           && as_num(m->data.items[1]) == 1);
    m->data.len = 0;
    gc_collect(m);
    assert(direct_word_code(m, "OPT-CALL") == caller);
    run(m, "9 (OPT-VALUE) PUSH OPT-CALL");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 9
           && as_num(m->data.items[1]) == 9);
    m->data.len = 0;
    run(m, "(OPT-VALUE) POP drop (OPT-VALUE) POP drop (OPT-CALL) () catch");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    assert(val_equal(as_list(m->data.items[0])->items[0], wu("Existence-Error")));
    m->data.len = 0;
}

static void check_warmed_control_redefinition(Machine *m) {
    m->data.len = 0;
    run(m, "(1) (11) (22) () IFTE (0) (11) (22) () IFTE");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 11
           && as_num(m->data.items[1]) == 22);
    m->data.len = 0;
    run(m, "(1) (OPT-WORK) PUSH (11) (OPT-WORK) PUSH "
           "(22) (OPT-WORK) PUSH (OPT-WORK) IFTE");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;
    run(m, "((1) (11) (22) IFTE) () catch");
    assert(m->data.len == 4 && is_list(m->data.items[3]));
    assert(val_equal(m->data.items[0], list_of1(from_num(1))));
    assert(val_equal(m->data.items[1], list_of1(from_num(11))));
    assert(val_equal(m->data.items[2], list_of1(from_num(22))));
    assert(val_equal(as_list(m->data.items[3])->items[0], wu("Type-Error")));
    m->data.len = 0;
    run(m, "() (OPT-BRANCH-TOGGLE) PUSH "
           "(0 1 + drop OPT-BRANCH-TOGGLE (1) (11) (22) () IFTE) (OPT-BRANCH) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "OPT-BRANCH");
        assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
        m->data.len = 0;
    }
    assert_compiled_word(m, "OPT-BRANCH");
    Code *code = direct_word_code(m, "OPT-BRANCH");
    for (int i = 0; i < code->n; i++) assert(code->ops[i].kind != OP_IFTE_GUARD);
    run(m, "((IFTE) UNLOCK (99) (IFTE) PUSH) (OPT-BRANCH-TOGGLE) PUSH OPT-BRANCH");
    assert(m->data.len == 5);
    for (int i = 0; i < 3; i++) {
        assert(is_list(m->data.items[i]) && as_list(m->data.items[i])->len == 1);
        assert(as_num(as_list(m->data.items[i])->items[0]) == (i == 0 ? 1 : i == 1 ? 11 : 22));
    }
    assert(is_list(m->data.items[3]) && !as_list(m->data.items[3])->len);
    assert(as_num(m->data.items[4]) == 99);
    m->data.len = 0;
    run(m, "(IFTE) POP drop (OPT-BRANCH-TOGGLE) POP drop OPT-BRANCH");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;
}

static void check_warmed_wrapper_ifte(Machine *m) {
    m->data.len = 0;
    run(m, "() (WIFTE-TOGGLE) PUSH "
           "(0 1 + drop WIFTE-TOGGLE (1) (11) (22) ifte) (WIFTE-CALL) PUSH "
           "((0) (11) (22) ifte) (WIFTE-FALSE) PUSH "
           "((() (11) (22) ifte) () catch) (WIFTE-EMPTY) PUSH "
           "(((\"bad\") (11) (22) ifte) () catch) (WIFTE-TYPE) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "WIFTE-CALL WIFTE-FALSE");
        assert(m->data.len == 2 && as_num(m->data.items[0]) == 11
               && as_num(m->data.items[1]) == 22);
        m->data.len = 0;
    }
    Code *code = direct_word_code(m, "WIFTE-CALL");
    assert(code);
    int guards = 0;
    for (int i = 0; i < code->n; i++) guards += code->ops[i].kind == OP_IFTE_GUARD;
    assert(guards == (m->optimize_ops ? 1 : 0));
    gc_collect(m);

    run(m, "WIFTE-EMPTY");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    List *error = as_list(m->data.items[0]);
    assert(val_equal(error->items[0], wu("Stack-Error")));
    assert(val_equal(error->items[1], wu("IFTE")));
    m->data.len = 0;
    run(m, "WIFTE-TYPE");
    assert(m->data.len == 2 && val_equal(m->data.items[0], str_list("bad")));
    error = as_list(m->data.items[1]);
    assert(val_equal(error->items[0], wu("Type-Error")));
    assert(val_equal(error->items[1], wu("IFTE")));
    assert(val_equal(error->items[2], list_of1(str_list("bad"))));
    m->data.len = 0;

    run(m, "((99) (ifte) PUSH) (WIFTE-TOGGLE) PUSH WIFTE-CALL");
    assert(m->data.len == 4 && as_num(m->data.items[3]) == 99);
    assert(val_equal(m->data.items[0], list_of1(from_num(1))));
    assert(val_equal(m->data.items[1], list_of1(from_num(11))));
    assert(val_equal(m->data.items[2], list_of1(from_num(22))));
    m->data.len = 0;
    run(m, "(ifte) POP drop (WIFTE-TOGGLE) POP drop "
           "((IFTE) UNLOCK (99) (IFTE) PUSH) (WIFTE-TOGGLE) PUSH WIFTE-CALL");
    assert(m->data.len == 5 && as_num(m->data.items[4]) == 99);
    assert(val_equal(m->data.items[0], list_of1(from_num(1))));
    assert(val_equal(m->data.items[1], list_of1(from_num(11))));
    assert(val_equal(m->data.items[2], list_of1(from_num(22))));
    assert(is_list(m->data.items[3]) && !as_list(m->data.items[3])->len);
    m->data.len = 0;
    run(m, "(IFTE) POP drop (WIFTE-TOGGLE) POP drop WIFTE-CALL");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;

    run(m, "((() PICK) (pick) PUSH) (WIFTE-TOGGLE) PUSH WIFTE-CALL");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;
    run(m, "(pick) POP drop (WIFTE-TOGGLE) POP drop "
           "(((99) (ifte) PUSH 1) (11) (22) ifte) (WIFTE-CONDITION) PUSH "
           "WIFTE-CONDITION");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;
    run(m, "(ifte) POP drop");

    run(m, "((ifte) POP drop) (WIFTE-TOGGLE) PUSH (WIFTE-CALL) () catch");
    assert(m->data.len == 4);
    assert(val_equal(m->data.items[0], list_of1(from_num(1))));
    assert(val_equal(m->data.items[1], list_of1(from_num(11))));
    assert(val_equal(m->data.items[2], list_of1(from_num(22))));
    error = as_list(m->data.items[3]);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    assert(val_equal(error->items[2],
                     list_of1(list_of1(from_word(as_list(str_list("ifte")))))));
    m->data.len = 0;
    run(m, "(() IFTE) (ifte) PUSH (WIFTE-TOGGLE) POP drop WIFTE-CALL");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;

    run(m, "(99) (ifte) PUSH ((1) (11) (22) ifte) (WIFTE-REPLACED) PUSH "
           "WIFTE-REPLACED");
    assert(m->data.len == 4 && as_num(m->data.items[3]) == 99);
    code = direct_word_code(m, "WIFTE-REPLACED");
    assert(code);
    for (int i = 0; i < code->n; i++) assert(code->ops[i].kind != OP_IFTE_GUARD);
    m->data.len = 0;
    run(m, "(ifte) POP drop WIFTE-REPLACED");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 11);
    m->data.len = 0;

    run(m, "(((1) (0) (1) ifte) (11) (22) ifte) (WIFTE-NESTED) PUSH WIFTE-NESTED");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 22);
    code = direct_word_code(m, "WIFTE-NESTED");
    assert(code);
    guards = 0;
    for (int i = 0; i < code->n; i++) guards += code->ops[i].kind == OP_IFTE_GUARD;
    assert(guards == (m->optimize_ops ? 2 : 0));
    m->data.len = 0;
}

static void check_warmed_apply_selectors(Machine *m) {
    m->data.len = 0;
    run(m, "(3) (OPT-APPLY-NAMED) PUSH (OPT-APPLY-NAMED) (OPT-KEY) PUSH "
           "((OPT-KEY) POP dup (OPT-KEY) PUSH) (OPT-GET-KEY) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "OPT-GET-KEY () APPLY");
        assert(m->data.len == 1 && as_num(m->data.items[0]) == 3);
        m->data.len = 0;
    }
    run(m, "(OPT-GET-KEY APPLY 0 1 + drop) (OPT-APPLY-CALL) PUSH "
           "(() APPLY 0 1 + drop) (OPT-DEFAULT-APPLY) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "(7) OPT-GET-KEY PUSH OPT-APPLY-CALL (8) OPT-DEFAULT-APPLY");
        assert(m->data.len == 2 && as_num(m->data.items[0]) == 7
               && as_num(m->data.items[1]) == 8);
        m->data.len = 0;
    }
    assert_compiled_word(m, "OPT-APPLY-CALL");
    assert_compiled_word(m, "OPT-DEFAULT-APPLY");
    run(m, "OPT-GET-KEY OPT-DEFAULT-APPLY ((4 5)) OPT-DEFAULT-APPLY");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 3);
    assert(val_equal(m->data.items[1], list_of2(from_num(4), from_num(5))));
    m->data.len = 0;
    run(m, "(77) (OPT-APPLY-WORD) PUSH (OPT-APPLY-WORD) OPT-DEFAULT-APPLY "
           "() OPT-DEFAULT-APPLY");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 77);
    m->data.len = 0;
    run(m, "(8 OPT-DEFAULT-APPLY) () catch");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 8);
    assert(val_equal(as_list(m->data.items[1])->items[0], wu("Type-Error")));
    m->data.len = 0;

    run(m, "() (OPT-APPLY-TOGGLE) PUSH "
           "(OPT-APPLY-TOGGLE (7) () APPLY 0 1 + drop) (OPT-APPLY-HOT) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "OPT-APPLY-HOT");
        assert(m->data.len == 1 && as_num(m->data.items[0]) == 7);
        m->data.len = 0;
    }
    assert_compiled_word(m, "OPT-APPLY-HOT");
    run(m, "((APPLY) UNLOCK (99) (APPLY) PUSH) (OPT-APPLY-TOGGLE) PUSH OPT-APPLY-HOT");
    assert(m->data.len == 3 && val_equal(m->data.items[0], list_of1(from_num(7))));
    assert(is_list(m->data.items[1]) && !as_list(m->data.items[1])->len);
    assert(as_num(m->data.items[2]) == 99);
    m->data.len = 0;
    run(m, "(APPLY) POP drop (OPT-APPLY-TOGGLE) POP drop OPT-APPLY-HOT");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 7);
    m->data.len = 0;
}

static void check_warmed_primitive_redefinition(Machine *m) {
    m->data.len = 0;
    run(m, "() (OPT-TOGGLE) PUSH "
           "(0 1 + drop OPT-TOGGLE \"x\" drop 7) (OPT-PRIM-CALL) PUSH");
    for (int i = 0; i < 120; i++) {
        run(m, "OPT-PRIM-CALL");
        assert(m->data.len == 1 && as_num(m->data.items[0]) == 7);
        m->data.len = 0;
    }
    assert_compiled_word(m, "OPT-PRIM-CALL");
    run(m, "((DROP) UNLOCK (99) (DROP) PUSH) (OPT-TOGGLE) PUSH OPT-PRIM-CALL");
    assert(m->data.len == 4 && val_equal(m->data.items[0], str_list("x")));
    assert(is_list(m->data.items[1]) && !as_list(m->data.items[1])->len);
    assert(as_num(m->data.items[2]) == 99 && as_num(m->data.items[3]) == 7);
    m->data.len = 0;
    run(m, "(DROP) POP drop (OPT-TOGGLE) POP drop OPT-PRIM-CALL");
    assert(m->data.len == 1 && as_num(m->data.items[0]) == 7);
    m->data.len = 0;
}

static void check_word_execution(Machine *m) {
    m->data.len = 0;
    run_words(m, "(OP 2 3) unconsl consl (1 2 OP) unconsr consr");
    Val word = from_word(as_list(str_list("OP")));
    Val left[] = {word, from_num(2), from_num(3)};
    Val right[] = {from_num(1), from_num(2), word};
    assert(m->data.len == 2);
    assert(val_equal(m->data.items[0], list_from(left, 3)));
    assert(val_equal(m->data.items[1], list_from(right, 3)));
    m->data.len = 0;
    run_words(m, "\"OP\" word text (42) unittype ((1 2)) unittype (OP) unittype");
    assert(m->data.len == 4 && val_equal(m->data.items[0], str_list("OP")));
    for (int i = 0; i < 3; i++) assert(as_num(m->data.items[i + 1]) == i);
    m->data.len = 0;
    run_words(m, "(17) (OP) PUSH \"OP\" word apply 1 2 \"+\" word apply");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 17 && as_num(m->data.items[1]) == 3);
    m->data.len = 0;
    run_words(m, "(\"a b\" word) () catch");
    assert(m->data.len == 2 && val_equal(m->data.items[0], str_list("a b")));
    assert(val_equal(as_list(m->data.items[1])->items[0], wu("Representation-Error")));
    m->data.len = 0;
    run_words(m, "(NOT-DEFINED) () catch");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    List *error = as_list(m->data.items[0]);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    Val unknown = from_word(as_list(str_list("NOT-DEFINED")));
    assert(val_equal(error->items[2], list_of1(list_of1(unknown))));
    m->data.len = 0;
    run_words(m, "((DROP) UNLOCK (99) (DROP) PUSH \"x\" drop 7) (TEST) PUSH TEST");
    assert(m->data.len == 4 && val_equal(m->data.items[0], str_list("x")));
    assert(is_list(m->data.items[1]) && !as_list(m->data.items[1])->len);
    assert(as_num(m->data.items[2]) == 99 && as_num(m->data.items[3]) == 7);
    m->data.len = 0;
    run_words(m, "(DROP) POP drop");
    assert(!m->data.len);
    run_words(m, "((PICK) UNLOCK (99) (PICK) PUSH 8 0 pick) (PICKCHECK) PUSH PICKCHECK");
    assert(m->data.len == 4 && as_num(m->data.items[0]) == 8);
    assert(as_num(m->data.items[1]) == 0);
    assert(is_list(m->data.items[2]) && !as_list(m->data.items[2])->len);
    assert(as_num(m->data.items[3]) == 99);
    m->data.len = 0;
    run_words(m, "(PICK) POP drop");
    run_words(m, "((ROLL) UNLOCK (99) (ROLL) PUSH 8 0 roll) (ROLLCHECK) PUSH ROLLCHECK");
    assert(m->data.len == 4 && as_num(m->data.items[0]) == 8);
    assert(as_num(m->data.items[1]) == 0);
    assert(is_list(m->data.items[2]) && !as_list(m->data.items[2])->len);
    assert(as_num(m->data.items[3]) == 99);
    m->data.len = 0;
    run_words(m, "(ROLL) POP drop (0 pick) () catch");
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 0);
    assert(val_equal(as_list(m->data.items[1])->items[0], wu("Stack-Error")));
    m->data.len = 0;
    Val plus = from_word(as_list(str_list("+")));
    Val ops[] = {from_num(0), from_num(1), plus, from_num(1), plus};
    Val program = list_from(ops, 5);
    assert(m->nroots < m->roots_cap);
    m->roots[m->nroots++] = program;
    for (int i = 0; i < 120; i++) {
        m->data.len = 0;
        machine_run(m, program);
        assert(m->data.len == 1 && as_num(m->data.items[0]) == 2);
    }
    assert(as_list(program)->code);
    int adds = 0;
    for (int i = 0; i < as_list(program)->code->n; i++)
        adds += as_list(program)->code->ops[i].kind == OP_SPECIALIZED &&
                as_list(program)->code->ops[i].hot == H_ADD;
    assert(adds == (m->optimize_ops ? 2 : 0));
    m->nroots--;
    m->data.len = 0;
    run_words(m, "1 dup");
    Code *dup_code = direct_word_code(m, "dup");
    int picks = 0;
    for (int i = 0; dup_code && i < dup_code->n; i++)
        picks += dup_code->ops[i].kind == OP_SPECIALIZED &&
                 dup_code->ops[i].hot == H_PICKK;
    assert((picks != 0) == !!m->optimize_ops);
    assert(m->data.len == 2 && as_num(m->data.items[0]) == 1 && as_num(m->data.items[1]) == 1);
    m->data.len = 0;
}

static void check_error_locations(Machine *m) {
    m->data.len = 0;
    run_words(m, "(1 2 ADD) () catch");
    assert(m->data.len == 3 && as_num(m->data.items[0]) == 1 &&
           as_num(m->data.items[1]) == 2 && is_list(m->data.items[2]));
    List *error = as_list(m->data.items[2]);
    assert(val_equal(error->items[0], wu("Type-Error")));
    assert(val_equal(error->items[1], wu("ADD")));

    m->data.len = 0;
    run_words(m, "(IFTE) () catch");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    error = as_list(m->data.items[0]);
    assert(val_equal(error->items[0], wu("Stack-Error")));
    assert(val_equal(error->items[1], wu("IFTE")));

    m->data.len = 0;
    run_words(m, "(WORD) () catch");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    error = as_list(m->data.items[0]);
    assert(val_equal(error->items[0], wu("Stack-Error")));
    assert(val_equal(error->items[1], wu("WORD")));

    m->data.len = 0;
    run_words(m, "(NOT-DEFINED) () catch");
    assert(m->data.len == 1 && is_list(m->data.items[0]));
    error = as_list(m->data.items[0]);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    m->data.len = 0;
}

static void check_unit_callbacks(Machine *m) {
    m->data.len = 0;
    run_words(m,
        "(OP 2 3) () map (1 2 3) (apply 1 + unit) map "
        "(1 2 3) 0 (apply +) foldl (1 2 3) 0 (swap apply swap -) foldr "
        "(OP A) () (swap consl) foldr (1 OP 3) 2 nth (OP) (1 OP 2) in");
    Val word = from_word(as_list(str_list("OP")));
    Val a = from_word(as_list(str_list("A")));
    Val first[] = {word, from_num(2), from_num(3)};
    Val second[] = {from_num(2), from_num(3), from_num(4)};
    assert(m->data.len == 7);
    assert(val_equal(m->data.items[0], list_from(first, 3)));
    assert(val_equal(m->data.items[1], list_from(second, 3)));
    assert(as_num(m->data.items[2]) == 6);
    assert(as_num(m->data.items[3]) == 2);
    assert(val_equal(m->data.items[4], list_of2(word, a)));
    assert(val_equal(m->data.items[5], list_of1(word)));
    assert(as_num(m->data.items[6]) == 1);
    m->data.len = 0;
    run_words(m, "((1) (apply 1 +) map) () catch");
    assert(m->data.len && is_list(m->data.items[m->data.len - 1]));
    assert(val_equal(as_list(m->data.items[m->data.len - 1])->items[0],
                     wu("Type-Error")));
    m->data.len = 0;
}

static void check_standard_library_operations(Machine *m) {
    run_words(m, "5 unit (A B) unit 0 (dup 5 <) (1 +) loop "
                 "5 ((dup 0 =) (drop 1) (dup 1 - rec *) ifte) lambda "
                 "() 0 (dup 3 =) (1 +) unfoldl "
                 "() 0 (dup 3 =) (1 +) unfoldr");
    Val a = from_word(as_list(str_list("A")));
    Val b = from_word(as_list(str_list("B")));
    Val left[] = {from_num(3), from_num(2), from_num(1)};
    Val right[] = {from_num(1), from_num(2), from_num(3)};
    assert(m->data.len == 6);
    assert(val_equal(m->data.items[0], list_of1(from_num(5))));
    assert(val_equal(m->data.items[1], list_of1(list_of2(a, b))));
    assert(as_num(m->data.items[2]) == 5 && as_num(m->data.items[3]) == 120);
    assert(val_equal(m->data.items[4], list_from(left, 3)));
    assert(val_equal(m->data.items[5], list_from(right, 3)));
    m->data.len = 0;

    FILE *input = tmpfile(), *output = tmpfile();
    assert(input && output);
    assert(fputs("Hi!", input) >= 0);
    rewind(input);
    Stream saved_in = m->streams[0], saved_out = m->streams[1];
    m->streams[0] = (Stream){input, 0};
    m->streams[1] = (Stream){output, 0};
    run_words(m, "\"hi!\" emits 3 0 gets "
                 "(99) (SIDE) PUSH ((SIDE) emits) () catch "
                 "((SIDE) 1 puts) () catch");
    assert(m->data.len >= 3 && val_equal(m->data.items[0], str_list("Hi!")));
    int errors = 0;
    for (size_t i = 1; i < m->data.len; i++) {
        Val v = m->data.items[i];
        if (is_list(v) && as_list(v)->len &&
            val_equal(as_list(v)->items[0], wu("Type-Error"))) errors++;
        assert(!is_num(v) || as_num(v) != 99);
    }
    assert(errors == 2);
    m->data.len = 0;
    run_words(m, "(99) (OP) PUSH (OP \"OP\" (OP) (+ word text π) (1 (2 3) ()) -5 2.5) "
                 "emit nl (OP (1 +) \"OP\" word text) emit nl "
                 "(OP (1 +) \"OP\") ps");
    assert(m->data.len == 1);
    fflush(output);
    rewind(output);
    char buffer[256] = {0};
    size_t count = fread(buffer, 1, sizeof buffer - 1, output);
    assert(!ferror(output));
    buffer[count] = '\0';
    assert(!strcmp(buffer, "hi!(OP (79 80) (OP) (+ word text π) (1 (2 3) ()) -5 2.5)\n"
                           "(OP (1 +) (79 80) word text)\n"
                           "  0: (OP (1 +) (79 80))\n"));
    m->streams[0] = saved_in;
    m->streams[1] = saved_out;
    assert(!fclose(input) && !fclose(output));
    m->data.len = 0;
}

static void check_word_source(const char *standard_library, const char *directory,
                              const char *core_path) {
    Machine m;
    machine_init(&m);
    assert(include_file(&m, core_path));
    assert(include_file(&m, standard_library));
    const char *program = "() (EXCEPTION) PUSH\nMISSING";
    assert(execute(&m, program, strlen(program), "sample.bo", 7));
    assert(m.data.len == 1 && is_list(m.data.items[0]));
    List *error = as_list(m.data.items[0]);
    Val missing = from_word(as_list(str_list("MISSING")));
    assert(error->len == 5);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    assert(val_equal(error->items[2], list_of1(list_of1(missing))));
    assert(val_equal(error->items[3], str_list("sample.bo")));
    assert(as_num(error->items[4]) == 8);
    m.data.len = 0;
    run(&m, "(drop 99) (EXCEPTION) PUSH 1 0 / 100");
    assert(m.data.len == 4 && as_num(m.data.items[0]) == 1);
    assert(as_num(m.data.items[1]) == 0 && as_num(m.data.items[2]) == 99);
    assert(as_num(m.data.items[3]) == 100);
    m.data.len = 0;
    run(&m, "(MISSING) (drop 42) catch 100");
    assert(m.data.len == 2 && as_num(m.data.items[0]) == 42 && as_num(m.data.items[1]) == 100);
    m.data.len = 0;
    run(&m, "(MISSING) (OTHER-MISSING) catch");
    assert(m.data.len == 2 && as_num(m.data.items[1]) == 99);
    m.data.len = 0;
    program = "1 )";
    assert(!execute(&m, program, strlen(program), "bad.bo", 7));
    assert(m.data.len == 1 && as_num(m.data.items[0]) == 99);
    assert(!strcmp(m.source, "stdin") && m.line == 1 && !m.ctl_len);
    m.data.len = 0;
    program = "(OTHER-MISSING) (EXCEPTION) PUSH MISSING";
    assert(!execute(&m, program, strlen(program), "handler.bo", 1));
    assert(m.data.len == 1 && is_list(m.data.items[0]));
    error = as_list(m.data.items[0]);
    assert(val_equal(error->items[2], list_of1(list_of1(missing))));
    m.data.len = 0;
    run(&m, "(EXCEPTION) POP drop");
    run(&m, "(EXCEPTION) POP drop");

    char inner[1024], outer[1024], bad[1024], source[4096];
    assert(snprintf(inner, sizeof inner, "%s/inner.bo", directory) < (int)sizeof inner);
    assert(snprintf(outer, sizeof outer, "%s/outer.bo", directory) < (int)sizeof outer);
    assert(snprintf(bad, sizeof bad, "%s/bad.bo", directory) < (int)sizeof bad);
    FILE *f = fopen(inner, "w");
    assert(f && fputs("(1 +) (SUCC) PUSH\n\nMISSING\n", f) >= 0 && !fclose(f));
    f = fopen(outer, "w");
    assert(f && fprintf(f, "\"%s\" include\n2 SUCC\n", inner) > 0 && !fclose(f));
    f = fopen(bad, "w");
    assert(f && fputs("\n(1\n", f) >= 0 && !fclose(f));
    assert(snprintf(source, sizeof source, "\"%s\" include", outer) < (int)sizeof source);
    run(&m, source);
    assert(m.data.len == 2 && is_list(m.data.items[0]));
    error = as_list(m.data.items[0]);
    assert(val_equal(error->items[0], wu("Existence-Error")));
    assert(val_equal(error->items[1], wu("WORD")));
    assert(val_equal(error->items[2], list_of1(list_of1(missing))));
    assert(val_equal(error->items[3], str_list(inner)));
    assert(as_num(error->items[4]) == 3 && as_num(m.data.items[1]) == 3);
    m.data.len = 0;
    assert(snprintf(source, sizeof source, "\"%s\" included \"%s\" included",
                    outer, inner) < (int)sizeof source);
    run(&m, source);
    assert(m.data.len == 2 && as_num(m.data.items[0]) == 1 && as_num(m.data.items[1]) == 1);
    m.data.len = 0;
    assert(snprintf(source, sizeof source, "(\"%s\" include) () catch", bad)
           < (int)sizeof source);
    run(&m, source);
    assert(is_list(m.data.items[m.data.len - 1]));
    error = as_list(m.data.items[m.data.len - 1]);
    assert(val_equal(error->items[0], wu("Syntax-Error")));
    assert(val_equal(error->items[1], wu("INCLUDE")));
    List *data = as_list(error->items[2]);
    assert(data->len == 2 && as_num(data->items[1]) == 2);
    m.data.len = 0;
    run(&m, "\"examples/lib.bo\" require "
            "1 4 range 3 3 range 5 2 range -2 1 range");
    Val positive[] = {from_num(1), from_num(2), from_num(3)};
    Val negative[] = {from_num(-2), from_num(-1), from_num(0)};
    assert(m.data.len == 4);
    assert(val_equal(m.data.items[0], list_from(positive, 3)));
    assert(val_equal(m.data.items[1], list_from(NULL, 0)));
    assert(val_equal(m.data.items[2], list_from(NULL, 0)));
    assert(val_equal(m.data.items[3], list_from(negative, 3)));
}

int main(int argc, char **argv) {
    assert(argc == 4);
    check_selected_stack_invalidation(argv[2], argv[1], argv[3]);
    check_word_source(argv[1], argv[2], argv[3]);
    Machine m;
    machine_init(&m);
    check_no_initial_wrappers(&m);
    assert(include_file(&m, argv[3]));
    check_default_wrappers(&m);
    assert(include_file(&m, argv[1]));
    check_initial_specializations(&m);
    check_literal_stack_specializations(&m);
    run(&m, "(99) (+) PUSH (^) POP drop");
    run(&m, "(^) () catch");
    assert(m.data.len == 1 && is_list(m.data.items[0]));
    assert(val_equal(as_list(m.data.items[0])->items[0], wu("Existence-Error")));
    assert(val_equal(as_list(m.data.items[0])->items[2],
                     list_of1(list_of1(from_word(as_list(str_list("^")))))));
    m.data.len = 0;
    run(&m, "(() POW) (^) PUSH");
    run(&m, "+ (+) POP 1 2 +");
    assert(m.data.len == 3 && as_num(m.data.items[0]) == 99);
    assert(val_equal(m.data.items[1], list_of1(from_num(99))));
    assert(as_num(m.data.items[2]) == 3);
    m.data.len = 0;
    run(&m, "(over over =) (WORD-EQ) PUSH (over over \\=) (WORD-NE) PUSH "
            "(1 + 1 +) (WORD-ADD) PUSH");

    Val a = from_word(as_list(str_list("OP")));
    Val b = from_word(as_list(str_list("OP")));
    Val c = from_word(as_list(str_list("op")));
    Val text = str_list("OP");
    assert(is_word(a) && !is_list(a) && !is_num(a));
    assert(a != b && val_equal(a, b) && val_hash(a) == val_hash(b));
    assert(!val_equal(a, c) && !val_equal(a, text));
    assert(val_equal(list_of1(a), list_of1(b)));
    assert(val_hash(list_of1(a)) == val_hash(list_of1(b)));
    assert(!val_equal(list_of1(a), list_of1(c)));
    assert(m.nroots + 4 <= m.roots_cap);
    m.roots[m.nroots++] = a;
    m.roots[m.nroots++] = b;
    m.roots[m.nroots++] = c;
    m.roots[m.nroots++] = text;
    check_word_render(&m);
    check_units(a);
    check_word_conversions();
    check_word_lowering();
    check_word_execution(&m);
    check_error_locations(&m);
    check_warmed_redefinition(&m);
    check_warmed_primitive_redefinition(&m);
    check_warmed_control_redefinition(&m);
    check_warmed_wrapper_ifte(&m);
    check_warmed_apply_selectors(&m);
    check_unit_callbacks(&m);
    check_standard_library_operations(&m);

    m.data.cap = 16;
    m.data.items = realloc(m.data.items, m.data.cap * sizeof(Val));
    assert(m.data.items);
    m.data.items[0] = list_of1(a);
    m.data.items[1] = list_of1(b);
    m.data.items[2] = list_of1(c);
    m.data.items[3] = text;
    m.data.len = 4;
    m.nroots -= 4;
    gc_collect(&m);
    for (int i = 0; i < 10000; i++) (void)str_list("garbage");
    gc_collect(&m);
    a = as_list(m.data.items[0])->items[0];
    b = as_list(m.data.items[1])->items[0];
    c = as_list(m.data.items[2])->items[0];
    text = m.data.items[3];
    assert(val_equal(a, b) && !val_equal(a, c));
    assert(val_equal(from_list(as_word(a)), text));

    /* Each test uses distinct name allocations, including after code compilation. */
    check_equal(&m, a, b, 1);
    check_equal(&m, a, c, 0);
    check_equal(&m, a, text, 0);
    check_equal(&m, text, a, 0);
    for (int i = 0; i < 120; i++) {
        m.data.len = 1;
        m.data.items[0] = from_num(1);
        run(&m, "WORD-ADD");
        assert(m.data.len == 1 && as_num(m.data.items[0]) == 3);
    }
    m.data.len = 1;
    m.data.items[0] = a;
    run(&m, "(WORD-ADD) () catch");
    assert(m.data.len == 3 && m.data.items[0] == a && as_num(m.data.items[1]) == 1);
    assert(is_list(m.data.items[2]));
    assert(val_equal(as_list(m.data.items[2])->items[0], wu("Type-Error")));
    return 0;
}
