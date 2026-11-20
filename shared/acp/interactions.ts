import {
  ElicitationPropertySchema as ElicitationPropertySchemaGuard,
  MultiSelectItems,
} from "@agentclientprotocol/sdk";
import type {
  CreateElicitationRequest,
  ElicitationPropertySchema,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

import type {
  ElicitationField,
  ThreadInteraction,
} from "../webview/thread/types";

const nonEmpty = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const permissionInteraction = (
  id: string,
  request: RequestPermissionRequest
): ThreadInteraction => ({
  id,
  kind: "permission",
  message: request.toolCall.title ?? "Permission required",
  options: request.options.map((option) => ({
    id: option.optionId,
    kind: option.kind,
    name: option.name,
  })),
});

const optionDescription = (option: {
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}): string | undefined => {
  if (nonEmpty(option.description)) {
    return option.description;
  }
  const magPiAcp = option._meta?.magPiAcp;
  return isRecord(magPiAcp) && typeof magPiAcp.description === "string"
    ? magPiAcp.description
    : undefined;
};

const options = (
  schema: ElicitationPropertySchema
): NonNullable<ElicitationField["options"]> | undefined => {
  if (ElicitationPropertySchemaGuard.isString(schema)) {
    if (schema.oneOf) {
      return schema.oneOf.map((option) => ({
        ...(nonEmpty(optionDescription(option))
          ? { description: optionDescription(option) }
          : {}),
        name: option.title,
        value: option.const,
      }));
    }
    return schema.enum?.map((value) => ({ name: value, value }));
  }
  if (!ElicitationPropertySchemaGuard.isArray(schema)) {
    return undefined;
  }
  if (MultiSelectItems.isTitled(schema.items)) {
    return schema.items.anyOf.map((option) => ({
      ...(nonEmpty(optionDescription(option))
        ? { description: optionDescription(option) }
        : {}),
      name: option.title,
      value: option.const,
    }));
  }
  if (MultiSelectItems.isString(schema.items)) {
    return schema.items.enum.map((value) => ({ name: value, value }));
  }
  throw new Error("Unsupported elicitation choice schema");
};

const field = (
  name: string,
  schema: ElicitationPropertySchema,
  required: boolean
): ElicitationField => {
  const choices = options(schema);
  let type: ElicitationField["type"];
  if (ElicitationPropertySchemaGuard.isBoolean(schema)) {
    type = "boolean";
  } else if (
    ElicitationPropertySchemaGuard.isNumber(schema) ||
    ElicitationPropertySchemaGuard.isInteger(schema)
  ) {
    type = "number";
  } else if (ElicitationPropertySchemaGuard.isArray(schema)) {
    type = "multiselect";
  } else if (ElicitationPropertySchemaGuard.isString(schema)) {
    type = choices ? "select" : "text";
  } else {
    throw new TypeError("Unsupported elicitation property schema");
  }
  return {
    ...(schema.default === undefined || schema.default === null
      ? {}
      : { defaultValue: schema.default }),
    ...(nonEmpty(schema.description)
      ? { description: schema.description }
      : {}),
    ...(choices ? { options: choices } : {}),
    label: schema.title ?? name,
    name,
    required,
    type,
  };
};

export const elicitationInteraction = (
  id: string,
  request: Extract<CreateElicitationRequest, { mode: "form" }>
): ThreadInteraction => {
  const required = new Set(request.requestedSchema.required);
  return {
    ...(nonEmpty(request.requestedSchema.description)
      ? { context: request.requestedSchema.description }
      : {}),
    fields: Object.entries(request.requestedSchema.properties ?? {}).map(
      ([name, schema]) => field(name, schema, required.has(name))
    ),
    id,
    kind: "elicitation",
    message: request.message,
  };
};
