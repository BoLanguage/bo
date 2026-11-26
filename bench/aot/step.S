/* Ahead-of-time implementation of (1 +), System V x86-64 ABI. */
.text
.globl aot_step
.type aot_step, @function
aot_step:
    pushq %rbx
    pushq %r12
    subq $8, %rsp
    movq %rdi, %rbx
    movq %rsi, %r12
    call aot_push_one
    movq %rbx, %rdi
    movq %r12, %rsi
    call aot_call_word
    addq $8, %rsp
    popq %r12
    popq %rbx
    ret
.size aot_step, .-aot_step
.section .note.GNU-stack,"",@progbits
