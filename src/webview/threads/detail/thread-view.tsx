import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isNonEmpty } from "../../../present";
import { postMessage } from "../../bridge";
import { SvgIcon } from "../../icon";
import type {
  RenderedSetupStep,
  RenderedThreadsSnapshot,
  RenderedTranscriptItem,
} from "../../protocol";
import { Composer } from "./composer/composer";
import { Interaction } from "./interaction";
import { PlanControl } from "./plan-control";
import { SteeringControl } from "./steering-control";
import { Transcript } from "./transcript";

const noTranscriptItems: RenderedTranscriptItem[] = [];

const Processing = (): React.JSX.Element => (
  <div id="processing" role="status" aria-label="Agent is working" />
);

// oxlint-disable-next-line complexity -- the component renders Thread state branches
export const ThreadView = ({
  contextItems,
  onToggleMaximized,
  setup,
  snapshot,
  threadMaximized,
  transcript,
}: {
  contextItems: string[];
  onToggleMaximized: () => void;
  setup?: RenderedSetupStep;
  snapshot: RenderedThreadsSnapshot;
  threadMaximized: boolean;
  transcript: {
    items: RenderedTranscriptItem[];
    streaming: boolean;
    threadId?: string;
  };
}): React.JSX.Element => {
  const chat = useRef<HTMLDivElement>(null);
  const previousThread = useRef<string | null>(null);
  const [copyNotice, setCopyNotice] = useState(0);
  const [selectedSetupOptions, setSelectedSetupOptions] = useState<string[]>(
    []
  );
  const shouldStick = useRef(true);
  const selected = setup ? undefined : snapshot.selected;
  useEffect(() => {
    setSelectedSetupOptions(setup?.options?.map(({ id }) => id) ?? []);
  }, [setup?.id, setup?.options]);
  const transcriptItems =
    transcript.threadId === selected?.id ? transcript.items : noTranscriptItems;
  const changed = previousThread.current !== selected?.id;
  useLayoutEffect(() => {
    const container = chat.current;
    if (container && (changed || shouldStick.current)) {
      container.scrollTop = container.scrollHeight;
    }
    previousThread.current = selected?.id ?? null;
  }, [changed, selected, transcriptItems]);
  const streaming =
    transcript.threadId === selected?.id
      ? transcript.streaming
      : selected?.streaming;
  const plan =
    transcriptItems.findLast(
      (item) => item.kind === "plan" && isNonEmpty(item.text)
    ) ??
    selected?.items.find(
      (item) => item.kind === "plan" && isNonEmpty(item.text)
    );
  const maximizeLabel = threadMaximized
    ? "Expand Navigator"
    : "Maximize Current Thread";
  return (
    <section id="thread">
      <header id="thread-header">
        <span className="heading" id="thread-title">
          {setup ? "Setup" : (selected?.name ?? "Thread")}
        </span>
        <button
          className="icon"
          id="maximize-thread"
          title={maximizeLabel}
          aria-label={maximizeLabel}
          aria-pressed={threadMaximized}
          onClick={onToggleMaximized}
        >
          <SvgIcon kind={threadMaximized ? "minimize" : "maximize"} />
        </button>
        <button
          className="icon"
          id="rename-thread"
          title="Rename Thread"
          aria-label="Rename Thread"
          disabled={!isNonEmpty(selected?.id)}
          onClick={() => {
            if (isNonEmpty(selected?.id)) {
              postMessage({ id: selected.id, type: "renameThread" });
            }
          }}
        >
          <SvgIcon className="thread-action-icon" kind="pencil" />
        </button>
      </header>
      <div
        id="chat"
        ref={chat}
        onScroll={(event) => {
          const container = event.currentTarget;
          shouldStick.current =
            container.scrollHeight -
              container.scrollTop -
              container.clientHeight <
            48;
        }}
      >
        <Transcript
          onCopied={() => {
            setCopyNotice((notice) => notice + 1);
          }}
          selected={selected}
          onSetupOptionChange={(id, checked) => {
            setSelectedSetupOptions((current) =>
              checked
                ? [...new Set([...current, id])]
                : current.filter((candidate) => candidate !== id)
            );
          }}
          selectedSetupOptions={selectedSetupOptions}
          setup={setup}
          streamedItems={transcriptItems}
          key={setup ? "setup" : (selected?.id ?? "none")}
        />
        {selected?.status === "running" && streaming !== true ? (
          <Processing />
        ) : null}
        <div id="notice">{selected?.error ?? ""}</div>
        <div id="actions">
          {selected?.status === "error" ? (
            <button
              className="action primary"
              title="Retry"
              onClick={() => {
                postMessage({ type: "retry" });
              }}
            >
              Retry
            </button>
          ) : null}
          {selected?.authentication ? (
            <button
              className="action primary"
              title="Authenticate Agent"
              onClick={() => {
                postMessage({ type: "authenticate" });
              }}
            >
              {selected.authentication.label}
            </button>
          ) : null}
        </div>
        <Interaction interaction={selected?.interaction} />
      </div>
      <SteeringControl messages={selected?.steering ?? []} />
      <PlanControl plan={plan} key={plan?.id ?? "no-plan"} />
      <Composer
        contextItems={contextItems}
        copyNotice={copyNotice}
        selected={selected}
        setup={Boolean(setup)}
        setupSelected={selectedSetupOptions}
        workspace={snapshot.workspace}
      />
    </section>
  );
};
