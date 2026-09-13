import type {
  ElicitationField,
  ThreadInteraction,
} from "../../../threads/threads";
import { postMessage } from "../../bridge";
import { SvgIcon } from "../../icon";

const ActionButton = ({
  children,
  primary = false,
  type = "button",
  onClick,
}: {
  children: string;
  primary?: boolean;
  type?: "button" | "submit";
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element => (
  <button
    className={`action${primary ? " primary" : ""}`}
    type={type}
    title={children}
    onClick={onClick}
  >
    {children}
  </button>
);

const FieldDescription = ({
  children,
}: {
  children?: string;
}): React.JSX.Element | null =>
  children ? (
    <span className="interaction-field-description">{children}</span>
  ) : null;

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
    const inputType = field.type === "multiselect" ? "checkbox" : "radio";
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
                required={field.required && field.type === "select"}
                type={inputType}
                value={item.value}
              />
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
      <label className="interaction-field interaction-boolean">
        <input
          defaultChecked={Boolean(field.defaultValue)}
          name={field.name}
          type="checkbox"
        />
        <span>
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
  <div className="interaction-question">
    <SvgIcon kind="question" />
    <div className="message">{children}</div>
  </div>
);

const Context = ({ children }: { children: string }): React.JSX.Element => (
  <div className="interaction-context">
    <span className="interaction-context-label">Context:</span>
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
}): React.JSX.Element => {
  if (!interaction) {
    return <div id="interaction" />;
  }
  if (interaction.kind === "permission") {
    return (
      <div id="interaction">
        <Question>{interaction.message}</Question>
        <div className="interaction-buttons">
          {interaction.options.map((item) => (
            <ActionButton
              primary={item.kind.startsWith("allow")}
              key={item.id}
              onClick={() =>
                postMessage({
                  id: interaction.id,
                  response: { action: "select", optionId: item.id },
                  type: "respond",
                })
              }
            >
              {item.name}
            </ActionButton>
          ))}
          <ActionButton onClick={() => cancel(interaction.id)}>
            Cancel
          </ActionButton>
        </div>
      </div>
    );
  }
  return (
    <div id="interaction">
      <Question>{interaction.message}</Question>
      {interaction.context ? <Context>{interaction.context}</Context> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          postMessage({
            id: interaction.id,
            response: {
              action: "accept",
              values: formValues(event.currentTarget, interaction.fields),
            },
            type: "respond",
          });
        }}
      >
        {interaction.fields.map((field) => (
          <FormField field={field} key={field.name} />
        ))}
        <div className="interaction-buttons">
          <ActionButton primary type="submit">
            Submit
          </ActionButton>
          <ActionButton onClick={() => cancel(interaction.id)}>
            Cancel
          </ActionButton>
        </div>
      </form>
    </div>
  );
};
