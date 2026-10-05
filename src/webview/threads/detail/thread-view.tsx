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

const Processing = ({ hidden }: { hidden: boolean }): React.JSX.Element => (
  <div
    id="processing"
    aria-hidden={hidden}
    aria-label={hidden ? undefined : "Agent is working"}
    hidden={hidden}
    role={hidden ? undefined : "status"}
  />
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
  const chatContent = useRef<HTMLDivElement>(null);
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
  const historyItems = [...(selected?.items ?? [])];
  for (const item of transcriptItems) {
    const index = historyItems.findIndex(
      (candidate) => candidate.id === item.id
    );
    if (index === -1) {
      historyItems.push(item);
    } else {
      historyItems[index] = item;
    }
  }
  const visibleMessages = historyItems.filter(
    (item) => item.kind === "user" || item.kind === "assistant"
  );
  const changed = previousThread.current !== selected?.id;
  useLayoutEffect(() => {
    const container = chat.current;
    if (changed) {
      shouldStick.current = true;
    }
    if (container && shouldStick.current) {
      container.scrollTop = container.scrollHeight;
    }
    previousThread.current = selected?.id ?? null;
  }, [changed, selected, transcriptItems]);
  useEffect(() => {
    const container = chat.current;
    const content = chatContent.current;
    const observer =
      container && content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (shouldStick.current) {
              container.scrollTop = container.scrollHeight;
            }
          })
        : undefined;
    if (content) {
      observer?.observe(content);
    }
    return () => {
      if (observer) {
        observer.disconnect();
      }
    };
  }, []);
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
  const processingLabel =
    selected?.sessionOperation === "branchSummary"
      ? "Generating branch summary…"
      : undefined;
  const processing = selected?.status === "running" && streaming !== true;
  const blocked = selected?.sessionOperation !== undefined;
  return (
    <section id="thread" aria-busy={blocked}>
      <div
        id="thread-content"
        inert={blocked || Boolean(selected?.interaction)}
      >
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
          <div id="chat-content" ref={chatContent}>
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
            <Processing hidden={!processing} />
          </div>
        </div>
        <SteeringControl messages={selected?.steering ?? []} />
        <PlanControl plan={plan} key={plan?.id ?? "no-plan"} />
        <Composer
          historyItems={visibleMessages}
          onJumpMessage={(id) => {
            const container = chat.current;
            const target = [
              ...(container?.querySelectorAll<HTMLElement>(
                "[data-message-id]"
              ) ?? []),
            ].find((element) => element.dataset.messageId === id);
            if (container && target) {
              shouldStick.current = false;
              // scrollIntoView can also shift the transcript horizontally.
              container.scrollTop +=
                target.getBoundingClientRect().top -
                container.getBoundingClientRect().top;
            }
          }}
          contextItems={contextItems}
          copyNotice={copyNotice}
          selected={selected}
          setup={Boolean(setup)}
          setupSelected={selectedSetupOptions}
        />
      </div>
      <Interaction interaction={selected?.interaction} />
      {isNonEmpty(processingLabel) ? (
        <div
          aria-live="polite"
          className="thread-operation-overlay"
          role="status"
        >
          <span className="thread-operation-spinner" aria-hidden="true" />
          <span>{processingLabel}</span>
        </div>
      ) : null}
    </section>
  );
};
