/* Tail-call implementation of the Bo quotation (1 +). */
.text
.globl aot_step_integrated
.type aot_step_integrated, @function
aot_step_integrated:
    pushq %rbx
    movq %rdi, %rbx
    call aot_push_one_integrated
    movq %rbx, %rdi
    popq %rbx
    jmp aot_call_plus_integrated
.size aot_step_integrated, .-aot_step_integrated

/* Tail-call implementation of the Bo quotation (() ADD). */
.globl aot_plus_integrated
.type aot_plus_integrated, @function
aot_plus_integrated:
    pushq %rbx
    movq %rdi, %rbx
    call aot_push_selector_integrated
    movq %rbx, %rdi
    popq %rbx
    jmp aot_call_add_integrated
.size aot_plus_integrated, .-aot_plus_integrated
.section .note.GNU-stack,"",@progbits
