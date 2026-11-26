/* Return 1 to yield, -1 on a Bo error, or 0 when the quotation is finished. */
.text
.globl aot_bridge_body
.type aot_bridge_body, @function
aot_bridge_body:
    pushq %rbx
    movq %rdi, %rbx
    cmpq $0, %rsi
    je .Lfirst
    cmpq $1, %rsi
    je .Lsecond
    cmpq $2, %rsi
    je .Lcomplete
    ud2
.Lfirst:
    movsd .Lone(%rip), %xmm0
    call aot_bridge_push
    movq %rbx, %rdi
    movq $1, %rsi
    call aot_bridge_call_plus
    testl %eax, %eax
    jne .Lreturn
.Lsecond:
    movq %rbx, %rdi
    movsd .Lten(%rip), %xmm0
    call aot_bridge_push
    movq %rbx, %rdi
    movq $2, %rsi
    call aot_bridge_call_plus
    testl %eax, %eax
    jne .Lreturn
.Lcomplete:
    xorl %eax, %eax
.Lreturn:
    popq %rbx
    ret
.size aot_bridge_body, .-aot_bridge_body

/* Each body stores its continuation before making a direct compiled call. */
.macro OUTER name, target, literal
.globl \name
.type \name, @function
\name:
    pushq %rbx
    movq %rdi, %rbx
    cmpq $0, %rsi
    je .Lcall\@
    cmpq $1, %rsi
    je .Lafter\@
    cmpq $2, %rsi
    je .Lend\@
    ud2
.Lcall\@:
    movq $\target, %rsi
    movq $1, %rdx
    call aot_bridge_call_nested
    testl %eax, %eax
    jne .Lexit\@
.Lafter\@:
    movq %rbx, %rdi
    movsd \literal(%rip), %xmm0
    call aot_bridge_push
    movq %rbx, %rdi
    movq $2, %rsi
    call aot_bridge_call_plus
    testl %eax, %eax
    jne .Lexit\@
.Lend\@:
    xorl %eax, %eax
.Lexit\@:
    popq %rbx
    ret
.size \name, .-\name
.endm
OUTER aot_bridge_outer_body, 1, .Lhundred
OUTER aot_bridge_grand_body, 2, .Lthousand
.section .rodata
.Lone: .double 1
.Lten: .double 10
.Lhundred: .double 100
.Lthousand: .double 1000
.section .note.GNU-stack,"",@progbits
