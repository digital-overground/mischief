import { useState } from "react";
import type { ReactNode } from "react";

import { postMessage } from "./bridge";
import { Icon } from "./icon";
import type { RenderedThreadDetail, RenderedTranscriptItem } from "./protocol";

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
  open,
  setOpen,
}: {
  item: RenderedTranscriptItem;
  open: boolean;
  setOpen: (open: boolean) => void;
}): React.JSX.Element => (
  <details
    className="entry tool"
    open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
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
  openTools,
  setToolOpen,
}: {
  item: RenderedTranscriptItem;
  openTools: Set<string>;
  setToolOpen: (id: string, open: boolean) => void;
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
    return (
      <ToolItem
        item={item}
        open={openTools.has(item.id)}
        setOpen={(open) => setToolOpen(item.id, open)}
      />
    );
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

const TranscriptNodes = ({
  items,
  openTools,
  setToolOpen,
}: {
  items: RenderedTranscriptItem[];
  openTools: Set<string>;
  setToolOpen: (id: string, open: boolean) => void;
}): ReactNode[] => {
  const nodes: ReactNode[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (!item) {
      break;
    }
    if (item.kind !== "thought") {
      nodes.push(
        <TranscriptEntry
          item={item}
          key={item.id}
          openTools={openTools}
          setToolOpen={setToolOpen}
        />
      );
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
  return nodes;
};

export const Transcript = ({
  selected,
}: {
  selected?: RenderedThreadDetail;
}): React.JSX.Element => {
  const [openTools, setOpenTools] = useState<Set<string>>(() => new Set());
  const items = selected?.items.filter((item) => item.kind !== "plan") ?? [];
  const setToolOpen = (id: string, open: boolean): void => {
    setOpenTools((current) => {
      const next = new Set(current);
      if (open) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  let content: ReactNode;
  if (!selected) {
    content = <div className="empty">Select a managed Workspace.</div>;
  } else if (items.length) {
    content = (
      <TranscriptNodes
        items={items}
        openTools={openTools}
        setToolOpen={setToolOpen}
      />
    );
  } else {
    content = <div className="empty">Send a prompt to start this Thread.</div>;
  }
  return <div id="transcript">{content}</div>;
};
