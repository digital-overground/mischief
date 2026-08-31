import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

import type {
  ThreadConfigChoice,
  ThreadConfigOption,
  ThreadUsage,
} from "../threads/threads";
import { postMessage } from "./bridge";
import { Icon, SvgIcon } from "./icon";
import type { RenderedThreadDetail } from "./protocol";

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
      optionNode(entry.options[0] as ThreadConfigChoice, kind)
    )
  );
};

const ConfigControl = ({
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

const formatUsage = (value: number): string =>
  value < 1000 ? String(value) : `${Math.round(value / 1000)}k`;

const usageClass = (percent: number): string => {
  if (percent >= 90) {
    return "danger";
  }
  return percent >= 70 ? "warning" : "";
};

const UsageControl = ({
  usage: { size, used },
}: {
  usage: ThreadUsage;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (): void => setOpen(false);
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const percent = Math.round((used / size) * 100);
  const danger = usageClass(percent);
  return (
    <div id="usage-control">
      <button
        className="action"
        id="usage"
        title="Show context usage"
        aria-label={`Context usage ${percent}%`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span
          id="usage-fill"
          className={danger}
          aria-hidden="true"
          style={
            { "--usage-percent": `${Math.min(100, percent)}%` } as CSSProperties
          }
        />
      </button>
      <div
        id="usage-menu"
        role="dialog"
        aria-label="Context usage details"
        hidden={!open}
      >
        <div id="usage-summary">
          {percent}% · {formatUsage(used)} / {formatUsage(size)}
        </div>
        <button
          className="action primary"
          id="compact"
          type="button"
          onClick={() => {
            postMessage({ images: [], text: "/compact", type: "prompt" });
            setOpen(false);
          }}
        >
          Compact context
        </button>
      </div>
    </div>
  );
};

const HistoryControl = ({
  selected,
}: {
  selected?: RenderedThreadDetail;
}): React.JSX.Element => {
  const messages = selected?.items.filter((item) => item.kind === "user") ?? [];
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    bottom: number;
    left: number;
    width: number;
  }>();
  const [selectedMessage, setSelectedMessage] = useState<string>();

  useLayoutEffect(() => {
    if (position && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
      list.current.focus();
    }
  }, [position]);

  useEffect(() => {
    if (!position) {
      return;
    }
    const close = (): void => {
      setPosition(undefined);
      setSelectedMessage(undefined);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, [position]);

  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (position) {
      setPosition(undefined);
      setSelectedMessage(undefined);
      return;
    }
    setSelectedMessage(undefined);
    const left = Math.min(event.clientX, window.innerWidth - 510);
    setPosition({
      bottom:
        window.innerHeight -
        event.currentTarget.getBoundingClientRect().top +
        4,
      left,
      width: window.innerWidth - left - 10,
    });
  };

  return (
    <div id="history-control">
      <button
        className="action"
        id="history"
        title="User message history"
        aria-controls="history-list"
        aria-expanded={Boolean(position)}
        disabled={!messages.length}
        onClick={toggle}
      >
        <SvgIcon kind="history" />
      </button>
      {position ? (
        <div
          id="history-list"
          ref={list}
          role="dialog"
          aria-label="User message history"
          tabIndex={-1}
          style={position}
          onClick={(event) => event.stopPropagation()}
        >
          {messages.map((message) => (
            <div className="history-entry" key={message.id}>
              <button
                className="history-message"
                title={message.text}
                type="button"
                aria-expanded={selectedMessage === message.id}
                onClick={() =>
                  setSelectedMessage((current) =>
                    current === message.id ? undefined : message.id
                  )
                }
              >
                {message.text}
              </button>
              {selectedMessage === message.id ? (
                <div className="history-actions">
                  <button
                    className="action"
                    type="button"
                    disabled={selected?.status !== "idle"}
                    onClick={() => {
                      postMessage({ id: message.id, type: "forkThread" });
                      setPosition(undefined);
                    }}
                  >
                    Fork
                  </button>
                  <button
                    className="action"
                    type="button"
                    onClick={() => {
                      postMessage({ id: message.id, type: "rollbackThread" });
                      setPosition(undefined);
                    }}
                  >
                    Rollback
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const FooterControls = ({
  onNewThread,
  onSend,
  selected,
  workspace,
}: {
  onNewThread: () => void;
  onSend: () => void;
  selected?: RenderedThreadDetail;
  workspace?: string;
}): React.JSX.Element => {
  const running = Boolean(
    selected && ["running", "waiting"].includes(selected.status)
  );
  return (
    <div className="footer-row">
      <button
        className="action"
        id="footer-new-thread"
        title="New Thread"
        aria-label="New Thread"
        disabled={!workspace}
        onClick={onNewThread}
      >
        <SvgIcon kind="chat" />
      </button>
      <HistoryControl
        selected={selected}
        key={`history:${selected?.id ?? "none"}`}
      />
      {selected?.usage && selected.usage.size > 0 ? (
        <UsageControl usage={selected.usage} key={selected.id} />
      ) : null}
      <div id="configs">
        {selected?.configOptions.map((config) => (
          <ConfigControl
            config={config}
            key={`${config.id}:${config.currentValue}`}
          />
        ))}
      </div>
      <button
        className={`action${running ? " stop" : ""}`}
        id="send"
        title={running ? "Stop" : "Send"}
        aria-label={running ? "Stop" : "Send"}
        disabled={!selected}
        onClick={onSend}
      >
        <SvgIcon className="send-icon" kind="send" />
        <SvgIcon className="stop-icon" kind="stop" />
      </button>
    </div>
  );
};
