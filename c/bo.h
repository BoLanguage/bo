/* Bo runtime: values, heap, lowering and machine (see README). */
#ifndef BO_H
#define BO_H

#include <math.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Values are doubles or tagged pointers. Lists and ops use distinct
   negative-NaN pointer tags. */
typedef uint64_t Val;

#define LIST_TAG 0xFFFC000000000000ULL
#define OP_TAG 0xFFFD000000000000ULL
#define TAG_MASK 0xFFFF000000000000ULL
#define INT_LIMIT 9007199254740992.0 /* 2^53 */

typedef struct Code Code;
typedef struct List {
    struct List *next; /* all-objects chain for the sweeper */
    Code *code;        /* compiled form, built lazily on first execution */
    struct List *base; /* storage owner when this list is a view, else NULL */
    Val *items;        /* the elements: inline for an owner, inside the owner for a view */
    uint32_t len;
    uint32_t hash;     /* structural hash, 0 = not computed */
    uint32_t used;     /* owner only: slots filled; a list ending there may grow in place */
    uint32_t cap;      /* owner only: slots available */
    uint8_t mark;
    uint32_t owner;    /* an op's name: the source file that owns this private op, 0 if it is public;
                          a list read from a source file: that file (the stepper skips library code) */
    Val inl[];
} List;

static inline int is_list(Val v) { return (v & TAG_MASK) == LIST_TAG; }
static inline int is_op(Val v) { return (v & TAG_MASK) == OP_TAG; }
static inline int is_num(Val v) { return !is_list(v) && !is_op(v); }
static inline List *as_list(Val v) { return (List *)(uintptr_t)(v & ~TAG_MASK); }
static inline Val from_list(List *l) { return LIST_TAG | (uint64_t)(uintptr_t)l; }
static inline List *as_op(Val v) { return (List *)(uintptr_t)(v & ~TAG_MASK); }
static inline Val from_op(List *name) { return OP_TAG | (uint64_t)(uintptr_t)name; }
static inline double as_num(Val v) { double d; memcpy(&d, &v, 8); return d; }
static inline Val from_num(double d) {
    Val v;
    if (d == 0) d = 0; /* no negative zero */
    memcpy(&v, &d, 8);
    return v;
}
static inline int num_is_int(double d) { return d == floor(d) && fabs(d) <= INT_LIMIT; }
static inline int is_int(Val v) { return is_num(v) && num_is_int(as_num(v)); }

/* heap.c */
List *list_new(uint32_t len);
Val list_from(const Val *items, uint32_t len);
Val list_slice(List *l, uint32_t off, uint32_t len);
Val list_append(List *l, Val x);
Val list_of1(Val a);
Val list_of2(Val a, Val b);
Val str_list(const char *utf8);
uint32_t val_hash(Val v);
int val_equal(Val a, Val b);


/* Unit-based list operations used by the forthcoming op value model. */
enum { UNIT_OK, UNIT_TYPE_ERROR, UNIT_STACK_ERROR };
int unit_element(Val unit, Val *element);
int unit_type(Val unit, int *type);
int unit_cons(Val list, Val unit, int right, Val *out);
int unit_uncons(Val list, int right, Val *rest, Val *unit);
enum { NAME_OK, NAME_TYPE_ERROR, NAME_REPRESENTATION_ERROR };
int name_to_selector(Val text, Val *selector);
int selector_to_name(Val selector, Val *text);

/* stacks and machine */
typedef struct Machine Machine;
typedef struct Native {
    const char *name;
    int arity;
    int transfer; /* PUSH and POP move values between the default and named stacks. */
    int (*fn)(Machine *, Val *);
} Native;

typedef struct Stack {
    Val key; /* the list that names it (0 for the data stack) */
    Val *items;
    size_t len, cap;
    int locked;
    int exists; /* it counts as a stack: pushed to or selected, and not deleted since (see stack_lookup) */
    int invalidates_code; /* this stack is a dependency of an operation specialization */
    const Native *native; /* kernel routine used when the stack is empty */
    uint32_t hash;
    /* Which source file put what here, so that loading a file again can take its definitions out
       first. owners[i] is the file whose load pushed items[i]; it is only kept for the first
       owners_len items (a later item, or a 0, belongs to no file). */
    uint32_t *owners;
    size_t owners_len, owners_cap;
    uint32_t creator;       /* the file whose load made the stack exist (0: none) */
    uint32_t locked_by;     /* the file whose load locked it */
    uint32_t unlocked_for;  /* the file whose reload unlocked it and has not locked it again yet */
    struct Stack *chain;
} Stack;


typedef struct { int line; Val list; } Form;
typedef struct { Form *f; size_t n; } Forms;
typedef struct { char msg[160]; int line; int incomplete; } LowerErr;

/* lower.c: returns 0 on success */
int lower_op_forms(const char *text, size_t len, int first_line, uint32_t owner, Forms *out,
                   LowerErr *err);
int parse_number_text(const char *s, double *out, int *overflow);
int is_token_space(uint32_t c);

/* Lists compile to linear Code with literals, call sites and control-flow specializations.
   Kernel-wrapper specializations are guarded by the code epoch. */
/* Opcodes of the register loop; anything else is H_COLD. */
enum { H_COLD, H_PUSH, H_NOP, H_JMP, H_BR, H_DROP, H_ADD, H_SUB, H_MUL, H_EQ, H_DIV, H_IDIV,
       H_PICKK, H_ROLLK, /* k PICK, k ROLL with the literal k folded in: ins->a = k + 1 */
       H_REC, H_REC0, /* tail (label) REC and tail rec: a jump to the start of the running lambda */
       H_COUNT };

