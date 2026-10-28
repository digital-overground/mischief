import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentStatus } from "../agents/manager";
import { isAgentId } from "../agents/update";
import type { AgentId } from "../agents/update";
import { AgentIcon } from "./agent-icon";
import { postMessage } from "./bridge";
import { SvgIcon } from "./icon";
import type { HostToWebviewMessage } from "./protocol";

const agentStatus: Record<AgentStatus["state"], string> = {
  checking: "Checking for updates…",
  current: "Up to date",
  installing: "Installing…",
  missing: "Not installed",
  newer: "Newer than published release",
  unknown: "Could not check for updates",
  updateAvailable: "Update available",
  waiting: "Not connected yet",
};

const DefaultAgentControl = ({
  agents,
  icons,
  value,
  onChange,
}: {
  agents: AgentStatus[];
  icons?: Partial<Record<AgentId, string>>;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element => {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const label =
    agents.find((agent) => agent.id === value)?.name ?? "Choose each time";
  const options = [{ id: "", name: "Choose each time" }, ...agents];

  useLayoutEffect(() => {
    if (open) {
      menu.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus();
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

  const select = (id: string): void => {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="settings-agent-picker">
      <button
        ref={trigger}
        id="default-agent"
        type="button"
        className="config-trigger"
        title="Default Agent"
        aria-label={`Default Agent: ${label}`}
        aria-describedby="default-agent-description"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setOpen(true);
        }}
      >
        <span className="config-trigger-label">{label}</span>
      </button>
      {open ? (
        <div
          ref={menu}
          className="config-menu default-agent-menu"
          role="listbox"
          aria-label="Default Agent"
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
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="option"]'
                ),
              ];
              const index =
                document.activeElement instanceof HTMLElement
                  ? items.indexOf(document.activeElement)
                  : -1;
              let next = (index + 1) % items.length;
              if (event.key === "Home") {
                next = 0;
              } else if (event.key === "End") {
                next = items.length - 1;
              } else if (event.key === "ArrowUp") {
                next = (index + items.length - 1) % items.length;
              }
              items[next]?.focus();
              items[next]?.scrollIntoView?.({ block: "nearest" });
            }
          }}
          onBlur={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget) &&
              trigger.current?.contains(event.relatedTarget) !== true
            ) {
              setOpen(false);
            }
          }}
        >
          <div className="config-menu-title">Default Agent</div>
          {options.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="option"
              aria-selected={agent.id === value}
              tabIndex={-1}
              onClick={() => {
                select(agent.id);
              }}
            >
              <span className="config-menu-check">
                {agent.id === value ? "✓" : ""}
              </span>
              {isAgentId(agent.id) ? (
                <AgentIcon id={agent.id} icons={icons} />
              ) : null}
              {agent.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const SettingsDialog = ({
  icons,
}: {
  icons?: Partial<Record<AgentId, string>>;
}): React.JSX.Element => {
  const [assignWorkspaceColors, setAssignWorkspaceColors] = useState(true);
  const [todoEnabled, setTodoEnabled] = useState<boolean | undefined>();
  const [defaultAgent, setDefaultAgent] = useState("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<HostToWebviewMessage>): void => {
      if (event.data.type === "showSettings") {
        setAssignWorkspaceColors(event.data.assignWorkspaceColors);
        setTodoEnabled(event.data.todoExtensionEnabled);
        setDefaultAgent(event.data.defaultAgent);
        setAgents(event.data.agents);
        if (dialog.current && !dialog.current.open) {
          dialog.current.showModal();
        }
      } else if (event.data.type === "agents") {
        setAgents(event.data.agents);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
    };
  }, []);

  return (
    <dialog id="settings-dialog" ref={dialog} aria-labelledby="settings-title">
      <div className="settings-header">
        <h2 id="settings-title">Mischief Settings</h2>
        <button
          className="icon"
          type="button"
          title="Close Settings"
          aria-label="Close Settings"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </div>
      <label className="settings-option">
        <input
          type="checkbox"
          checked={assignWorkspaceColors}
          aria-describedby="assign-workspace-colors-description"
          onChange={(event) => {
            const value = event.currentTarget.checked;
            setAssignWorkspaceColors(value);
            postMessage({ type: "setAssignWorkspaceColors", value });
          }}
        />
        <span>
          <span className="settings-name">Assign Workspace window colors</span>
          <span
            className="settings-description"
            id="assign-workspace-colors-description"
          >
            Automatically assigns colors from the active theme to Workspace
            windows that do not already define them.
          </span>
        </span>
      </label>
      <label className="settings-option">
        <input
          type="checkbox"
          checked={todoEnabled === true}
          disabled={todoEnabled === undefined}
          aria-describedby="todo-extension-description"
          onChange={(event) => {
            postMessage({
              type: "setTodoExtensionEnabled",
              value: event.currentTarget.checked,
            });
          }}
        />
        <span>
          <span className="settings-name">Pi Todo extension</span>
          <span
            className="settings-description"
            id="todo-extension-description"
          >
            {todoEnabled === undefined
              ? "Not installed. Run pi install npm:@juicesharp/rpiv-todo to enable."
              : "Controls the shared Pi installation, including terminal Pi. Takes effect in new or reloaded Agent sessions."}
          </span>
        </span>
      </label>
      <div className="settings-option default-agent-option">
        <span>
          <span className="settings-name">Default Agent</span>
          <span className="settings-description" id="default-agent-description">
            Used for new Threads. Existing Threads keep their Agent.
          </span>
        </span>
        <DefaultAgentControl
          agents={agents}
          icons={icons}
          value={defaultAgent}
          onChange={(id) => {
            setDefaultAgent(id);
            postMessage({ id, type: "setDefaultAgent" });
          }}
        />
      </div>
      <section className="settings-agents" aria-labelledby="agents-title">
        <h3 id="agents-title">Agents</h3>
        <div aria-live="polite">
          {agents.map((agent) => (
            <div className="settings-agent" key={agent.id}>
              <span className="settings-name">{agent.name}</span>
              <span className="settings-description">
                {agent.installedVersion === undefined
                  ? ""
                  : `Installed ${agent.installedVersion} · `}
                {agent.latestVersion === undefined
                  ? ""
                  : `Latest ${agent.latestVersion} · `}
                {agent.error ?? agentStatus[agent.state]}
              </span>
              <button
                className={`action${agent.managed === true ? "" : " primary"}`}
                type="button"
                aria-label={
                  agent.managed === true
                    ? `Check ${agent.name} for updates`
                    : `Install ${agent.name} managed`
                }
                disabled={
                  agent.state === "checking" || agent.state === "installing"
                }
                onClick={() => {
                  postMessage({
                    id: agent.id,
                    type:
                      agent.managed === true ? "checkAgent" : "installAgent",
                  });
                }}
              >
                {agent.managed === true ? null : (
                  <SvgIcon
                    className="interaction-action-icon"
                    kind="download"
                  />
                )}
                {agent.managed === true
                  ? "Check for updates"
                  : "Install managed"}
              </button>
            </div>
          ))}
        </div>
        <p className="settings-description">
          Managed Agents install in Mischief storage. After you approve an
          install, Mischief updates it automatically; running Threads keep their
          current process.
        </p>
      </section>
    </dialog>
  );
};
