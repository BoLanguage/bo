#include "bo.h"

int unit_element(Val unit, Val *element) {
    if (!is_list(unit) || as_list(unit)->len != 1) return UNIT_TYPE_ERROR;
    *element = as_list(unit)->items[0];
    return UNIT_OK;
}

int unit_type(Val unit, int *type) {
    Val element;
    if (unit_element(unit, &element)) return UNIT_TYPE_ERROR;
    if (is_num(element)) *type = 0;
    else if (is_list(element)) *type = 1;
    else if (is_op(element)) *type = 2;
    else return UNIT_TYPE_ERROR;
    return UNIT_OK;
}

int unit_cons(Val list, Val unit, int right, Val *out) {
    Val element;
    if (!is_list(list) || unit_element(unit, &element)) return UNIT_TYPE_ERROR;
    List *l = as_list(list);
    if (right) {
        *out = list_append(l, element);
    } else {
        List *result = list_new(l->len + 1);
        result->items[0] = element;
        if (l->len) memcpy(result->items + 1, l->items, (size_t)l->len * sizeof(Val));
        *out = from_list(result);
    }
    return UNIT_OK;
}

int unit_uncons(Val list, int right, Val *rest, Val *unit) {
    if (!is_list(list)) return UNIT_TYPE_ERROR;
    List *l = as_list(list);
    if (!l->len) return UNIT_STACK_ERROR;
    *rest = list_slice(l, right ? 0 : 1, l->len - 1);
    *unit = list_of1(l->items[right ? l->len - 1 : 0]);
    return UNIT_OK;
}