enum { I_PUSH, I_SITE, I_SPECIALIZED, I_IFTE_GUARD, I_JMP, I_BR, I_LOOP_GUARD, I_BRL, I_END };
typedef struct {
    int kind;
    int hot; /* H_* specialized operation, or H_COLD when it must use ordinary dispatch */
    Stack *st;
    Val v;
    int a, b; /* I_JMP: target; I_BR, I_BRL: target when false, resume point after the structure;
                 I_IFTE_GUARD, I_LOOP_GUARD: source index, resume point after the structure;
                 specialized PICK/ROLL: k + 1 when literal k is folded */
    int tail; /* nothing runs after this call, so the frame is released before it */
    int src;  /* the index of the list item this instruction comes from (a structure inlined from
                 a deeper list counts as the item of the outermost list that holds it) */
} Instr;
struct Code {
    int n;
    uint8_t keep;
    uint64_t epoch;
    Code *prev; /* older versions, kept while a frame may still be running them */
    Instr instrs[];
};

enum { FR_CODE, FR_BRANCH, FR_CATCH, FR_CALL, FR_END, FR_LAMBDA, FR_LOOP
};
typedef struct { int kind; size_t idx; Code *code; Val a, b; } Frame;

typedef struct { FILE *f; int binary; } Stream;


struct Machine {
    Stack data;
    Stack **table;
    size_t tcap, tcount;
    Frame *ctl;
    size_t ctl_len, ctl_cap, base;
    Val *roots;
    size_t nroots, roots_cap;
    int handling;
    int propagating; /* a nested run ended on an error that an enclosing run will catch */
    const char *source;
    int line;
    Val err_kind, err_data, err_original;
    const char *err_where;
    Stream *streams;
    size_t nstreams, streams_cap;
    char **included;
    size_t nincluded;
    char **loading; /* resolved paths of the INCLUDEs in progress, outermost first */
    size_t nloading;
    Stack *exception;
    Stack *diagnostics;
    Stack *selected;
    jmp_buf *abort_jmp;
    uint64_t epoch; /* bumped when a specialization dependency may have changed */
    int optimize_instrs;
    uint32_t cur_file; /* id of the file whose load is running (0: none), see file_id */
    int private_ops; /* 0: `__` ops of source files are ordinary public ops (BO_NO_PRIVATE) */
    char *home;        /* the directory that holds include/: the last place a relative include path is looked up; may be NULL */
    char **owners;     /* resolved paths of the source files that own private ops: owner id = index + 1 */
    size_t nowners, owners_cap;
    int stepping, paused, step_mode, step_arm; /* modes: debugger.inc */
    long step_budget; /* ops still allowed to run before the stepper pauses */
    size_t step_base; /* control-stack base of the stepped program; nested runs never pause */
    size_t step_depth; /* STEP_OVER: control-stack depth of the op that was paused before */
    int resume_host;   /* the host is a prompt that carries out resume requests (WebAssembly has buttons) */
    int step_cold;     /* the stepper stops at literals too: compiled code keeps them out of the register loop */
    int bp_hit;        /* the last pause came from a BREAKPOINT, not from a step */
    uint32_t user_file; /* the source file being debugged: its code is the user's even in the library */
    int in_pause;      /* resume_host: a program is paused and waits for a resume request */
    int resume;        /* the resume request set by STEP, NEXT, CONTINUE or STOP: RESUME_* */
    size_t catch_floor; /* while paused: errors of the prompt are not caught below this depth */
};

void machine_init(Machine *m);
extern int bo_stdout_midline; /* 1 when the last byte a program wrote to stdout was not a newline */
int execute(Machine *m, const char *text, size_t len, const char *source, int first_line);
int execute_file(Machine *m, const char *text, size_t len, const char *source);
void machine_run(Machine *m, Val program);
int include_file(Machine *m, const char *path);
int include_file_once(Machine *m, const char *path);
void dump_stack(Machine *m, FILE *out);
void gc_collect(Machine *m);

/* debugger.inc: the step driver, used by the WebAssembly host and by the prompt, where a
   BREAKPOINT or a step command pauses a line. debug_step returns a DBG_* state. */
enum { DBG_IDLE, DBG_READY, DBG_PAUSED, DBG_DONE, DBG_ERROR, DBG_EXIT };
/* Step modes: every op; the first op of each top-level line; those and user ops; none
   (only a BREAKPOINT pauses); every call but the kernel primitives (the prompt's step); and
   those no deeper than step_depth (the prompt's next); and ops (not literals) no deeper than
   step_depth (the playground's "op, over calls"). */
enum { STEP_OPS, STEP_LINES, STEP_USER, STEP_RUN, STEP_INTO, STEP_OVER, STEP_OPS_OVER };
enum { RESUME_NONE, RESUME_STEP, RESUME_NEXT, RESUME_CONTINUE, RESUME_STOP };
enum { DEBUG_FAST = 1, DEBUG_SCRATCH = 2 }; /* debug_begin flags */
int debug_begin(Machine *m, const char *text, int flags);
int debug_step(Machine *m, long budget, int mode);
int debug_step_host(Machine *m, long budget, int mode);
/* Prompt of a paused program: run a line at the pause point, carry out the resume request it
   made (the new DBG_* state, or -1 if none), say where the program stands, drop the program. */
int debug_eval(Machine *m, const char *text, size_t len);
int debug_resume(Machine *m);
const char *debug_where(Machine *m);
void debug_abort(Machine *m);
int debug_start_text(Machine *m, const char *text, int stop);
int debug_start_file(Machine *m, const char *path, int stop);

extern size_t heap_alloc, heap_gc_at;

#endif
