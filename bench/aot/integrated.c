/* Experimental runtime integration for the preassembled (1 +) quotation. */
#include "bo.h"

int main(int argc, char **argv) {
    if (argc != 3 || (strcmp(argv[1], "aot") && strcmp(argv[1], "reference") &&
                      strcmp(argv[1], "native"))) {
        fputs("usage: integrated aot|reference|native BO-CODE\n", stderr);
        return 2;
    }
    Machine m;
    machine_init(&m);
    /* Native JIT calls bypass enter(), so this experiment uses the operation interpreter. */
    if (strcmp(argv[1], "native")) m.native = 0;
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    const char *definition = "(1 +) (STEP) PUSH";
    if (!execute(&m, definition, strlen(definition), "aot-setup", 1)) return 1;
    if (!strcmp(argv[1], "aot") && !aot_install_step(&m)) {
        fputs("AOT experiment: expected STEP=(1 +) and +=(() ADD)\n", stderr);
        return 2;
    }
    if (getenv("BO_AOT_COLLECT")) gc_collect(&m);
    int ok = execute(&m, argv[2], strlen(argv[2]), "aot-workload", 1);
    dump_stack(&m, stdout);
    if (getenv("BO_AOT_STATS"))
        fprintf(stderr, "BO_AOT_STATS step_entries=%llu plus_entries=%llu\n",
                (unsigned long long)m.aot_step_entries,
                (unsigned long long)m.aot_plus_entries);
    return ok ? 0 : 1;
}
