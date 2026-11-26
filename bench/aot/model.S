/* Direct-call model: literal pushes and named calls remain separate operations. */
.text
.globl model_step
.type model_step, @function
model_step:
    pushq %rbx
    movq %rdi, %rbx
    call model_push_one
    movq %rbx, %rdi
    popq %rbx
    jmp model_call_plus
.size model_step, .-model_step

.globl model_plus
.type model_plus, @function
model_plus:
    pushq %rbx
    movq %rdi, %rbx
    call model_push_selector
    movq %rbx, %rdi
    popq %rbx
    jmp model_call_add
.size model_plus, .-model_plus

.globl model_alt
.type model_alt, @function
model_alt:
    pushq %rbx
    movq %rdi, %rbx
    call model_push_selector
    movq %rbx, %rdi
    call model_call_add
    movq %rbx, %rdi
    call model_push_one
    movq %rbx, %rdi
    call model_push_selector
    movq %rbx, %rdi
    popq %rbx
    jmp model_call_add
.size model_alt, .-model_alt

/* Bound and rebinding scenario are runtime inputs, not constants in the loop. */
.globl model_loop
.type model_loop, @function
model_loop:
    pushq %r12
    pushq %r13
    pushq %r14
    movq %rdi, %r12
    movq %rsi, %r13
    movq %rdx, %r14
.Lloop:
    movq %r12, %rdi
    movq %r13, %rsi
    call model_continue
    testl %eax, %eax
    jz .Ldone
    movq %r12, %rdi
    call model_call_step
    testq %r14, %r14
    jz .Lloop
    movq %r12, %rdi
    call model_bind_alt
    movq %r12, %rdi
    call model_call_step
    movq %r12, %rdi
    call model_unbind_alt
    jmp .Lloop
.Ldone:
    popq %r14
    popq %r13
    popq %r12
    ret
.size model_loop, .-model_loop
.section .note.GNU-stack,"",@progbits
