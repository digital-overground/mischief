import { SvgIcon } from "../../../../icon";
import type {
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../../../protocol";
import { ConfigControl } from "./config-control";
import { HistoryControl } from "./history-control";
import { SkillPickerControl } from "./skill-picker-control";
import { UsageControl } from "./usage-control";

const isRunning = (selected?: RenderedThreadDetail): boolean =>
  Boolean(selected && ["running", "waiting"].includes(selected.status));

const sendLabel = (setup: boolean, running: boolean): string => {
  if (setup) {
    return "Continue setup";
  }
  return running ? "Stop" : "Send";
};

const isSendDisabled = (
  selected: RenderedThreadDetail | undefined,
  setup: boolean
): boolean =>
  (!selected && !setup) ||
  (!setup && !selected?.agentId) ||
  selected?.sessionOperation !== undefined;

const AgentConfigControls = ({
  selected,
}: {
  selected?: RenderedThreadDetail;
}): React.JSX.Element | null => {
  if (!selected) {
    return null;
  }
  const { agentId, configOptions } = selected;
  if (!agentId) {
    return null;
  }
  return (
    <div id="configs">
      {configOptions.map((config) => (
        <ConfigControl
          agentId={agentId}
          config={config}
          key={`${config.id}:${config.currentValue}`}
        />
      ))}
    </div>
  );
};

export const FooterControls = ({
  historyItems = [],
  onJumpMessage,
  onSelectSkill,
  onSend,
  selected,
  setup = false,
}: {
  historyItems?: RenderedTranscriptItem[];
  onJumpMessage?: (id: string) => void;
  onSelectSkill?: (command: RenderedThreadDetail["commands"][number]) => void;
  onSend: () => void;
  selected?: RenderedThreadDetail;
  setup?: boolean;
}): React.JSX.Element => {
  const running = isRunning(selected);
  return (
    <div className="footer-row">
      <HistoryControl
        items={historyItems}
        onJumpMessage={onJumpMessage}
        selected={selected}
        key={`history:${selected?.id ?? "none"}`}
      />
      <SkillPickerControl
        commands={selected?.commands ?? []}
        onSelect={(command) => onSelectSkill?.(command)}
        key={`skills:${selected?.id ?? "none"}`}
      />
      {selected?.usage && selected.usage.size > 0 ? (
        <UsageControl usage={selected.usage} key={selected.id} />
      ) : null}
      <AgentConfigControls selected={selected} />
      <button
        className={`action${running ? " stop" : ""}`}
        id="send"
        title={sendLabel(setup, running)}
        aria-label={sendLabel(setup, running)}
        disabled={isSendDisabled(selected, setup)}
        onClick={onSend}
      >
        <SvgIcon className="send-icon" kind="send" />
        <SvgIcon className="stop-icon" kind="stop" />
      </button>
    </div>
  );
};
