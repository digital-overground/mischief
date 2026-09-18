import type { ReactNode } from "react";

import type {
  ThreadConfigChoice,
  ThreadConfigOption,
} from "../../../../../threads/threads";
import { postMessage } from "../../../../bridge";
import { Icon } from "../../../../icon";

const configKind = (
  config: ThreadConfigOption
): "model" | "profile" | "thinking" | "" => {
  const id = config.id.toLowerCase();
  const name = config.name.toLowerCase();
  if (id === "model" || name === "model") {
    return "model";
  }
  if (
    id === "role" ||
    id === "profile" ||
    name === "role" ||
    name === "profile"
  ) {
    return "profile";
  }
  return id === "thought_level" ||
    id === "thinking" ||
    name.includes("thinking")
    ? "thinking"
    : "";
};

const displayModelName = (name: string): string => {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(slash + 1) : name;
};

const optionName = (
  item: ThreadConfigChoice,
  kind: ReturnType<typeof configKind>
): string => {
  if (kind === "model") {
    return displayModelName(item.name);
  }
  return kind === "thinking"
    ? item.name.replace(/^Thinking:\s*/iu, "")
    : item.name;
};

const optionNode = (
  item: ThreadConfigChoice,
  kind: ReturnType<typeof configKind>
): React.JSX.Element => (
  <option value={item.value} key={item.value}>
    {optionName(item, kind)}
  </option>
);

const selectOptions = (
  config: Extract<ThreadConfigOption, { type: "select" }>,
  kind: ReturnType<typeof configKind>
): ReactNode[] => {
  const ordered: { label?: string; options: ThreadConfigChoice[] }[] = [];
  const providerGroups = new Map<
    string,
    { label: string; options: ThreadConfigChoice[] }
  >();
  for (const item of config.options) {
    if (!("value" in item)) {
      ordered.push({ label: item.name, options: item.options });
      continue;
    }
    const slash = kind === "model" ? item.name.indexOf("/") : -1;
    if (slash < 1) {
      ordered.push({ options: [item] });
      continue;
    }
    const provider = item.name.slice(0, slash);
    let group = providerGroups.get(provider);
    if (!group) {
      group = { label: provider, options: [] };
      providerGroups.set(provider, group);
      ordered.push(group);
    }
    group.options.push(item);
  }
  return ordered.map((entry, index) =>
    entry.label ? (
      <optgroup label={entry.label} key={`${entry.label}:${index}`}>
        {entry.options.map((item) => optionNode(item, kind))}
      </optgroup>
    ) : (
      optionNode(entry.options[0], kind)
    )
  );
};

export const ConfigControl = ({
  config,
}: {
  config: ThreadConfigOption;
}): React.JSX.Element => {
  if (config.type === "boolean") {
    return (
      <label title={config.description || config.name}>
        <input
          type="checkbox"
          checked={config.currentValue}
          onChange={(event) =>
            postMessage({
              id: config.id,
              type: "setConfig",
              value: event.currentTarget.checked,
            })
          }
        />
        {config.name}
      </label>
    );
  }
  const kind = configKind(config);
  const values = config.options.flatMap((item) =>
    "value" in item ? [item.value] : item.options.map((choice) => choice.value)
  );
  const customProfile =
    kind === "profile" && !values.includes(config.currentValue);
  const select = (
    <select
      title={config.description || config.name}
      aria-label={config.name}
      defaultValue={customProfile ? "" : config.currentValue}
      onChange={(event) =>
        postMessage({
          id: config.id,
          type: "setConfig",
          value: event.currentTarget.value,
        })
      }
    >
      {customProfile ? (
        <option value="" disabled>
          Custom
        </option>
      ) : null}
      {selectOptions(config, kind)}
    </select>
  );
  if (!kind) {
    return select;
  }
  const icon = { model: "bot", profile: "user", thinking: "brain" }[kind] as
    | "bot"
    | "user"
    | "brain";
  return (
    <div className="config-control">
      <Icon className="config-icon" kind={icon} title={config.name} />
      {select}
    </div>
  );
};
