#include "bo.h"
#include <assert.h>

static void run(Machine *m, const char *code) {
    assert(execute(m, code, strlen(code), "selected-stacks", 1));
}

int main(void) {
    Machine m;
    machine_init(&m);

    run(&m, "1 2 () ADD");
    assert(m.data.len == 1 && as_num(m.data.items[0]) == 3);
    m.data.len = 0;

    run(&m, "7 (WORK) PUSH 8 (WORK) PUSH (WORK) ADD (WORK) POP");
    assert(m.data.len == 1 && as_num(m.data.items[0]) == 15);
    m.data.len = 0;

    run(&m, "9 0.5 () POW");
    assert(m.data.len == 1 && as_num(m.data.items[0]) == 3);
    m.data.len = 0;

    run(&m, "(0 -1 () POW) () () CATCH");
    assert(m.data.len == 3 && is_list(m.data.items[2]));
    m.data.len = 0;

    run(&m, "7 (WORK) PUSH (WORK) TOP (WORK) POP");
    assert(m.data.len == 2 && as_num(m.data.items[0]) == 7 && as_num(m.data.items[1]) == 7);
    m.data.len = 0;

    run(&m, "() EXISTS (MISSING) EXISTS (ADD) EXISTS");
    assert(m.data.len == 3 && as_num(m.data.items[0]) == 1 && as_num(m.data.items[1]) == 0 &&
           as_num(m.data.items[2]) == 1);
    return 0;
}
