import { SvgIcon } from "../../../../icon";
import type { RenderedThreadDetail } from "../../../../protocol";
import { ConfigControl } from "./config-control";
import { HistoryControl } from "./history-control";
import { UsageControl } from "./usage-control";

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
