/**
 * Keep Gemini's constrained-decoding grammar small. Array/numeric bounds can
 * multiply states across nested scenes; UUID patterns add further branches.
 * The original Zod schema remains the authority for validating every response.
 * https://aistudio.google.com/docs/structured-output#simplifying-complex-schemas
 */
const applicationConstraints = new Set([
  '$schema', 'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains',
  'minProperties', 'maxProperties',
]);
const schemaMaps = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const singleSchemas = new Set(['items', 'additionalProperties', 'additionalItems', 'not', 'if', 'then', 'else', 'propertyNames']);
const schemaLists = new Set(['anyOf', 'allOf', 'oneOf', 'prefixItems']);
const object = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Produces a separate wire schema; never mutates application validation rules. */
export function simplifyGeminiSchema(schema:Record<string,unknown>):Record<string,unknown> {
  const output:Record<string,unknown> = {};
  for (const [keyword,value] of Object.entries(schema)) {
    if (applicationConstraints.has(keyword)) continue;
    if (schemaMaps.has(keyword) && object(value)) {
      // Property names are data, even if a property happens to be named "maximum".
      output[keyword] = Object.fromEntries(Object.entries(value).map(([name,child])=>[name,object(child)?simplifyGeminiSchema(child):structuredClone(child)]));
    } else if (singleSchemas.has(keyword) && object(value)) {
      output[keyword] = simplifyGeminiSchema(value);
    } else if (schemaLists.has(keyword) && Array.isArray(value)) {
      output[keyword] = value.map(child=>object(child)?simplifyGeminiSchema(child):structuredClone(child));
    } else output[keyword] = structuredClone(value);
  }
  return output;
}
