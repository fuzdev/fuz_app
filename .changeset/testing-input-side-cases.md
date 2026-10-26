---
'@fuzdev/fuz_app': minor
---

feat: the adversarial input generators read each field's input-side JSON Schema through the new `to_field_json_schema` (through a `.transform()` or pipe, under a nullable's `anyOf`), so a `Username` field gets its pattern and length cases; every generated case is single-fault — emitted only when the field refuses its value, and for a field the base omits built on a valid body that carries it (the new `generate_valid_object_with_field`: a paired field added, an exactly-one-of branch swapped), with no format or boundary cases for a field no valid body carries; new boundary cases one under `minLength` and `minItems`, a non-integer for an integer field and a value off a `multipleOf` grid; the params and query bases come from the new `generate_valid_string_param` and must pass the schema (a params or query base the generator can't build throws), and a query field whose absence a default fills gets no missing case
