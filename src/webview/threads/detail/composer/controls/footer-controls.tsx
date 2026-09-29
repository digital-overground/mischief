import { SvgIcon } from "../../../../icon";
import type {
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../../../protocol";
import { ConfigControl } from "./config-control";
import { HistoryControl } from "./history-control";
import { UsageControl } from "./usage-control";

export const FooterControls = ({
  historyItems = [],
  onJumpMessage,
  onSend,
  selected,
  setup = false,
}: {
  historyItems?: RenderedTranscriptItem[];
  onJumpMessage?: (id: string) => void;
  onSend: () => void;
  selected?: RenderedThreadDetail;
  setup?: boolean;
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
      <HistoryControl
        items={historyItems}
        onJumpMessage={onJumpMessage}
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
        title={sendLabel}
        aria-label={sendLabel}
        disabled={
          (!selected && !setup) || selected?.sessionOperation !== undefined
        }
        onClick={onSend}
      >
        <SvgIcon className="send-icon" kind="send" />
        <SvgIcon className="stop-icon" kind="stop" />
      </button>
    </div>
  );
};
