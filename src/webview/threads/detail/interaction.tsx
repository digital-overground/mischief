import { useEffect, useRef, useState } from "react";

import { isNonEmpty } from "../../../present";
import type { ElicitationField } from "../../../threads/model";
import type { ThreadInteraction } from "../../../threads/threads/models";
import { postMessage } from "../../bridge";
import { SvgIcon } from "../../icon";

const ActionButton = ({
  children,
  danger = false,
  icon,
  primary = false,
  type = "button",
  onClick,
}: {
  children: string;
  danger?: boolean;
  icon?: "send" | "x";
  primary?: boolean;
  type?: "button" | "submit";
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element => (
  <button
    className={`action${primary ? " primary" : ""}${danger ? " danger" : ""}`}
    type={type}
    title={children}
    onClick={onClick}
  >
    {icon ? <SvgIcon className="interaction-action-icon" kind={icon} /> : null}
    {children}
  </button>
);

const FieldDescription = ({
  children,
}: {
  children?: string;
}): React.JSX.Element | null =>
  isNonEmpty(children) ? (
    <span className="interaction-field-description">{children}</span>
  ) : null;

const ChoiceIcon = ({ multiple }: { multiple: boolean }): React.JSX.Element => (
  <span className="interaction-choice-icon" aria-hidden="true">
    <SvgIcon kind={multiple ? "square" : "circle"} />
    <SvgIcon
      className="interaction-choice-icon-selected"
      kind={multiple ? "squareCheck" : "circleCheck"}
    />
  </span>
);

const resizeTextarea = (textarea: HTMLTextAreaElement): void => {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
};

const INLINE_OPTIONS = "__mischief_options";

const numberedOptions = (
  lines: string[]
): NonNullable<ElicitationField["options"]> => {
  const options: NonNullable<ElicitationField["options"]> = [];
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const text = /^\s*\d+[.)]\s+(?<text>.+?)\s*$/u.exec(line)?.groups?.text;
    if (text === undefined) {
      break;
    }
    const [name, description] = text.split(/\s+[—–]\s+/u, 2);
    options.push({
      ...(description !== undefined && description !== ""
        ? { description }
        : {}),
      name: name ?? text,
      value: String(options.length + 1),
    });
  }
  return options;
};

// ponytail: parse numbered ask-user lists only; other prompts need structured ACP choices.
const parsedAskUserOptions = (
  interaction: ThreadInteraction
):
  | { answer: ElicitationField; choices: ElicitationField; question: string }
  | undefined => {
  if (
    interaction.kind !== "elicitation" ||
    interaction.fields.length !== 1 ||
    interaction.fields[0]?.type !== "text"
  ) {
    return undefined;
  }
  const lines = interaction.message.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) =>
    /^\s*Options\s*\((?<mode>[^)]*)\)\s*:\s*$/iu.test(line)
  );
  if (headingIndex === -1) {
    return undefined;
  }
  const mode = /^\s*Options\s*\((?<mode>[^)]*)\)\s*:\s*$/iu.exec(
    lines[headingIndex] ?? ""
  )?.groups?.mode;
  const options = numberedOptions(lines.slice(headingIndex + 1));
  const question = lines.slice(0, headingIndex).join("\n").trim();
  if (options.length < 2 || question === "") {
    return undefined;
  }
  const multiple = /one or more|multiple|any/iu.test(mode ?? "");
  return {
    answer: interaction.fields[0],
    choices: {
      label: multiple ? "Options · choose any" : "Options · choose one",
      name: INLINE_OPTIONS,
      options,
      required: false,
      type: multiple ? "multiselect" : "select",
    },
    question,
  };
};

const CustomResponse = ({
  field,
}: {
  field: ElicitationField;
}): React.JSX.Element => (
  <div className="interaction-custom-response">
    <label className="interaction-field">
      <span className="interaction-field-label">{field.label}</span>
      <FieldDescription>Optional additional info or options</FieldDescription>
      <textarea
        id="interaction-custom-response"
        defaultValue={
          typeof field.defaultValue === "string" ? field.defaultValue : ""
        }
        name={field.name}
        rows={1}
        onInput={(event) => {
          resizeTextarea(event.currentTarget);
        }}
      />
    </label>
  </div>
);

