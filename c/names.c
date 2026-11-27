#include "bo.h"

static int valid_name(List *name) {
    if (!name->len) return 0;
    char *ascii = malloc((size_t)name->len + 1);
    if (!ascii) {
        fputs("out of memory\n", stderr);
        exit(2);
    }
    int plain = 1;
    for (uint32_t i = 0; i < name->len; i++) {
        Val element = name->items[i];
        if (!is_int(element)) { free(ascii); return 0; }
        double d = as_num(element);
        if (d <= 0 || d > 0x10ffff || (d >= 0xd800 && d <= 0xdfff)) {
            free(ascii);
            return 0;
        }
        uint32_t cp = (uint32_t)d;
        if (is_token_space(cp) || cp == '(' || cp == ')' || cp == '"' || cp == ';') {
            free(ascii);
            return 0;
        }
        if (cp > 127) plain = 0;
        ascii[i] = (char)(cp <= 127 ? cp : 0);
    }
    ascii[name->len] = 0;
    double number;
    int overflow;
    int numeric = plain && parse_number_text(ascii, &number, &overflow);
    free(ascii);
    return !numeric;
}

int name_to_selector(Val text, Val *selector) {
    if (!is_list(text)) return NAME_TYPE_ERROR;
    List *name = as_list(text);
    for (uint32_t i = 0; i < name->len; i++)
        if (!is_int(name->items[i])) return NAME_TYPE_ERROR;
    if (!valid_name(name)) return NAME_REPRESENTATION_ERROR;
    /* a name that came from a private op keeps no owner: only the reader makes private ops */
    if (name->owner) name = as_list(list_from(name->items, name->len));
    *selector = list_of1(from_op(name));
    return NAME_OK;
}

int selector_to_name(Val selector, Val *text) {
    Val op;
    if (unit_element(selector, &op) || !is_op(op)) return NAME_TYPE_ERROR;
    if (!valid_name(as_op(op))) return NAME_REPRESENTATION_ERROR;
    *text = from_list(as_op(op));
    return NAME_OK;
}
