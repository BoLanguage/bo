#include "bo.h"
#include <inttypes.h>

int main(int argc, char **argv) {
    if (argc != 3 || (strcmp(argv[1], "bridge") && strcmp(argv[1], "reference"))) {
        fputs("usage: bridge bridge|reference BO-CODE\n", stderr);
        return 2;
    }
    Machine m;
    machine_init(&m);
    m.native = 0;
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    const char *setup = "(1 + 10 +) (BRIDGE-STEP) PUSH "
                        "(BRIDGE-STEP 100 +) (BRIDGE-OUTER) PUSH "
                        "(BRIDGE-OUTER 1000 +) (BRIDGE-GRAND) PUSH";
    if (!execute(&m, setup, strlen(setup), "bridge-setup", 1)) return 1;
    if (!strcmp(argv[1], "bridge") && !aot_bridge_install(&m)) {
        fputs("AOT bridge: unexpected definitions\n", stderr);
        return 2;
    }
    if (getenv("BO_AOT_BRIDGE_COLLECT")) gc_collect(&m);
    m.bridge_gc_each = getenv("BO_AOT_BRIDGE_GC_EACH") != NULL;
    int ok = execute(&m, argv[2], strlen(argv[2]), "bridge-workload", 1);
    dump_stack(&m, stdout);
    if (getenv("BO_AOT_BRIDGE_STATS"))
        fprintf(stderr, "BO_AOT_BRIDGE_STATS entries=%" PRIu64 " fallbacks=%" PRIu64
                " direct_calls=%" PRIu64 "\n",
                m.bridge_entries, m.bridge_fallbacks, m.bridge_direct_calls);
    return ok ? 0 : 1;
}
