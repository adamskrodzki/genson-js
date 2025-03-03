import { ValueType, Schema, SchemaGenOptions } from './types';

function createSchemaFor(value: any, options?: SchemaGenOptions, description? : string, enums? : string[]): Schema {
    let additions = {};
    if(enums){
        additions["enum"] = enums;
    }
    if (description) {
        additions["description"] = description;
    }
    switch (typeof value) {
        case 'number':
            if (Number.isInteger(value)) {
                return { type: ValueType.Integer, ...additions };
            }
            return { type: ValueType.Number, ...additions };
        case 'boolean':
            return { type: ValueType.Boolean, ...additions };
        case 'string':
            return { type: ValueType.String, ...additions };
        case 'object':
            if (value === null) {
                return { type: ValueType.Null, ...additions };
            }
            if (Array.isArray(value)) {
                return createSchemaForArray(value, options, description);
            }
            return createSchemaForObject(value, options, description);
    }
}

function createSchemaForArray(arr: Array<any>, options?: SchemaGenOptions, description? : string): Schema {
    if (arr.length === 0) {
        return description ? { type: ValueType.Array, description } : { type: ValueType.Array };
    }
    const elementSchemas = arr.map((value) => createSchemaFor(value, options));
    const items = combineSchemas(elementSchemas);
    return description ? { type: ValueType.Array, items, description } : { type: ValueType.Array, items };
}

function createSchemaForObject(obj: Object, options?: SchemaGenOptions, description? : string): Schema {
    const keys = Object.keys(obj);
    const nonFunctionKeys = keys.filter((key) => typeof obj[key] !== 'function');
    if (keys.length === 0) {

        return description ? {
            type: ValueType.Object,
            description
        } : { type: ValueType.Object };
    }
    const properties = Object.entries(obj).reduce((props, [key, val]) => {
        let description : string | undefined = undefined;
        let enums : string[] | undefined = undefined;
        
        if(obj["addDescriptionOfProperty"]){
            description = obj["addDescriptionOfProperty"](key);
        }

        if(obj["addEnumForProperty"]){
            enums = obj["addEnumForProperty"](key);
        }

        if(typeof val !== 'function'){
            props[key] = createSchemaFor(val, options, description, enums);
        }
        return props;
    }, {});

    const schema: Schema = description ? { type: ValueType.Object, properties, description } : { type: ValueType.Object, properties };

    let requiredKeys = nonFunctionKeys;
    
    if (!options?.noRequired) {
        if(obj["excludeFromRequired"]){
            const excluded : string[] = obj["excludeFromRequired"]();
            requiredKeys = requiredKeys.filter(x => !excluded.includes(x))
        }
        schema.required = requiredKeys;
    }

    return schema;
}

function combineSchemas(schemas: Schema[], options?: SchemaGenOptions): Schema {
    const schemasByType: Record<ValueType, Schema[]> = {
        [ValueType.Null]: [],
        [ValueType.Boolean]: [],
        [ValueType.Integer]: [],
        [ValueType.Number]: [],
        [ValueType.String]: [],
        [ValueType.Array]: [],
        [ValueType.Object]: [],
    };

    const unwrappedSchemas = unwrapSchemas(schemas);
    for (const unwrappedSchema of unwrappedSchemas) {
        const type = unwrappedSchema.type as ValueType;
        if (schemasByType[type].length === 0 || isContainerSchema(unwrappedSchema)) {
            schemasByType[type].push(unwrappedSchema);
        } else {
            continue;
        }
    }

    const resultSchemasByType: Record<ValueType, Schema> = {
        [ValueType.Null]: schemasByType[ValueType.Null][0],
        [ValueType.Boolean]: schemasByType[ValueType.Boolean][0],
        [ValueType.Number]: schemasByType[ValueType.Number][0],
        [ValueType.Integer]: schemasByType[ValueType.Integer][0],
        [ValueType.String]: schemasByType[ValueType.String][0],
        [ValueType.Array]: combineArraySchemas(schemasByType[ValueType.Array]),
        [ValueType.Object]: combineObjectSchemas(schemasByType[ValueType.Object], options),
    };

    if (resultSchemasByType[ValueType.Number]) {
        // if at least one value is float, others can be floats too
        delete resultSchemasByType[ValueType.Integer];
    }

    const schemasFound = Object.values(resultSchemasByType).filter(Boolean);
    const multiType = schemasFound.length > 1;
    if (multiType) {
        const wrapped = wrapAnyOfSchema({ anyOf: schemasFound });
        return wrapped;
    }
    return schemasFound[0] as Schema;
}

