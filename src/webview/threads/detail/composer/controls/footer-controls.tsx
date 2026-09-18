import { isNonEmpty } from "../../../../../present";
import { postMessage } from "../../../../bridge";
import { SvgIcon } from "../../../../icon";
import type { RenderedThreadDetail } from "../../../../protocol";
import { ConfigControl } from "./config-control";
import { UsageControl } from "./usage-control";

export const FooterControls = ({
  onNewThread,
  onSend,
  selected,
  setup = false,
  workspace,
}: {
  onNewThread: () => void;
  onSend: () => void;
  selected?: RenderedThreadDetail;
  setup?: boolean;
  workspace?: string;
}): React.JSX.Element => {
  const running = Boolean(
    selected && ["running", "waiting"].includes(selected.status)
  );
  let sendLabel = "Send";
  if (setup) {
    sendLabel = "Continue setup";
  } else if (running) {
    sendLabel = "Stop";
  }
  return (
    <div className="footer-row">
      <button
        className="action"
        id="footer-new-thread"
        title="New Thread"
        aria-label="New Thread"
        disabled={!isNonEmpty(workspace)}
        onClick={onNewThread}
      >
        <SvgIcon kind="chat" />
      </button>
      {selected?.forkSupported === true ? (
        <button
          className="action"
          id="footer-fork-thread"
          title="Fork Thread"
          aria-label="Fork Thread"
          type="button"
          disabled={selected.status !== "idle" || selected.sessionOperation}
          onClick={() => {
            postMessage({ type: "forkThread" });
          }}
        >
          <SvgIcon kind="fork" />
        </button>
      ) : null}
      {selected?.treeNavigationSupported === true ? (
        <button
          className="action"
          id="footer-navigate-tree"
          title="Navigate Thread Tree"
          aria-label="Navigate Thread Tree"
          type="button"
          disabled={selected.status !== "idle" || selected.sessionOperation}
          onClick={() => {
            postMessage({ type: "navigateThreadTree" });
          }}
        >
          <SvgIcon kind="gitBranch" />
        </button>
      ) : null}
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
        title={sendLabel}
        aria-label={sendLabel}
        disabled={(!selected && !setup) || selected?.sessionOperation}
        onClick={onSend}
      >
        <SvgIcon className="send-icon" kind="send" />
        <SvgIcon className="stop-icon" kind="stop" />
      </button>
    </div>
  );
};
