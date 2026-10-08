; Wrap only player_move's normal-input call, not knockback position updates.
; Duplicate the near Pascal argument: the original and wrapper each pop one.
move_hook:
    push bp
    mov bp,sp
    push word [bp+4]
    call ORIGINAL(0xd71e)
    pushf
    pushad
    movzx ebx,byte [0x6590]
    imul bx,bx,6
%ifdef SOLO_ASSIST
    cmp byte [0x6590],0
    jne .keyboard
%endif
    cmp byte [cs:phase],1
    jne .keyboard
    test word [cs:touch_state+bx],1
    jz .keyboard
    mov si,[0x6588]
    cmp byte [si+0x1f],0
    jne .blocked
    cmp byte [si+0x11],0
    jne .blocked
    cmp byte [si+0x15],0
    jne .blocked
    call touch_move
    popad
    popf
    mov al,2                   ; position applied; skip native key velocity
    pop bp
    ret 2
.blocked:
    mov word [cs:touch_state+bx],0
    mov dword [cs:touch_state+bx+2],0
.keyboard:
    cmp al,1                   ; preserve MOVE_INVALID / MOVE_NOINPUT
    jne .done
    mov cl,[0x6590]            ; pid.current, 0 or 1 at this call site
    mov al,1
    shl al,cl
    test [cs:focus_active],al
    jz .done
    sar byte [0x6586],1        ; signed subpixel velocity, both axes
    sar byte [0x6587],1
.done:
    popad
    popf
    pop bp
    ret 2

; Bound the drag to the native field, then limit its vector to the current
; character's speed. Keep the remainder until the next native movement tick.
touch_move:
    mov bp,[0x6588]
    movsx esi,word [cs:touch_state+bx+2]
    movsx edi,word [cs:touch_state+bx+4]
    movsx eax,word [ds:bp]
    add esi,eax
    cmp esi,0x80
    jge .xmax
    mov esi,0x80
.xmax:
    cmp esi,0x1180
    jle .xready
    mov esi,0x1180
.xready:
    sub esi,eax
    movsx eax,word [ds:bp+2]
    add edi,eax
    cmp edi,0x180
    jge .ymax
    mov edi,0x180
.ymax:
    cmp edi,0x1600
    jle .yready
    mov edi,0x1600
.yready:
    sub edi,eax
    mov [cs:touch_state+bx+2],si
    mov [cs:touch_state+bx+4],di
    test word [cs:touch_state+bx],2
    jnz .apply
    mov eax,esi
    imul eax,eax
    mov edx,edi
    imul edx,edx
    add eax,edx
    xor ecx,ecx
    mov ebp,16384
.sqrt:
    lea edx,[ecx+ebp]
    shr edx,1
    push edx
    imul edx,edx
    cmp edx,eax
    pop edx
    jb .lower
    mov ebp,edx
    jmp .next
.lower:
    lea ecx,[edx+1]
.next:
    cmp ecx,ebp
    jb .sqrt
    movzx ebp,byte [0x6582]
    mov al,[0x6590]
    mov dl,1
    push cx
    mov cl,al
    shl dl,cl
    pop cx
    test [cs:focus_active],dl
    jz .speed
    shr ebp,1
.speed:
    cmp ecx,ebp
    jbe .apply
    mov eax,esi
    imul eax,ebp
    cdq
    idiv ecx
    mov esi,eax
    mov eax,edi
    imul eax,ebp
    cdq
    idiv ecx
    mov edi,eax
.apply:
    mov bp,[0x6588]
    add [ds:bp],si
    add [ds:bp+2],di
    sub [cs:touch_state+bx+2],si
    sub [cs:touch_state+bx+4],di
    ret