function combineArraySchemas(schemas: Schema[]): Schema {
    if (!schemas || schemas.length === 0) {
        return undefined;
    }
    const itemSchemas: Schema[] = [];
    for (const schema of schemas) {
        if (!schema.items) continue;
        const unwrappedSchemas = unwrapSchema(schema.items);
        itemSchemas.push(...unwrappedSchemas);
    }

    if (itemSchemas.length === 0) {
        return {
            type: ValueType.Array,
        };
    }
    const items = combineSchemas(itemSchemas);
    return {
        type: ValueType.Array,
        items,
    };
}

function combineObjectSchemas(schemas: Schema[], options?: SchemaGenOptions): Schema {
    if (!schemas || schemas.length === 0) {
        return undefined;
    }
    const allPropSchemas = schemas.map((s) => s.properties).filter(Boolean);
    const schemasByProp: Record<string, Schema[]> = Object.create(null);
    // const schemasByProp: Record<string, Schema[]> = {};
    for (const propSchemas of allPropSchemas) {
        for (const [prop, schema] of Object.entries(propSchemas)) {
            if (!schemasByProp[prop]) {
                schemasByProp[prop] = [];
            }
            const unwrappedSchemas = unwrapSchema(schema);
            schemasByProp[prop].push(...unwrappedSchemas);
        }
    }

    const properties: Record<string, Schema> = Object.entries(schemasByProp).reduce((props, [prop, schemas]) => {
        if (schemas.length === 1) {
            props[prop] = schemas[0];
        } else {
            props[prop] = combineSchemas(schemas);
        }
        return props;
    }, {});

    const combinedSchema: Schema = { type: ValueType.Object };

    if (Object.keys(properties).length > 0) {
        combinedSchema.properties = properties;
    }
    if (!options?.noRequired) {
        const required = intersection(schemas.map((s) => s.required || []));
        if (required.length > 0) {
            combinedSchema.required = required;
        }
    }

    return combinedSchema;
}

export function unwrapSchema(schema: Schema): Schema[] {
    if (!schema) return [];
    if (schema.anyOf) {
        return unwrapSchemas(schema.anyOf);
    }
    if (Array.isArray(schema.type)) {
        return schema.type.map((x) => ({ type: x }));
    }
    return [schema];
}

export function unwrapSchemas(schemas: Schema[]): Schema[] {
    if (!schemas || schemas.length === 0) return [];
    const unwrappedSchemas = schemas.flatMap((schema) => unwrapSchema(schema));
    return unwrappedSchemas;
}

export function wrapAnyOfSchema(schema: Schema): Schema {
    const simpleSchemas = [];
    const complexSchemas = [];
    for (const subSchema of schema.anyOf) {
        if (Array.isArray(subSchema.type)) {
            simpleSchemas.push(...subSchema.type);
        } else if (isSimpleSchema(subSchema)) {
            simpleSchemas.push((subSchema as Schema).type);
        } else {
            complexSchemas.push(subSchema);
        }
    }
    if (complexSchemas.length === 0) {
        return { type: simpleSchemas };
    }
    const anyOf = [];
    if (simpleSchemas.length > 0) {
        anyOf.push({ type: simpleSchemas.length > 1 ? simpleSchemas : simpleSchemas[0] });
    }
    anyOf.push(...complexSchemas);
    return { anyOf };
}

function intersection(valuesArr: string[][]) {
    if (valuesArr.length === 0) return [];
    const arrays = valuesArr.filter(Array.isArray);
    const counter: Record<string, number> = {};
    for (const arr of arrays) {
        for (const val of arr) {
            if (!counter[val]) {
                counter[val] = 1;
            } else {
                counter[val]++;
            }
        }
    }
    const result = Object.entries(counter)
        .filter(([_, value]) => value === arrays.length)
        .map(([key]) => key);
    return result;
}

function isSimpleSchema(schema: Schema): boolean {
    const keys = Object.keys(schema);
    return keys.length === 1 && keys[0] === 'type';
}

function isContainerSchema(schema: Schema): boolean {
    const type = (schema as Schema).type;
    return type === ValueType.Array || type === ValueType.Object;
}

// FACADE

export function createSchema(value: any, options?: SchemaGenOptions): Schema {
    JSON.stringify(value);//just to catch circular dependencies
    if (typeof value === 'undefined') value = null;
    return createSchemaFor(value, options);
}

export function mergeSchemas(schemas: Schema[], options?: SchemaGenOptions): Schema {
    const mergedSchema = combineSchemas(schemas, options);
    return mergedSchema;
}

export function extendSchema(schema: Schema, value: any, options?: SchemaGenOptions): Schema {
    const valueSchema = createSchema(value, options);
    const mergedSchema = combineSchemas([schema, valueSchema], options);
    return mergedSchema;
}

export function createCompoundSchema(values: any[], options?: SchemaGenOptions): Schema {
    const schemas = values.map((value) => createSchema(value, options));
    return mergeSchemas(schemas, options);
}
