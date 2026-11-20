import { useEffect, useRef, useState } from "react";

import { postMessage } from "./bridge";
import { SvgIcon } from "./icon";
import type { HostToWebviewMessage } from "./protocol";

type Setup = Extract<HostToWebviewMessage, { type: "showProjectSetup" }>;

const sensitive = (name: string): boolean =>
  /^(?:\.env(?:\..*)?|\.envrc(?:\.local)?|.*\.xcconfig)$/u.test(
    name.replace(/\/$/u, "").split("/").at(-1) ?? ""
  );

const Info = ({ text }: { text: string }): React.JSX.Element => (
  <button className="setup-info" type="button" aria-label={text} title={text}>
    ⓘ
  </button>
);

const IgnoredFiles = ({
  creating,
  entries,
  selected,
  onChange,
}: {
  creating: boolean;
  entries: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}): React.JSX.Element => {
  const renderEntry = (entry: string): React.JSX.Element => (
    <label className="settings-option" key={entry}>
      <input
        type="checkbox"
        checked={selected.includes(entry)}
        onChange={(event) => {
          onChange(
            event.currentTarget.checked
              ? [...selected, entry]
              : selected.filter((name) => name !== entry)
          );
        }}
      />
      <span className="settings-name">{entry}</span>
    </label>
  );
  const prioritized = entries.filter(sensitive);
  const ordinary = entries.filter((entry) => !sensitive(entry));
  return (
    <>
      <section className="project-setup-common">
        {creating ? (
          <h4>Commonly copied files</h4>
        ) : (
          <h5>Commonly copied files</h5>
        )}
        {prioritized.length > 0 ? (
          prioritized.map(renderEntry)
        ) : (
          <p className="settings-description">
            No commonly copied files found.
          </p>
        )}
      </section>
      {ordinary.length > 0 ? (
        <details>
          <summary>
            {creating ? (
              <h4>Other ignored items ({ordinary.length})</h4>
            ) : (
              <h5>Other ignored items ({ordinary.length})</h5>
            )}
          </summary>
          {ordinary.map(renderEntry)}
        </details>
      ) : null}
    </>
  );
};

const SetupDialog = ({
  creating,
}: {
  creating: boolean;
}): React.JSX.Element => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const id = creating ? "new-workspace-dialog" : "project-setup-dialog";

  useEffect(() => {
    const receive = (event: MessageEvent<HostToWebviewMessage>): void => {
      if (
        event.data.type !== "showProjectSetup" ||
        event.data.creating !== creating
      ) {
        return;
      }
      setSetup(event.data);
      setSelected(event.data.selected);
      setCommand(event.data.command);
      if (dialog.current && !dialog.current.open) {
        dialog.current.showModal();
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
    };
  }, [creating]);

  const dismiss = (): void => {
    dialog.current?.close();
  };

  return (
    <dialog
      id={id}
      ref={dialog}
      aria-labelledby={`${id}-title`}
      onClose={() => {
        if (setup) {
          postMessage({ project: setup.project, type: "dismissProjectSetup" });
        }
      }}
    >
      <div className="settings-header">
        <h2 id={`${id}-title`}>
          {creating ? "New Workspace" : "Project Settings"}
        </h2>
        <button
          className="icon"
          type="button"
          aria-label="Close setup"
          title="Close setup"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      {creating ? (
        <section className="project-setup-section workspace-preview">
          <h3>Workspace details</h3>
          <div className="workspace-preview-row">
            <SvgIcon kind="folder" />
            <div>
              <strong>Worktree location:</strong>
              <span className="workspace-preview-path">
                {setup?.workspace?.path}
              </span>
            </div>
          </div>
          <div className="workspace-preview-row">
            <SvgIcon kind="gitBranch" />
            <div>
              <strong>Branch:</strong> {setup?.workspace?.branch}
            </div>
          </div>
        </section>
      ) : null}
      {setup?.review === true ? (
        <p className="project-setup-warning" role="alert">
          Project settings inputs or the command have changed. Verify these
          settings before proceeding.
        </p>
      ) : null}
      {creating ? null : (
        <h3 className="project-setup-group">New Workspaces</h3>
      )}
      <section className="project-setup-section">
        {creating ? (
          <h3>Files to be copied</h3>
        ) : (
          <h4>
            Ignored Files to Copy{" "}
            <Info text="Copy these currently gitignored files to new Workspaces" />
          </h4>
        )}
        <IgnoredFiles
          creating={creating}
          entries={setup?.entries ?? []}
          selected={selected}
          onChange={setSelected}
        />
      </section>
      <section className="project-setup-section project-setup-command">
        {creating ? (
          <h3>Commands to run</h3>
        ) : (
          <h4>
            Setup Commands{" "}
            <Info text="Run these commands in the new Workspace terminal after it opens." />
          </h4>
        )}
        {creating ? null : (
          <div className="setup-suggestions">
            <h5>Detected setup commands:</h5>
            {setup?.suggestions.map((suggestion) => (
              <button
                className="action"
                key={suggestion}
                type="button"
                onClick={() => {
                  setCommand(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        <textarea
          aria-label={creating ? "Commands to run" : "Setup Commands"}
          value={command}
          rows={4}
          onChange={(event) => {
            setCommand(event.currentTarget.value);
          }}
        />
      </section>
      <div className="project-setup-actions">
        <button
          className="action"
          title="Cancel setup"
          type="button"
          onClick={dismiss}
        >
          Cancel
        </button>
        <button
          className="action primary"
          title={creating ? "Add Workspace" : "Save Project Settings"}
          type="button"
          onClick={() => {
            if (setup) {
              postMessage({
                command,
                project: setup.project,
                selected,
                type: "saveProjectSetup",
              });
              dismiss();
            }
          }}
        >
          {creating ? "Add Workspace" : "Save"}
        </button>
      </div>
    </dialog>
  );
};

export const ProjectSetupDialog = (): React.JSX.Element => (
  <>
    <SetupDialog creating={false} />
    <SetupDialog creating />
  </>
);
