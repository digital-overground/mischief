import type {
  ElicitationField,
  ThreadInteraction,
} from "../../../threads/threads";
import { postMessage } from "../../bridge";

const ActionButton = ({
  children,
  primary = false,
  type = "button",
  onClick,
}: {
  children: React.ReactNode;
  primary?: boolean;
  type?: "button" | "submit";
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}): React.JSX.Element => (
  <button
    className={`action${primary ? " primary" : ""}`}
    type={type}
    onClick={onClick}
  >
    {children}
  </button>
);

const FormField = ({
  field,
}: {
  field: ElicitationField;
}): React.JSX.Element => {
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.type === "select" || field.type === "multiselect") {
    let defaults: string[] = [];
    if (Array.isArray(field.defaultValue)) {
      defaults = field.defaultValue;
    } else if (field.defaultValue !== undefined) {
      defaults = [String(field.defaultValue)];
    }
    return (
      <label>
        {label}
        <select
          name={field.name}
          multiple={field.type === "multiselect"}
          required={field.required && field.type !== "multiselect"}
          title={field.description}
          defaultValue={
            field.type === "multiselect" ? defaults : (defaults[0] ?? "")
          }
        >
          {!field.required && field.type === "select" ? (
            <option value="" />
          ) : null}
          {field.options?.map((item) => (
            <option value={item.value} key={item.value}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "boolean") {
    return (
      <label>
        {label}
        <input
          name={field.name}
          type="checkbox"
          title={field.description}
          defaultChecked={Boolean(field.defaultValue)}
        />
      </label>
    );
  }
  if (field.type === "number") {
    return (
      <label>
        {label}
        <input
          name={field.name}
          type="number"
          required={field.required}
          title={field.description}
          defaultValue={
            typeof field.defaultValue === "number" ? field.defaultValue : ""
          }
        />
      </label>
    );
  }
  return (
    <label>
      {label}
      <textarea
        name={field.name}
        rows={2}
        required={field.required}
        title={field.description}
        defaultValue={
          typeof field.defaultValue === "string" ? field.defaultValue : ""
        }
      />
    </label>
  );
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
        <div className="message">{interaction.message}</div>
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
      <div className="message">{interaction.message}</div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const values: Record<string, unknown> = {};
          for (const field of interaction.fields) {
            const input = event.currentTarget.elements.namedItem(field.name);
            if (!(input instanceof HTMLElement)) {
              continue;
            }
            if (field.type === "boolean" && input instanceof HTMLInputElement) {
              values[field.name] = input.checked;
            } else if (
              field.type === "multiselect" &&
              input instanceof HTMLSelectElement
            ) {
              values[field.name] = [...input.selectedOptions].map(
                (item) => item.value
              );
            } else if (
              (input instanceof HTMLInputElement ||
                input instanceof HTMLSelectElement ||
                input instanceof HTMLTextAreaElement) &&
              (field.required || input.value !== "")
            ) {
              values[field.name] = input.value;
            }
          }
          postMessage({
            id: interaction.id,
            response: { action: "accept", values },
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
