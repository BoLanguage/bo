#include "bo.h"
#include <inttypes.h>

int main(int argc, char **argv) {
    if ((argc != 3 && argc != 4) || (strcmp(argv[1], "linked") &&
#ifdef BO_LINKED_FRAGMENTS
                      strcmp(argv[1], "fragments") &&
#endif
                      strcmp(argv[1], "reference") &&
                      strcmp(argv[1], "native"))) {
        fputs("usage: linked linked|reference|native BO-CODE [BO-CODE-AFTER-GC]\n", stderr);
        return 2;
    }
    Machine m;
    machine_init(&m);
    if (strcmp(argv[1], "native")) m.native = 0;
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    m.linked_enabled = !strcmp(argv[1], "linked");
#ifdef BO_LINKED_FRAGMENTS
    m.linked_fragments_enabled = !strcmp(argv[1], "fragments");
    m.linked_enabled |= m.linked_fragments_enabled;
#endif
    m.linked_stats_enabled = getenv("BO_LINKED_STATS") != NULL;
    linked_count_enabled = m.linked_stats_enabled;
    m.linked_gc_each = getenv("BO_LINKED_GC_EACH") != NULL;
    const char *trace = getenv("BO_LINKED_TRACE");
    if (trace) m.linked_trace_word = from_word(as_list(str_list(trace)));
    int ok = execute(&m, argv[2], strlen(argv[2]), "linked-workload", 1);
    if (ok && argc == 4) {
        gc_collect(&m);
        ok = execute(&m, argv[3], strlen(argv[3]), "linked-workload", 1);
    }
    dump_stack(&m, stdout);
    if (m.linked_stats_enabled)
        fprintf(stderr, "BO_LINKED_STATS entries=%" PRIu64 " operations=%" PRIu64
                " copies=%" PRIu64 " reused_entries=%" PRIu64 " trace=%" PRIu64 " scheduler=%" PRIu64
                " list_bytes=%zu op_bytes=%zu header_bytes=%zu\n",
                m.linked_entries, m.linked_operations, linked_copy_count, m.linked_reused_entries,
                m.linked_trace_operations, m.linked_scheduler_visits,
                sizeof(List), sizeof(LinkedOp), sizeof(LinkedCode));
#ifdef BO_LINKED_FRAGMENTS
    if (m.linked_stats_enabled)
        fprintf(stderr, "BO_FRAGMENT_STATS entries=%" PRIu64 " resumes=%" PRIu64
                " yields=%" PRIu64 " operations=%" PRIu64 " fallbacks=%" PRIu64
                " trace=%" PRIu64 "\n", m.linked_fragment_entries, m.linked_fragment_resumes,
                m.linked_fragment_yields, m.linked_fragment_operations,
                m.linked_fragment_fallbacks, m.linked_fragment_trace);
#endif
    return ok ? 0 : 1;
}
