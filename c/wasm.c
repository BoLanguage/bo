/* WebAssembly entry points (built with `make -C c wasm`); the command-line main.c is not used. */
#include "bo.h"

#include <emscripten.h>

#ifndef BO_VERSION
#define BO_VERSION "unknown"
#endif

extern int bo_exit_status; /* machine.c */
static Machine *machine;

EMSCRIPTEN_KEEPALIVE const char *bo_version(void) { return BO_VERSION; }

/* Creates a fresh machine. `autoload` is NULL/"" (kernel only) or the path of a module to load
   after include/core.bo, which every module needs. */
EMSCRIPTEN_KEEPALIVE int bo_init(const char *autoload) {
    machine = malloc(sizeof *machine);
    machine_init(machine);
    machine->resume_host = 1; /* step, next, continue and stop typed at a pause resume the program */
    if (!autoload || !*autoload) return 1;
    return include_file_once(machine, "include/core.bo") && include_file_once(machine, autoload);
}

/* Exit status requested by the last bo_eval/bo_include call, or -1 if the program did not exit. */
EMSCRIPTEN_KEEPALIVE int bo_exit_code(void) { return bo_exit_status; }

/* Runs top-level code; returns 0 if an uncaught error was reported. */
EMSCRIPTEN_KEEPALIVE int bo_eval(const char *code) {
    bo_exit_status = -1;
    int ok = machine->in_pause ? debug_eval(machine, code, strlen(code))
                               : execute(machine, code, strlen(code), "stdin", 1);
    fflush(NULL);
    return ok;
}

EMSCRIPTEN_KEEPALIVE int bo_include(const char *path) {
    bo_exit_status = -1;
    int ok = include_file(machine, path);
    fflush(NULL);
    return ok;
}

/* Debugger and state inspection (debugger.inc) */
void debug_mark_baseline(Machine *m);
int debug_load(Machine *m, const char *text);
int debug_step_host(Machine *m, long budget, int mode);
void debug_clear_stacks(Machine *m);
const char *debug_state_json(Machine *m, long max_items, size_t max_chars);
const char *debug_stacks_json(Machine *m, const char *filter, int include_empty);
const char *debug_stack_json(Machine *m, const char *name, long max_items, size_t max_chars);

/* Declares the stacks as they are now to be the library; later changes are "user" stacks. */
EMSCRIPTEN_KEEPALIVE void bo_mark_baseline(void) { debug_mark_baseline(machine); }

/* Loads a program for stepping (false after reporting a reading error or if one is active). */
EMSCRIPTEN_KEEPALIVE int bo_debug_load(const char *code) {
    bo_exit_status = -1;
    int ok = debug_load(machine, code);
    fflush(NULL);
    return ok;
}

/* Like bo_debug_load, but the program starts with specialized operations on, as a prompt line does:
   it can only pause at a BREAKPOINT (mode 3 below) until it is stepped. With `scratch` it is a
   prompt line: when it is over, the status is that of the program that ran before. */
EMSCRIPTEN_KEEPALIVE int bo_debug_load_fast(const char *code, int scratch) {
    bo_exit_status = -1;
    int ok = debug_begin(machine, code, DEBUG_FAST | (scratch ? DEBUG_SCRATCH : 0));
    fflush(NULL);
    return ok;
}

/* Runs up to `budget` steps (mode 0: ops; 1: lines; 2: lines and user ops; 3: none, only a
   BREAKPOINT pauses) and pauses before the next one; returns 0 idle, 1 ready, 2 paused,
   3 done, 4 error, 5 exit. */
EMSCRIPTEN_KEEPALIVE int bo_debug_step(int budget, int mode) {
    int state = debug_step_host(machine, budget, mode);
    fflush(NULL);
    return state;
}

/* Carries out the step, next, continue or stop that a line asked for while the program was paused:
   the new state as bo_debug_step returns it, or -1 if the line asked for nothing. */
EMSCRIPTEN_KEEPALIVE int bo_debug_resume(void) {
    int state = debug_resume(machine);
    fflush(NULL);
    return state;
}

EMSCRIPTEN_KEEPALIVE void bo_debug_abort(void) { debug_abort(machine); }

/* Empties the default stack and the program's stacks, restoring changed library stacks. */
EMSCRIPTEN_KEEPALIVE void bo_clear_stacks(void) { debug_clear_stacks(machine); }

EMSCRIPTEN_KEEPALIVE const char *bo_state_json(int max_items, int max_chars) {
    return debug_state_json(machine, max_items, (size_t)max_chars);
}

EMSCRIPTEN_KEEPALIVE const char *bo_stacks_json(const char *filter, int include_empty) {
    return debug_stacks_json(machine, filter, include_empty);
}

EMSCRIPTEN_KEEPALIVE const char *bo_stack_json(const char *name, int max_items, int max_chars) {
    return debug_stack_json(machine, name, max_items, (size_t)max_chars);
}