const FormField = ({
  field,
}: {
  field: ElicitationField;
}): React.JSX.Element => {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (
    field.type === "text" &&
    !field.required &&
    (field.name === "other" || field.label.toLowerCase() === "custom response")
  ) {
    return <CustomResponse field={field} />;
  }
  if (field.type === "select" || field.type === "multiselect") {
    let defaultValues: string[] = [];
    if (Array.isArray(field.defaultValue)) {
      defaultValues = field.defaultValue;
    } else if (field.defaultValue !== undefined) {
      defaultValues = [String(field.defaultValue)];
    }
    const defaults = new Set(defaultValues);
    const multiple = field.type === "multiselect";
    const focusIndex = Math.max(
      0,
      field.options?.findIndex((item) => defaults.has(item.value)) ?? 0
    );
    return (
      <fieldset className="interaction-field interaction-choices">
        <legend>{label}</legend>
        <FieldDescription>{field.description}</FieldDescription>
        <div className="interaction-choice-list">
          {field.options?.map((item, index) => (
            <label className="interaction-choice" key={item.value}>
              <input
                autoFocus={index === focusIndex}
                defaultChecked={defaults.has(item.value)}
                name={field.name}
                required={field.required && !multiple}
                type={multiple ? "checkbox" : "radio"}
                value={item.value}
              />
              <ChoiceIcon multiple={multiple} />
              <span className="interaction-choice-copy">
                <span className="interaction-choice-title">{item.name}</span>
                <FieldDescription>{item.description}</FieldDescription>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="interaction-field interaction-choice interaction-boolean">
        <input
          defaultChecked={Boolean(field.defaultValue)}
          name={field.name}
          type="checkbox"
        />
        <ChoiceIcon multiple />
        <span className="interaction-choice-copy">
          <span className="interaction-field-label">{label}</span>
          <FieldDescription>{field.description}</FieldDescription>
        </span>
      </label>
    );
  }
  return (
    <label className="interaction-field">
      <span className="interaction-field-label">{label}</span>
      <FieldDescription>{field.description}</FieldDescription>
      {field.type === "number" ? (
        <input
          defaultValue={
            typeof field.defaultValue === "number" ? field.defaultValue : ""
          }
          name={field.name}
          required={field.required}
          type="number"
        />
      ) : (
        <textarea
          defaultValue={
            typeof field.defaultValue === "string" ? field.defaultValue : ""
          }
          name={field.name}
          required={field.required}
          rows={3}
        />
      )}
    </label>
  );
};

const Question = ({ children }: { children: string }): React.JSX.Element => (
  <h2 className="interaction-question" id="interaction-question">
    {children}
  </h2>
);

const Context = ({ children }: { children: string }): React.JSX.Element => (
  <div className="interaction-context">
    <span className="interaction-context-label">Context</span>
    <span>{children}</span>
  </div>
);

const formValues = (
  form: HTMLFormElement,
  fields: ElicitationField[]
): Record<string, unknown> => {
  const data = new FormData(form);
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "boolean") {
      values[field.name] = data.has(field.name);
    } else if (field.type === "multiselect") {
      const selected = data.getAll(field.name).map(String);
      if (field.required || selected.length) {
        values[field.name] = selected;
      }
    } else {
      const value = data.get(field.name);
      if (typeof value === "string" && (field.required || value !== "")) {
        values[field.name] = value;
      }
    }
  }
  return values;
};

const cancel = (id: string): void => {
  postMessage({ id, response: { action: "cancel" }, type: "respond" });
};

export const Interaction = ({
  interaction,
}: {
  interaction?: ThreadInteraction;
}): React.JSX.Element | null => {
  const dialog = useRef<HTMLElement>(null);
  const [missingAnswer, setMissingAnswer] = useState(false);
  useEffect(() => {
    setMissingAnswer(false);
    dialog.current
      ?.querySelector<HTMLElement>("input, textarea, button")
      ?.focus();
  }, [interaction?.id]);

  if (!interaction) {
    return null;
  }
  const askOptions = parsedAskUserOptions(interaction);
  const customResponseField = askOptions
    ? { ...askOptions.answer, label: "Custom response", required: false }
    : undefined;
  let elicitationFields: ElicitationField[] = [];
  if (askOptions && customResponseField) {
    elicitationFields = [askOptions.choices, customResponseField];
  } else if (interaction.kind === "elicitation") {
    elicitationFields = interaction.fields;
  }
  const question = (
    <>
      <div className="interaction-heading">
        <SvgIcon kind="question" />
        <span>Agent request</span>
      </div>
      <Question>{askOptions?.question ?? interaction.message}</Question>
      {interaction.kind === "elicitation" && isNonEmpty(interaction.context) ? (
        <Context>{interaction.context}</Context>
      ) : null}
    </>
  );
  return (
    <div className="interaction-overlay">
      <section
        aria-labelledby="interaction-question"
        id="interaction"
        ref={dialog}
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel(interaction.id);
          }
        }}
      >
        {interaction.kind === "permission" ? (
          <>
            <div className="interaction-body">
              {question}
              <div className="interaction-permission-options">
                {interaction.options.map((item) => (
                  <ActionButton
                    primary={item.kind.startsWith("allow")}
                    key={item.id}
                    onClick={() => {
                      postMessage({
                        id: interaction.id,
                        response: { action: "select", optionId: item.id },
                        type: "respond",
                      });
                    }}
                  >
                    {item.name}
                  </ActionButton>
                ))}
              </div>
            </div>
            <div className="interaction-actions">
              <ActionButton
                danger
                icon="x"
                onClick={() => {
                  cancel(interaction.id);
                }}
              >
                Cancel
              </ActionButton>
            </div>
          </>
        ) : (
          <form
            className="interaction-form"
            onSubmit={(event) => {
              event.preventDefault();
              const values = formValues(event.currentTarget, elicitationFields);
              if (askOptions && customResponseField) {
                const selections = values[INLINE_OPTIONS];
                let selectedValues: string[] = [];
                if (Array.isArray(selections)) {
                  selectedValues = selections.map(String);
                } else if (typeof selections === "string") {
                  selectedValues = [selections];
                }
                const selectedNames = selectedValues.map(
                  (value) =>
                    askOptions.choices.options?.find(
                      (option) => option.value === value
                    )?.name ?? value
                );
                const custom = values[customResponseField.name];
                const answer = [
                  ...selectedNames,
                  ...(typeof custom === "string" && isNonEmpty(custom)
                    ? [custom]
                    : []),
                ].join(", ");
                if (askOptions.answer.required && answer === "") {
                  setMissingAnswer(true);
                  return;
                }
                const responseValues = Object.fromEntries(
                  Object.entries(values).filter(
                    ([name]) =>
                      name !== INLINE_OPTIONS && name !== askOptions.answer.name
                  )
                );
                if (answer !== "" || askOptions.answer.required) {
                  responseValues[askOptions.answer.name] = answer;
                }
                setMissingAnswer(false);
                postMessage({
                  id: interaction.id,
                  response: { action: "accept", values: responseValues },
                  type: "respond",
                });
                return;
              }
              postMessage({
                id: interaction.id,
                response: { action: "accept", values },
                type: "respond",
              });
            }}
          >
            <div className="interaction-body">
              {question}
              <div
                onChange={() => {
                  setMissingAnswer(false);
                }}
              >
                {elicitationFields.map((field) => (
                  <FormField field={field} key={field.name} />
                ))}
                {missingAnswer ? (
                  <div className="interaction-validation" role="alert">
                    Choose an option or add a custom response.
                  </div>
                ) : null}
              </div>
            </div>
            <div className="interaction-actions">
              <ActionButton icon="send" primary type="submit">
                Submit
              </ActionButton>
              <ActionButton
                danger
                icon="x"
                onClick={() => {
                  cancel(interaction.id);
                }}
              >
                Cancel
              </ActionButton>
            </div>
          </form>
        )}
      </section>
    </div>
  );
};
