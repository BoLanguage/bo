#include "bo.h"
#include <errno.h>
#include <time.h>

int main(int argc, char **argv) {
    if ((argc != 3 && argc != 4) ||
        (strcmp(argv[1], "arithmetic") && strcmp(argv[1], "branches")) ||
        (argc == 4 && strcmp(argv[3], "--time"))) {
        fputs("usage: native-heavy arithmetic|branches ITERATIONS [--time]\n", stderr);
        return 2;
    }
    errno = 0;
    char *end;
    unsigned long count = strtoul(argv[2], &end, 10);
    if (errno || !*argv[2] || *end || !count || argv[2][0] == '-') {
        fputs("iterations must be a positive integer\n", stderr);
        return 2;
    }
    Machine m;
    machine_init(&m);
    if (!include_file(&m, "include/core.bo") || !include_file(&m, "include/std.bo")) return 1;
    int branches = !strcmp(argv[1], "branches");
    const size_t size = 100;
    List *list = list_new((uint32_t)(branches ? size * 5 : size * 2 + 1));
    if (branches) {
        Val truth = list_of1(from_num(1));
        Val yes = list_of1(from_num(1));
        Val no = list_of1(from_num(0));
        Val empty = list_from(NULL, 0);
        Val ifte = from_word(as_list(str_list("IFTE")));
        for (size_t i = 0; i < size; i++) {
            list->items[5 * i] = truth;
            list->items[5 * i + 1] = yes;
            list->items[5 * i + 2] = no;
            list->items[5 * i + 3] = empty;
            list->items[5 * i + 4] = ifte;
        }
    } else {
        Val plus = from_word(as_list(str_list("+")));
        list->items[0] = from_num(0);
        for (size_t i = 0; i < size; i++) {
            list->items[2 * i + 1] = from_num(1);
            list->items[2 * i + 2] = plus;
        }
    }
    Val program = from_list(list);
    if (m.nroots == m.roots_cap) {
        size_t capacity = m.roots_cap ? m.roots_cap * 2 : 64;
        Val *roots = realloc(m.roots, capacity * sizeof *roots);
        if (!roots) { fputs("cannot allocate roots\n", stderr); return 2; }
        m.roots = roots;
        m.roots_cap = capacity;
    }
    m.roots[m.nroots++] = program;
    struct timespec start, end_time;
    if (argc == 4 && clock_gettime(CLOCK_MONOTONIC, &start)) {
        perror("clock_gettime");
        return 2;
    }
    for (unsigned long i = 0; i < count; i++) {
        m.data.len = 0;
        machine_run(&m, program);
        if (m.data.len != (branches ? size : 1)) {
            fprintf(stderr, "incorrect result on iteration %lu\n", i);
            return 1;
        }
        for (size_t j = 0; j < m.data.len; j++)
            if (!is_num(m.data.items[j]) ||
                as_num(m.data.items[j]) != (branches ? 1.0 : (double)size)) {
                fprintf(stderr, "incorrect value on iteration %lu\n", i);
                return 1;
            }
    }
    if (argc == 4 && clock_gettime(CLOCK_MONOTONIC, &end_time)) {
        perror("clock_gettime");
        return 2;
    }
    printf("%zu\n", size);
    if (argc == 4) {
        double seconds = (double)(end_time.tv_sec - start.tv_sec) +
                         (double)(end_time.tv_nsec - start.tv_nsec) / 1e9;
        printf("%.9f\n", seconds);
    }
    if (m.jit_stats_enabled) dump_jit_stats(&m, stderr);
    return 0;
}
