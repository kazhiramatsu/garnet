#ifndef TSAOT_JSON_CORE_H
#define TSAOT_JSON_CORE_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
  TJSON_NULL = 0,
  TJSON_BOOL = 1,
  TJSON_NUMBER = 2,
  TJSON_STRING = 3,
  TJSON_ARRAY = 4,
  TJSON_OBJECT = 5
} tjson_kind;

typedef struct tjson_doc tjson_doc;
typedef struct tjson_value tjson_value;

typedef struct {
  const char* data;
  uint32_t len;
} tjson_string;

typedef struct {
  tjson_string key;
  tjson_value* value;
} tjson_member;

struct tjson_value {
  tjson_kind kind;
  tjson_doc* doc;
  union {
    double number;
    int boolean;
    tjson_string string;
    struct {
      tjson_value** items;
      uint32_t len;
      uint32_t cap;
    } array;
    struct {
      tjson_member* members;
      uint32_t len;
      uint32_t cap;
    } object;
  } as;
};

tjson_value* tjson_parse_copy(const char* data, uint32_t len);
tjson_value* tjson_parse_take(char* data, uint32_t len);
void tjson_free(tjson_value* root);

tjson_value* tjson_object_get(tjson_value* obj, const char* key, uint32_t key_len);
tjson_value* tjson_object_get_hint(tjson_value* obj, const char* key, uint32_t key_len, uint32_t* hint);
tjson_value* tjson_array_get(tjson_value* arr, uint32_t index);
double tjson_length(tjson_value* value);
double tjson_number_value(tjson_value* value);
int tjson_truthy(tjson_value* value);

char* tjson_stringify_alloc(tjson_value* value, uint32_t* out_len);
double tjson_stringify_len(tjson_value* value);

#endif
