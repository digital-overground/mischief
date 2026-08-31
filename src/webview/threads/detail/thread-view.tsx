import { useLayoutEffect, useRef } from "react";

import { postMessage } from "../../bridge";
import type {
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
  snapshot,
  transcript,
}: {
  contextItems: string[];
  snapshot: RenderedThreadsSnapshot;
  transcript: {
    items: RenderedTranscriptItem[];
    streaming: boolean;
    threadId?: string;
  };
}): React.JSX.Element => {
  const chat = useRef<HTMLDivElement>(null);
  const previousThread = useRef<string | null>(null);
  const shouldStick = useRef(true);
  const { selected } = snapshot;
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
    transcriptItems.findLast((item) => item.kind === "plan" && item.text) ??
    selected?.items.find((item) => item.kind === "plan" && item.text);
  return (
    <section id="thread">
      <header id="thread-header">
        <span className="heading" id="thread-title">
          {selected?.name || "Thread"}
        </span>
        <button
          className="icon"
          id="rename-thread"
          title="Rename Thread"
          aria-label="Rename Thread"
          disabled={!selected?.id}
          onClick={() => postMessage({ type: "renameThread" })}
        >
          ✎
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
          selected={selected}
          streamedItems={transcriptItems}
          key={selected?.id ?? "none"}
        />
        {selected?.status === "running" && !streaming ? <Processing /> : null}
        <div id="notice">{selected?.error || ""}</div>
        <div id="actions">
          {selected?.status === "error" ? (
            <button
              className="action primary"
              onClick={() => postMessage({ type: "retry" })}
            >
              Retry
            </button>
          ) : null}
          {selected?.authentication ? (
            <button
              className="action primary"
              onClick={() => postMessage({ type: "authenticate" })}
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
        selected={selected}
        workspace={snapshot.workspace}
      />
    </section>
  );
};
