/* Command line: bo [--version] [--bare] [--no-private] [--debug] [--dump FILE] [-e CODE]... [file...]. */
#include "bo.h"

#include <limits.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifndef BO_VERSION
#define BO_VERSION "unknown"
#define BO_DATE "unknown"
#endif

int line_read(const char *prompt, char *out, size_t size); /* lineedit.c */

static void banner(void) {
    printf("BoLang | Version %s (%s) | %s\n", BO_VERSION, BO_DATE,
           getenv("BO_NO_OP_OPTIMIZATIONS") ? "generic-ops" : "specialized-ops");
}

/* After a line paused a program: where it stands and the stack. */
static void show_state(Machine *m, int state) {
    if (state == DBG_PAUSED) {
        fputs(debug_where(m), stdout);
        fflush(stdout);
    }
}

/* Reads one entry into *buf: lines until what is typed reads completely (a list or a string may
   be open on the first one). 0 at the end of the input. */
static int read_entry(Machine *m, int tty, char **buf, size_t *len, size_t *cap) {
    char line[4096];
    *len = 0;
    for (;;) {
        if (tty) {
            if (!line_read(*len ? "  " : m->in_pause ? "@ " : "| ", line, sizeof line)) return 0;
        } else if (!fgets(line, sizeof line, stdin)) return 0;
        size_t k = strlen(line);
        if (*len + k + 1 > *cap) *buf = realloc(*buf, *cap = (*len + k + 1) * 2);
        memcpy(*buf + *len, line, k + 1);
        *len += k;
        Forms f;
        LowerErr le;
        int bad = lower_op_forms(*buf, *len, 1, 0, &f, &le);
        free(f.f);
        if (!bad || !le.incomplete) return 1;
    }
}

/* With `debug` a line runs under the step driver, so that a BREAKPOINT can pause it. The prompt
   then changes to "@ " and every line runs at the pause point until step, next, continue or
   stop (or the end of the input) leaves it. */
static void repl(Machine *m, int debug) {
    int tty = isatty(0);
    m->resume_host = debug;
    if (tty) banner();
    char *buf = NULL;
    size_t cap = 0, len = 0;
    while (read_entry(m, tty, &buf, &len, &cap)) {
        if (debug && m->in_pause) {
            debug_eval(m, buf, len);
            int state = debug_resume(m);
            if (state >= 0) show_state(m, state);
        } else if (debug) {
            if (debug_begin(m, buf, DEBUG_FAST)) show_state(m, debug_step(m, 0, STEP_RUN));
        } else {
            execute(m, buf, len, "stdin", 1);
        }
    }
    free(buf);
}

/* A program started under the debugger (`--debug` with a file or -e code): while it is paused the
   prompt runs at the pause point. The end of the input continues the program, so that it still
   runs to its end when nobody can answer. Returns whether the program ran to its end. */
static int debug_program(Machine *m, int state) {
    if (state < 0) return 0;
    int tty = isatty(0);
    char *buf = NULL;
    size_t cap = 0, len = 0;
    show_state(m, state);
    while (m->in_pause) {
        if (read_entry(m, tty, &buf, &len, &cap)) {
            debug_eval(m, buf, len);
        } else {
            fputs(tty ? "\n" : "", stdout);
            fputs("(end of input: continuing)\n", stderr);
            m->resume = RESUME_CONTINUE;
        }
        int next = debug_resume(m);
        if (next >= 0) {
            state = next;
            show_state(m, state);
        }
    }
    free(buf);
    return state == DBG_DONE;
}

/* The library home, the directory that holds include/: $BO_HOME, else the parent of the directory
   of this executable (c/bo lives in the checkout's c/), provided it has include/core.bo. */
static char *find_home(const char *argv0) {
    const char *env = getenv("BO_HOME");
    if (env && *env) return strdup(env);
    char exe[PATH_MAX];
#ifdef __APPLE__
    uint32_t size = sizeof exe;
    if (_NSGetExecutablePath(exe, &size)) return NULL;
#else
    ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n > 0) exe[n] = 0;
    else if (!realpath(argv0, exe)) return NULL;
#endif
    char resolved[PATH_MAX];
    if (!realpath(exe, resolved)) return NULL;
    for (int up = 0; up < 2; up++) {
        char *slash = strrchr(resolved, '/');
        if (!slash) return NULL;
        *slash = 0;
    }
    char core[PATH_MAX + 32];
    snprintf(core, sizeof core, "%s/include/core.bo", resolved);
    return access(core, R_OK) ? NULL : strdup(resolved);
}

int main(int argc, char **argv) {
    const char *dump = NULL;
    int bare = 0, ran = 0, ok = 1, debug = 0;
    Machine *m = malloc(sizeof *m);
    int i = 1;
    for (; i < argc; i++)
        if (strcmp(argv[i], "--version") == 0) {
            printf("BoLang %s (%s)\n", BO_VERSION, BO_DATE);
            return 0;
        }
    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-e") || !strcmp(argv[i], "--dump")) {
            i++;
        } else if (!strcmp(argv[i], "--bare")) {
            bare = 1;
        } else if (!strcmp(argv[i], "--debug")) {
            debug = 1;
        } else if (!strcmp(argv[i], "--no-private")) {
        } else if (!strncmp(argv[i], "--", 2) && argv[i][2]) {
            fprintf(stderr, "Unknown option '%s' (expected --bare, --no-private, --debug, --dump FILE, -e CODE or --version)\n", argv[i]);
            return 2;
        }
    }
    machine_init(m);
    m->resume_host = debug;
    m->home = find_home(argv[0]);
    for (i = 1; i < argc; i++)
        if (strcmp(argv[i], "--no-private") == 0) m->private_ops = 0;
    if (!bare) {
        char *core = NULL;
        if (m->home) {
            core = malloc(strlen(m->home) + sizeof "/include/core.bo");
            sprintf(core, "%s/include/core.bo", m->home);
        }
        int loaded = include_file(m, core ? core : "include/core.bo");
        free(core);
        if (!loaded) return 1;
    }
    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "--bare") == 0 ||
            strcmp(argv[i], "--debug") == 0)
            continue;
        if (strcmp(argv[i], "--no-private") == 0) continue;
        if (strcmp(argv[i], "--dump") == 0 && i + 1 < argc) {
            dump = argv[++i];
        } else if (strcmp(argv[i], "-e") == 0 && i + 1 < argc) {
            const char *code = argv[++i];
            if (debug) ok = debug_program(m, debug_start_text(m, code, !ran)) && ok;
            else ok = execute(m, code, strlen(code), "stdin", 1) && ok;
            ran = 1;
        } else {
            if (debug) ok = debug_program(m, debug_start_file(m, argv[i], !ran)) && ok;
            else ok = include_file(m, argv[i]) && ok;
            ran = 1;
        }
    }
    if (!ran) repl(m, debug || isatty(0));
    fflush(stdout);
    if (dump) {
        FILE *f = fopen(dump, "w");
        if (f) {
            dump_stack(m, f);
            fclose(f);
        }
    }
    return ok ? 0 : 1;
}
