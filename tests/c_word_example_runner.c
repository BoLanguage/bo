#include "bo.h"

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    Machine m;
    machine_init(&m);
    return include_file(&m, argv[1]) && include_file(&m, argv[2]) ? 0 : 1;
}
