import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AGENTS } from "../../../../../agents/update";
import type { AgentId } from "../../../../../agents/update";
import { isNonEmpty } from "../../../../../present";
import type {
  ThreadConfigChoice,
  ThreadConfigOption,
} from "../../../../../threads/model";
import { postMessage } from "../../../../bridge";
import { Icon, isIconKind } from "../../../../icon";

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

const menuOptions = (
  config: Extract<ThreadConfigOption, { type: "select" }>,
  kind: ReturnType<typeof configKind>
): { label?: string; options: ThreadConfigChoice[] }[] => {
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
  return ordered;
};

const SelectConfigControl = ({
  agentId,
  config,
}: {
  agentId: AgentId;
  config: Extract<ThreadConfigOption, { type: "select" }>;
}): React.JSX.Element => {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    bottom: 0,
    maxHeight: 320,
    right: 0,
    top: 0,
  });
  const kind = configKind(config);
  const groups = menuOptions(config, kind);
  const choices = groups.flatMap((group) => group.options);
  const current = choices.find(
    (choice) => choice.value === config.currentValue
  );
  let label = config.currentValue;
  if (current !== undefined) {
    label = optionName(current, kind);
  } else if (kind === "profile") {
    label = "Custom";
  }
  const icons: Record<string, string> = AGENTS[agentId].icons;
  const icon = icons[config.id];

  useLayoutEffect(() => {
    if (open) {
      const selected = menu.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]'
      );
      selected?.focus();
      selected?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open]);

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        menu.current?.contains(event.target) !== true &&
        trigger.current?.contains(event.target) !== true
      ) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("pointerdown", outside);
    }
    return () => {
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  const select = (value: string): void => {
    postMessage({ id: config.id, type: "setConfig", value });
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="config-control">
      {icon !== undefined && isIconKind(icon) ? (
        <Icon className="config-icon" kind={icon} title={config.name} />
      ) : null}
      <button
        ref={trigger}
        type="button"
        className="config-trigger"
        title={config.description ?? config.name}
        aria-label={config.name}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const bounds = trigger.current?.getBoundingClientRect();
          if (bounds) {
            const below = bounds.top < 120;
            setPosition({
              bottom: below ? 0 : window.innerHeight - bounds.top + 4,
              maxHeight: Math.max(
                80,
                Math.min(
                  320,
                  (below ? window.innerHeight - bounds.bottom : bounds.top) - 12
                )
              ),
              right: Math.max(8, window.innerWidth - bounds.right),
              top: below ? bounds.bottom + 4 : 0,
            });
          }
          setOpen(true);
        }}
      >
        <span className="config-trigger-label">{label}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menu}
              className="config-menu"
              role="listbox"
              aria-label={config.name}
              style={{
                bottom: position.top > 0 ? undefined : position.bottom,
                maxHeight: position.maxHeight,
                right: position.right,
                top: position.top > 0 ? position.top : undefined,
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  trigger.current?.focus();
                } else if (
                  (event.key === "Enter" || event.key === " ") &&
                  document.activeElement instanceof HTMLButtonElement
                ) {
                  event.preventDefault();
                  document.activeElement.click();
                } else if (
                  ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const options = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>(
                      '[role="option"]'
                    ),
                  ];
                  if (options.length === 0) {
                    return;
                  }
                  const index =
                    document.activeElement instanceof HTMLElement
                      ? options.indexOf(document.activeElement)
                      : -1;
                  let next = 0;
                  if (event.key === "End") {
                    next = options.length - 1;
                  } else if (event.key === "ArrowDown") {
                    next = (index + 1) % options.length;
                  } else if (event.key === "ArrowUp") {
                    next = (index + options.length - 1) % options.length;
                  }
                  options[next]?.focus();
                  options[next]?.scrollIntoView?.({ block: "nearest" });
                }
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setOpen(false);
                }
              }}
            >
              <div className="config-menu-title">{config.name}</div>
              {groups.map((group, index) => (
                <div
                  className="config-menu-group"
                  role="group"
                  aria-label={group.label ?? config.name}
                  key={`${group.label ?? ""}:${index}`}
                >
                  {isNonEmpty(group.label) ? (
                    <div className="config-menu-group-label">
                      <span>{group.label}</span>
                    </div>
                  ) : null}
                  {group.options.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      role="option"
                      aria-selected={choice.value === config.currentValue}
                      tabIndex={-1}
                      onClick={() => {
                        select(choice.value);
                      }}
                    >
                      <span className="config-menu-check">
                        {choice.value === config.currentValue ? "✓" : ""}
                      </span>
                      {optionName(choice, kind)}
                    </button>
                  ))}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
};

export const ConfigControl = ({
  agentId,
  config,
}: {
  agentId: AgentId;
  config: ThreadConfigOption;
}): React.JSX.Element => {
  if (config.type === "boolean") {
    return (
      <label
        title={
          config.description !== undefined && config.description.length > 0
            ? config.description
            : config.name
        }
      >
        <input
          type="checkbox"
          checked={config.currentValue}
          onChange={(event) => {
            postMessage({
              id: config.id,
              type: "setConfig",
              value: event.currentTarget.checked,
            });
          }}
        />
        {config.name}
      </label>
    );
  }
  return <SelectConfigControl agentId={agentId} config={config} />;
};
