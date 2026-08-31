import { memo, useMemo } from "react";
import type { ReactNode } from "react";

import { postMessage } from "../../bridge";
import { Icon } from "../../icon";
import type {
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../protocol";

const MarkdownBody = ({
  className = "body markdown",
  item,
}: {
  className?: string;
  item: RenderedTranscriptItem;
}): React.JSX.Element =>
  item.html ? (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: item.html }}
    />
  ) : (
    <div className={className}>{item.text || ""}</div>
  );

const ImageGallery = ({
  images,
}: {
  images: NonNullable<RenderedTranscriptItem["images"]>;
}): React.JSX.Element => (
  <div className="transcript-images">
    {images.map((image, index) => (
      <img
        alt="Attached"
        src={`data:${image.mimeType};base64,${image.data}`}
        key={`${image.mimeType}:${index}`}
      />
    ))}
  </div>
);

const LabelledPre = ({
  label,
  text,
}: {
  label: string;
  text: string;
}): React.JSX.Element => (
  <div>
    <b>{label}</b>
    <pre>{text}</pre>
  </div>
);

const ThinkingGroup = ({
  items,
}: {
  items: RenderedTranscriptItem[];
}): React.JSX.Element => (
  <section className="entry thought thinking-group">
    <div className="thinking-heading">
      <Icon className="entry-icon" kind="brain" title="Thinking" />
      Thinking
    </div>
    <div className="thinking-content">
      {items.map((item) => (
        <MarkdownBody
          className="thinking-item markdown"
          item={item}
          key={item.id}
        />
      ))}
    </div>
  </section>
);

const ToolItem = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element => (
  <details className="entry tool">
    <summary>
      <Icon className="entry-icon" kind="tool" title="Tool" />
      <span>
        {item.title || "Tool call"}
        {item.status ? ` · ${item.status}` : ""}
      </span>
    </summary>
    <div className="tool-body">
      {item.input ? <LabelledPre label="Input" text={item.input} /> : null}
      {item.output ? <LabelledPre label="Output" text={item.output} /> : null}
      {item.locations?.map((location) => (
        <button
          className="link"
          key={`${location.path}:${location.line ?? ""}`}
          onClick={() =>
            postMessage({
              ...(location.line ? { line: location.line } : {}),
              path: location.path,
              type: "openLocation",
            })
          }
        >
          {location.path}
          {location.line ? `:${location.line}` : ""}
        </button>
      ))}
      {item.diffs?.map((diff) => (
        <button
          className="link"
          key={diff.path}
          onClick={() => postMessage({ path: diff.path, type: "openDiff" })}
        >
          Open diff · {diff.path}
        </button>
      ))}
    </div>
  </details>
);

const entryMeta: Partial<
  Record<
    RenderedTranscriptItem["kind"],
    { icon: "alert" | "bot" | "brain" | "user"; label: string }
  >
> = {
  assistant: { icon: "bot", label: "Pi" },
  system: { icon: "alert", label: "Mischief" },
  thought: { icon: "brain", label: "Thinking" },
  user: { icon: "user", label: "You" },
};

const TranscriptEntry = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element => {
  if (item.kind === "completedPlan") {
    return (
      <section className="entry completed-plan">
        <div className="completed-plan-title">
          <Icon className="entry-icon" kind="plan" title="Completed Plan" />
          Completed Plan
        </div>
        <pre className="completed-plan-body">{item.text || ""}</pre>
      </section>
    );
  }
  if (item.kind === "tool") {
    return <ToolItem item={item} />;
  }
  const meta = entryMeta[item.kind] ?? {
    icon: "alert",
    label: "Mischief",
  };
  const content = (
    <div className="entry-content">
      <MarkdownBody item={item} />
      {item.images?.length ? <ImageGallery images={item.images} /> : null}
      {item.queued ? (
        <div className="cancelled">Queued · position {item.queued}</div>
      ) : null}
      {item.cancelled ? <div className="cancelled">Cancelled</div> : null}
    </div>
  );
  return (
    <article className={`entry ${item.kind}`}>
      {item.kind === "user" || item.kind === "assistant" ? null : (
        <Icon className="entry-icon" kind={meta.icon} title={meta.label} />
      )}
      {content}
    </article>
  );
};

const TranscriptNodes = memo(
  ({ items }: { items: RenderedTranscriptItem[] }): React.JSX.Element => {
    const nodes: ReactNode[] = [];
    for (let index = 0; index < items.length;) {
      const item = items[index];
      if (!item) {
        break;
      }
      if (item.kind !== "thought") {
        nodes.push(<TranscriptEntry item={item} key={item.id} />);
        index += 1;
        continue;
      }
      const thoughts: RenderedTranscriptItem[] = [];
      while (items[index]?.kind === "thought") {
        thoughts.push(items[index] as RenderedTranscriptItem);
        index += 1;
      }
      nodes.push(<ThinkingGroup items={thoughts} key={`thought:${item.id}`} />);
    }
    return <>{nodes}</>;
  }
);

export const Transcript = ({
  selected,
  streamedItems,
}: {
  selected?: RenderedThreadDetail;
  streamedItems: RenderedTranscriptItem[];
}): React.JSX.Element => {
  const { history, tail } = useMemo(() => {
    const items = selected?.items.filter((item) => item.kind !== "plan") ?? [];
    return { history: items.slice(0, -1), tail: items.at(-1) };
  }, [selected?.items]);
  const streamed = useMemo(
    () => streamedItems.filter((item) => item.kind !== "plan"),
    [streamedItems]
  );
  const tailWasUpdated = streamed.some((item) => item.id === tail?.id);
  let content: ReactNode;
  if (!selected) {
    content = <div className="empty">Select a managed Workspace.</div>;
  } else if (history.length || tail || streamed.length) {
    content = (
      <>
        <TranscriptNodes items={history} />
        {tail && !tailWasUpdated ? <TranscriptEntry item={tail} /> : null}
        <TranscriptNodes items={streamed} />
      </>
    );
  } else {
    content = <div className="empty">Send a prompt to start this Thread.</div>;
  }
  return <div id="transcript">{content}</div>;
};
