import { useEffect, useRef } from "react";

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

const FormField = ({
  field,
}: {
  field: ElicitationField;
}): React.JSX.Element => {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.type === "select" || field.type === "multiselect") {
    let defaultValues: string[] = [];
    if (Array.isArray(field.defaultValue)) {
      defaultValues = field.defaultValue;
    } else if (field.defaultValue !== undefined) {
      defaultValues = [String(field.defaultValue)];
    }
    const defaults = new Set(defaultValues);
    const multiple = field.type === "multiselect";
    return (
      <fieldset className="interaction-field interaction-choices">
        <legend>{label}</legend>
        <FieldDescription>{field.description}</FieldDescription>
        <div className="interaction-choice-list">
          {field.options?.map((item) => (
            <label className="interaction-choice" key={item.value}>
              <input
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

// oxlint-disable-next-line complexity -- ACP forms and parsed ask_user choices share one submission path
export const respondToElicitation = (
  interaction: ThreadInteraction,
  text: string
): boolean => {
  if (interaction.kind !== "elicitation") {
    return false;
  }
  const form = document.querySelector<HTMLFormElement>("#interaction-form");
  if (form === null || !form.reportValidity()) {
    return false;
  }
  const askOptions = parsedAskUserOptions(interaction);
  const customField = interaction.fields.find(
    (field) =>
      field.type === "text" &&
      !field.required &&
      (field.name === "other" ||
        field.label.toLowerCase() === "custom response")
  );
  const textAnswer =
    !askOptions &&
    interaction.fields.length === 1 &&
    interaction.fields[0]?.type === "text"
      ? interaction.fields[0]
      : undefined;
  const fields = askOptions
    ? [askOptions.choices]
    : interaction.fields.filter(
        (field) => field !== customField && field !== textAnswer
      );
  const values = formValues(form, fields);
  if (askOptions) {
    const selected = values[INLINE_OPTIONS];
    let selectedValues: unknown[] = [];
    if (Array.isArray(selected)) {
      selectedValues = selected;
    } else if (typeof selected === "string") {
      selectedValues = [selected];
    }
    const names = selectedValues.map(
      (value) =>
        askOptions.choices.options?.find((option) => option.value === value)
          ?.name ?? String(value)
    );
    const answer = [
      ...names,
      ...(isNonEmpty(text.trim()) ? [text.trim()] : []),
    ].join(", ");
    if (askOptions.answer.required && !answer) {
      return false;
    }
    const responseValues = Object.fromEntries(
      Object.entries(values).filter(([key]) => key !== INLINE_OPTIONS)
    );
    if (answer) {
      responseValues[askOptions.answer.name] = answer;
    }
    postMessage({
      id: interaction.id,
      response: { action: "accept", values: responseValues },
      type: "respond",
    });
    return true;
  } else if (textAnswer) {
    if (textAnswer.required && !isNonEmpty(text.trim())) {
      return false;
    }
    if (isNonEmpty(text.trim())) {
      values[textAnswer.name] = text.trim();
    }
  } else if (customField && isNonEmpty(text.trim())) {
    values[customField.name] = text.trim();
  } else if (isNonEmpty(text.trim())) {
    // shortcut: generic forms without a text field cannot carry composer context; add a protocol field if needed.
    return false;
  }
  postMessage({
    id: interaction.id,
    response: { action: "accept", values },
    type: "respond",
  });
  return true;
};

const cancel = (interaction: ThreadInteraction): void => {
  if (interaction.kind === "elicitation") {
    postMessage({ type: "cancel" });
  } else {
    postMessage({
      id: interaction.id,
      response: { action: "cancel" },
      type: "respond",
    });
  }
};

export const InteractionQuestion = ({
  interaction,
}: {
  interaction: ThreadInteraction;
}): React.JSX.Element => (
  <div className="inline-interaction-question">
    <div className="interaction-heading">
      <SvgIcon kind="question" />
      <span>Agent request</span>
    </div>
    <Question>
      {parsedAskUserOptions(interaction)?.question ?? interaction.message}
    </Question>
    {interaction.kind === "elicitation" && isNonEmpty(interaction.context) ? (
      <Context>{interaction.context}</Context>
    ) : null}
  </div>
);

export const Interaction = ({
  interaction,
}: {
  interaction?: ThreadInteraction;
}): React.JSX.Element | null => {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (interaction?.kind === "permission") {
      dialog.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [interaction?.id, interaction?.kind]);

  if (!interaction) {
    return null;
  }
  const askOptions = parsedAskUserOptions(interaction);
  let elicitationFields: ElicitationField[] = [];
  if (askOptions) {
    elicitationFields = [askOptions.choices];
  } else if (interaction.kind === "elicitation") {
    elicitationFields = interaction.fields.filter(
      (field) =>
        !(
          field.type === "text" &&
          (interaction.fields.length === 1 ||
            (!field.required &&
              (field.name === "other" ||
                field.label.toLowerCase() === "custom response")))
        )
    );
  }
  const question = <InteractionQuestion interaction={interaction} />;
  return (
    <div
      className={
        interaction.kind === "permission"
          ? "interaction-overlay"
          : "interaction-inline"
      }
    >
      <section
        aria-labelledby="interaction-question"
        id="interaction"
        ref={dialog}
        role={interaction.kind === "permission" ? "dialog" : "region"}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel(interaction);
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
                  cancel(interaction);
                }}
              >
                Cancel
              </ActionButton>
            </div>
          </>
        ) : (
          <form
            className="interaction-form"
            id="interaction-form"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <div className="interaction-body">
              {elicitationFields.map((field) => (
                <FormField field={field} key={field.name} />
              ))}
            </div>
            <div className="interaction-actions">
              <ActionButton
                danger
                icon="x"
                onClick={() => {
                  cancel(interaction);
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
