"use client";

import { useId, type ReactNode } from "react";
import type { FormSchema } from "../protocol.ts";
import { isRecord } from "../state.ts";

export interface FormField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  type: "string" | "number" | "integer" | "boolean" | "array";
  choices?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** A bounded flat-object subset. Unknown constraints refuse the entire form, never disappear.
 * No schema references, regex evaluation, code execution or network access. */
export function formFields(schema: FormSchema): FormField[] | null {
  if (
    schema.type !== "object" ||
    !isRecord(schema.properties) ||
    Object.keys(schema).some(
      (key) =>
        ![
          "type",
          "properties",
          "required",
          "additionalProperties",
          "title",
          "description",
        ].includes(key),
    ) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  )
    return null;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (name) => typeof name !== "string" || !Object.hasOwn(schema.properties ?? {}, name),
    )
  )
    return null;
  const properties = Object.entries(schema.properties);
  if (properties.length === 0 || properties.length > 20) return null;
  const fields: FormField[] = [];
  for (const [name, spec] of properties) {
    if (
      ["__proto__", "prototype", "constructor"].includes(name) ||
      !isRecord(spec) ||
      (spec.type !== "string" &&
        spec.type !== "number" &&
        spec.type !== "integer" &&
        spec.type !== "boolean" &&
        spec.type !== "array")
    )
      return null;
    const allowed = [
      "type",
      "title",
      "description",
      ...(spec.type === "string"
        ? ["enum", "minLength", "maxLength"]
        : spec.type === "number" || spec.type === "integer"
          ? ["minimum", "maximum"]
          : spec.type === "array"
            ? ["items", "uniqueItems"]
            : []),
    ];
    if (
      Object.keys(spec).some((key) => !allowed.includes(key)) ||
      (spec.title !== undefined && typeof spec.title !== "string") ||
      (spec.description !== undefined && typeof spec.description !== "string")
    )
      return null;
    const field: FormField = {
      name,
      label: typeof spec.title === "string" ? spec.title : name,
      type: spec.type,
      required: required.includes(name),
    };
    if (typeof spec.description === "string") field.description = spec.description;
    for (const bound of ["minimum", "maximum", "minLength", "maxLength"] as const) {
      const value = spec[bound];
      if (value === undefined) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        ((bound === "minLength" || bound === "maxLength") &&
          (!Number.isSafeInteger(value) || value < 0))
      )
        return null;
      field[bound] = value;
    }
    if (field.type === "integer") {
      if (field.minimum !== undefined) field.minimum = Math.ceil(field.minimum);
      if (field.maximum !== undefined) field.maximum = Math.floor(field.maximum);
    }
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
      return null;
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    )
      return null;
    const choices = spec.type === "array" && isRecord(spec.items) ? spec.items.enum : spec.enum;
    if (
      spec.type === "array" &&
      (!isRecord(spec.items) ||
        spec.items.type !== "string" ||
        Object.keys(spec.items).some((key) => key !== "type" && key !== "enum") ||
        spec.uniqueItems !== true)
    )
      return null;
    if (choices !== undefined) {
      if (field.minLength !== undefined || field.maxLength !== undefined) return null;
      if (
        !Array.isArray(choices) ||
        !choices.length ||
        choices.length > 100 ||
        !choices.every(
          (choice): choice is string => typeof choice === "string" && choice.length > 0,
        ) ||
        new Set(choices).size !== choices.length
      )
        return null;
      field.choices = choices;
    }
    if (spec.type === "array" && !field.choices) return null;
    fields.push(field);
  }
  return fields;
}

export interface SchemaFormProps {
  schema: FormSchema;
  value: Readonly<Record<string, unknown>>;
  onChange(value: Record<string, unknown>): void;
  disabled?: boolean;
  /** Required recovery copy when the built-in subset cannot honor every requirement. */
  unsupported: ReactNode;
  chooseLabel: string;
  trueLabel: string;
  falseLabel: string;
}

/** Controlled fields only. The parent owns submit, errors, drafts and persistence. */
export function SchemaForm({
  schema,
  value,
  onChange,
  disabled,
  unsupported,
  chooseLabel,
  trueLabel,
  falseLabel,
}: SchemaFormProps) {
  const id = useId();
  const fields = formFields(schema);
  if (!fields) return <div data-part="unsupported-form">{unsupported}</div>;
  function change(field: FormField, next: unknown) {
    const result = { ...value };
    if (next === undefined) delete result[field.name];
    else
      Object.defineProperty(result, field.name, {
        value: next,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    onChange(result);
  }
  return (
    <div className="pk-request-fields" data-part="schema-form">
      {fields.map((field, index) => {
        const inputId = `${id}-${index}`;
        const held = value[field.name];
        const describedBy = field.description ? `${inputId}-help` : undefined;
        return (
          <div key={field.name} className="pk-request-field">
            <label htmlFor={inputId}>{field.label}</label>
            {field.description && <p id={describedBy}>{field.description}</p>}
            {field.choices ? (
              <select
                id={inputId}
                multiple={field.type === "array"}
                aria-describedby={describedBy}
                disabled={disabled}
                required={field.required}
                value={
                  field.type === "array"
                    ? Array.isArray(held)
                      ? held.filter((item): item is string => typeof item === "string")
                      : []
                    : typeof held === "string"
                      ? held
                      : ""
                }
                onChange={(event) =>
                  change(
                    field,
                    field.type === "array"
                      ? Array.from(event.currentTarget.selectedOptions, (option) => option.value)
                      : event.currentTarget.value || undefined,
                  )
                }
              >
                {field.type !== "array" && <option value="">{chooseLabel}</option>}
                {field.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : field.type === "boolean" ? (
              <select
                id={inputId}
                disabled={disabled}
                required={field.required}
                aria-describedby={describedBy}
                value={typeof held === "boolean" ? String(held) : ""}
                onChange={(event) =>
                  change(
                    field,
                    event.currentTarget.value === ""
                      ? undefined
                      : event.currentTarget.value === "true",
                  )
                }
              >
                <option value="">{chooseLabel}</option>
                <option value="true">{trueLabel}</option>
                <option value="false">{falseLabel}</option>
              </select>
            ) : (
              <input
                id={inputId}
                type={field.type === "string" ? "text" : "number"}
                aria-describedby={describedBy}
                disabled={disabled}
                required={field.required}
                min={field.minimum}
                max={field.maximum}
                minLength={field.minLength}
                maxLength={field.maxLength}
                step={field.type === "integer" ? 1 : "any"}
                value={typeof held === "string" || typeof held === "number" ? held : ""}
                onChange={(event) =>
                  change(
                    field,
                    field.type === "string"
                      ? event.currentTarget.value
                      : event.currentTarget.value === ""
                        ? undefined
                        : event.currentTarget.valueAsNumber,
                  )
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
