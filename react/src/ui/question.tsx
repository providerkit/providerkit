"use client";

import { useId, type ReactNode } from "react";
import type { QuestionAnswer } from "../requests.ts";
import type { QuestionPart } from "../protocol.ts";
import { isRecord } from "../state.ts";
import { useConversationLabels, type ConversationLabelOverrides } from "./context.tsx";
import { SchemaForm, type SchemaFormProps } from "./schema-form.tsx";

export interface QuestionFieldsProps {
  question: QuestionPart;
  value: QuestionAnswer;
  onChange(value: QuestionAnswer): void;
  disabled?: boolean;
  labels?: ConversationLabelOverrides;
  renderForm?: (props: SchemaFormProps) => ReactNode;
}

/** Native controlled controls. No persistence, send or automatic clearing. */
export function QuestionFields({
  question,
  value,
  onChange,
  disabled,
  labels: overrides,
  renderForm,
}: QuestionFieldsProps) {
  const labels = useConversationLabels(overrides);
  const id = useId();
  const allowsText = question.freeText ?? (!question.choices?.length && !question.schema);
  const formProps = question.schema
    ? {
        schema: question.schema,
        value: isRecord(value.data) ? value.data : {},
        onChange: (data: Record<string, unknown>) => onChange({ ...value, data }),
        disabled,
        unsupported: <p>{labels.unsupportedForm}</p>,
        chooseLabel: labels.choose,
        trueLabel: labels.yes,
        falseLabel: labels.no,
      }
    : undefined;
  return (
    <div className="pk-request-fields" data-part="question-fields">
      {!!question.choices?.length && (
        <fieldset disabled={disabled}>
          <legend>{question.multiple ? labels.chooseMany : labels.chooseOne}</legend>
          {question.choices.map((choice, index) => (
            <label key={choice.id} className="pk-request-choice">
              <input
                type={question.multiple ? "checkbox" : "radio"}
                name={id}
                value={choice.id}
                aria-describedby={choice.description ? `${id}-${index}` : undefined}
                checked={value.choices?.includes(choice.id) ?? false}
                onChange={(event) => {
                  const choices = question.multiple
                    ? event.currentTarget.checked
                      ? [...(value.choices ?? []), choice.id]
                      : (value.choices?.filter((item) => item !== choice.id) ?? [])
                    : [choice.id];
                  onChange({ ...value, choices });
                }}
              />
              <span>
                {choice.label}
                {choice.description && (
                  <span id={`${id}-${index}`} className="pk-request-choice-help">
                    {choice.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {allowsText && (
        <label className="pk-request-field">
          {labels.answerText}
          <textarea
            readOnly={disabled}
            aria-disabled={disabled}
            value={value.text ?? ""}
            onChange={(event) => onChange({ ...value, text: event.currentTarget.value })}
          />
        </label>
      )}
      {formProps && (renderForm ? renderForm(formProps) : <SchemaForm {...formProps} />)}
    </div>
  );
}
