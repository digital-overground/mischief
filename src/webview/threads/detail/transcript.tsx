import { memo, useMemo } from "react";
import type { ReactNode } from "react";

import { isDefined, isNonEmpty, isNonZero, isRecord } from "../../../present";
import { postMessage } from "../../bridge";
import { Icon } from "../../icon";
import type {
  RenderedSetupStep,
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../protocol";

const nonEmpty = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.length > 0 ? value : fallback;

const MarkdownBody = ({
  className = "body markdown",
  item,
}: {
  className?: string;
  item: RenderedTranscriptItem;
}): React.JSX.Element =>
  isNonEmpty(item.html) ? (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: item.html }}
    />
  ) : (
    <div className={className}>{item.text ?? ""}</div>
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

const statusLabel = (status?: string): string =>
  isNonEmpty(status) ? ` · ${status.replaceAll("_", " ")}` : "";

const ToolOperationStatus = ({
  status,
}: {
  status?: string;
}): React.JSX.Element | null => {
  if (!isNonEmpty(status)) {
    return null;
  }
  const text = status.replaceAll("_", " ");
  const label = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  const className = `tool-operation-status ${status}`;
  if (status === "pending" || status === "in_progress") {
    return (
      <span className={className} title={label} role="img" aria-label={label} />
    );
  }
  let icon: "circle" | "circleCheck" | "circleSlash" = "circle";
  if (status === "completed") {
    icon = "circleCheck";
  } else if (status === "failed") {
    icon = "circleSlash";
  }
  return <Icon className={className} kind={icon} title={label} />;
};

const ToolBody = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element => (
  <div className="tool-body">
    {isNonEmpty(item.input) ? (
      <LabelledPre label="Input" text={item.input} />
    ) : null}
    {isNonEmpty(item.output) ? (
      <LabelledPre label="Output" text={item.output} />
    ) : null}
    {item.locations?.map((location) => (
      <button
        className="link"
        title="Open file"
        key={`${location.path}:${location.line ?? ""}`}
        onClick={() => {
          postMessage({
            ...(isNonZero(location.line) ? { line: location.line } : {}),
            path: location.path,
            type: "openLocation",
          });
        }}
      >
        {location.path}
        {isNonZero(location.line) ? `:${location.line}` : ""}
      </button>
    ))}
    {item.diffs?.map((diff) => (
      <button
        className="link"
        title="Open diff"
        key={diff.path}
        onClick={() => {
          postMessage({ path: diff.path, type: "openDiff" });
        }}
      >
        Open diff · {diff.path}
      </button>
    ))}
  </div>
);

const GenericToolItem = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element => (
  <details className="entry tool">
    <summary>
      <Icon className="entry-icon" kind="tool" title="Tool" />
      <span>
        {nonEmpty(item.title, "Tool call")}
        {statusLabel(item.status)}
      </span>
    </summary>
    <ToolBody item={item} />
  </details>
);

const jsonField = (input: string | undefined, field: string): unknown => {
  if (!isNonEmpty(input)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed[field] : undefined;
};

const jsonStringField = (
  input: string | undefined,
  field: string
): string | undefined => {
  const value = jsonField(input, field);
  return typeof value === "string" ? value : undefined;
};

const fetchUrl = (input?: string): string | undefined => {
  const urls = jsonField(input, "urls");
  if (typeof urls === "string") {
    return urls;
  }
  return Array.isArray(urls)
    ? urls.find((url): url is string => typeof url === "string")
    : undefined;
};

const askUserQuestion = (input?: string): string | undefined =>
  jsonStringField(input, "question");

const AskUserItem = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element => {
  const question = askUserQuestion(item.input);
  const answerPrefix = "User answered: ";
  if (!isNonEmpty(question) || item.output?.startsWith(answerPrefix) !== true) {
    return <GenericToolItem item={item} />;
  }
  const answer = item.output.slice(answerPrefix.length);
  return (
    <section className="entry ask-user-result">
      <div className="ask-user-title">
        <Icon className="entry-icon" kind="question" title="Question" />
        Question
      </div>
      <div className="ask-user-content">
        <div className="body ask-user-question">{question}</div>
        <div className="body ask-user-answer">{answer}</div>
      </div>
    </section>
  );
};

type FileOperation = "read" | "edit" | "write";
type ToolGroupKind = "terminal" | "files" | "web" | "tools";

const webTools = new Set(["web_fetch", "web_search"]);

const toolGroups = {
  files: {
    className: "file-operations-group",
    icon: "file",
    label: "File operations",
  },
  terminal: {
    className: "terminal-group",
    icon: "terminal",
    label: "Terminal",
  },
  tools: { className: "tools-group", icon: "tool", label: "Tools" },
  web: { className: "web-group", icon: "globe", label: "Web" },
} as const;

const genericToolOperation = (item: RenderedTranscriptItem) => {
  const title = nonEmpty(item.title, "Tool call");
  const group: ToolGroupKind = webTools.has(title) ? "web" : "tools";
  if (title === "web_fetch") {
    const target = fetchUrl(item.input) ?? title;
    return {
      group,
      icon: "download" as const,
      iconTitle: "Fetch",
      label: undefined,
      target,
      targetTitle: target,
    };
  }
  if (title === "web_search" || title === "session_search") {
    const target = jsonStringField(item.input, "query") ?? title;
    return {
      group,
      icon: "search" as const,
      iconTitle: "Search",
      label: undefined,
      target,
      targetTitle: target,
    };
  }
  const metadata = toolGroups[group];
  return {
    group,
    icon: metadata.icon,
    iconTitle: "Tool",
    label: undefined,
    target: title,
    targetTitle: title,
  };
};

interface ToolOperation {
  group: ToolGroupKind;
  icon: React.ComponentProps<typeof Icon>["kind"];
  iconTitle: string;
  label: string | undefined;
  target: string | undefined;
  targetTitle: string | undefined;
}

const fileOperations = {
  edit: { icon: "pencil", label: "Edit" },
  read: { icon: "eye", label: "Read" },
  write: { icon: "save", label: "Write" },
} as const;

enum ToolOperationIcon {
  Git = "git",
  GitHub = "github",
  PackageManager = "package-manager",
  Terminal = "terminal",
}

const toolOperationIcons = {
  [ToolOperationIcon.Git]: { icon: "gitBranch", title: "Git command" },
  [ToolOperationIcon.GitHub]: { icon: "github", title: "GitHub CLI" },
  [ToolOperationIcon.PackageManager]: {
    icon: "package",
    title: "Package manager",
  },
  [ToolOperationIcon.Terminal]: { icon: "terminal", title: "Command" },
} as const;

const packageManagers = new Set(["bun", "npm", "npx", "pnpm", "yarn"]);

const commandOperationIcon = (command: string): ToolOperationIcon => {
  // ponytail: direct executables only; use shell parsing if compound commands need icons.
  const [executable = ""] = command.trimStart().split(/\s+/u);
  if (executable === "git") {
    return ToolOperationIcon.Git;
  }
  if (executable === "gh") {
    return ToolOperationIcon.GitHub;
  }
  return packageManagers.has(executable)
    ? ToolOperationIcon.PackageManager
    : ToolOperationIcon.Terminal;
};

const fileOperationKind = (
  item: RenderedTranscriptItem
): FileOperation | undefined => {
  if (item.toolKind === "read") {
    return "read";
  }
  if (item.toolKind !== "edit") {
    return undefined;
  }
  return item.title?.toLowerCase() === "write" ? "write" : "edit";
};

const toolOperation = (
  item?: RenderedTranscriptItem
): ToolOperation | undefined => {
  if (item?.kind !== "tool" || item.title === "ask_user") {
    return undefined;
  }
  if (item.toolKind === "execute") {
    const command = item.title ?? "";
    const iconClass = commandOperationIcon(command);
    const operationIcon = toolOperationIcons[iconClass];
    return {
      group: "terminal" as const,
      icon: operationIcon.icon,
      iconTitle: operationIcon.title,
      label: undefined,
      target: command.length > 0 ? command : undefined,
      targetTitle: command.length > 0 ? command : undefined,
    };
  }
  const kind = fileOperationKind(item);
  if (!kind) {
    return genericToolOperation(item);
  }
  const operation = fileOperations[kind];
  const location = item.locations?.[0];
  const path = location?.path ?? item.diffs?.[0]?.path;
  const line = isNonZero(location?.line) ? `:${location.line}` : "";
  return {
    group: "files" as const,
    ...operation,
    iconTitle: operation.label,
    target: isNonEmpty(path)
      ? `${path.split(/[\\/]/u).at(-1) ?? path}${line}`
      : undefined,
    targetTitle: isNonEmpty(path) ? `${path}${line}` : undefined,
  };
};

const toolGroupKind = (
  item?: RenderedTranscriptItem
): ToolGroupKind | undefined => toolOperation(item)?.group;

const ToolOperationItem = ({
  item,
}: {
  item: RenderedTranscriptItem;
}): React.JSX.Element | null => {
  const operation = toolOperation(item);
  return operation ? (
    <details className="tool-operation">
      <summary>
        <Icon
          className="entry-icon"
          kind={operation.icon}
          title={operation.iconTitle}
        />
        <span className="tool-operation-description">
          {isNonEmpty(operation.label) ? (
            <span className="tool-operation-label">{operation.label}</span>
          ) : null}
          {isNonEmpty(operation.target) ? (
            <>
              {isNonEmpty(operation.label) ? (
                <span className="tool-operation-separator">{" · "}</span>
              ) : null}
              <span
                className={`tool-operation-target${
                  operation.group === "terminal" ? " terminal-command" : ""
                }`}
                title={operation.targetTitle}
              >
                {operation.target}
              </span>
            </>
          ) : null}
        </span>
        <ToolOperationStatus status={item.status} />
      </summary>
      <ToolBody item={item} />
    </details>
  ) : null;
};

const ToolGroup = ({
  group,
  items,
}: {
  group: ToolGroupKind;
  items: RenderedTranscriptItem[];
}): React.JSX.Element => {
  const metadata = toolGroups[group];
  return (
    <section className={`entry tool tool-group ${metadata.className}`}>
      <div className="tool-group-heading">
        <Icon
          className="entry-icon"
          kind={metadata.icon}
          title={metadata.label}
        />
        {metadata.label}
      </div>
      <div className="tool-group-content">
        {items.map((item) => (
          <ToolOperationItem item={item} key={item.id} />
        ))}
      </div>
    </section>
  );
};

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
        <pre className="completed-plan-body">{item.text ?? ""}</pre>
      </section>
    );
  }
  if (item.kind === "tool") {
    return item.title === "ask_user" ? (
      <AskUserItem item={item} />
    ) : (
      <GenericToolItem item={item} />
    );
  }
  const meta = entryMeta[item.kind] ?? {
    icon: "alert",
    label: "Mischief",
  };
  const content = (
    <div className="entry-content">
      <MarkdownBody item={item} />
      {isNonZero(item.images?.length) ? (
        <ImageGallery images={item.images} />
      ) : null}
      {isNonZero(item.queued) ? (
        <div className="cancelled">Queued · position {item.queued}</div>
      ) : null}
      {item.cancelled === true ? (
        <div className="cancelled">Cancelled</div>
      ) : null}
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
      if (!isDefined(item)) {
        break;
      }
      if (item.kind === "thought") {
        const thoughts: RenderedTranscriptItem[] = [];
        while (items[index]?.kind === "thought") {
          thoughts.push(items[index]);
          index += 1;
        }
        nodes.push(
          <ThinkingGroup items={thoughts} key={`thought:${item.id}`} />
        );
        continue;
      }
      const group = toolGroupKind(item);
      if (group) {
        const operations: RenderedTranscriptItem[] = [];
        while (toolGroupKind(items[index]) === group) {
          operations.push(items[index]);
          index += 1;
        }
        nodes.push(
          <ToolGroup
            group={group}
            items={operations}
            key={`${group}:${item.id}`}
          />
        );
        continue;
      }
      nodes.push(<TranscriptEntry item={item} key={item.id} />);
      index += 1;
    }
    return <>{nodes}</>;
  }
);

export const Transcript = ({
  onCopied,
  onSetupOptionChange,
  selected,
  selectedSetupOptions,
  setup,
  streamedItems,
}: {
  onCopied: () => void;
  onSetupOptionChange: (id: string, checked: boolean) => void;
  selected?: RenderedThreadDetail;
  selectedSetupOptions: string[];
  setup?: RenderedSetupStep;
  streamedItems: RenderedTranscriptItem[];
}): React.JSX.Element => {
  const onTranscriptHighlight = async (): Promise<void> => {
    const selection = window.getSelection();
    const text = selection?.toString();
    if (selection && isNonEmpty(text)) {
      await navigator.clipboard.writeText(text);
      setTimeout(() => {
        selection.removeAllRanges();
      }, 0);
      onCopied();
    }
  };
  const { history, tail } = useMemo(() => {
    const items = selected?.items.filter((item) => item.kind !== "plan") ?? [];
    return { history: items.slice(0, -1), tail: items.at(-1) };
  }, [selected?.items]);
  const streamed = useMemo(
    () => streamedItems.filter((item) => item.kind !== "plan"),
    [streamedItems]
  );
  const tailWasUpdated = streamed.some((item) => item.id === tail?.id);
  const committed = useMemo(
    () => (tail && !tailWasUpdated ? [...history, tail] : history),
    [history, tail, tailWasUpdated]
  );
  let content: ReactNode;
  if (setup) {
    content = (
      <>
        <TranscriptNodes items={[setup.item]} />
        {setup.options?.map((option) => (
          <label className="settings-option setup-option" key={option.id}>
            <input
              type="checkbox"
              checked={selectedSetupOptions.includes(option.id)}
              onChange={(event) => {
                onSetupOptionChange(option.id, event.currentTarget.checked);
              }}
            />
            <span>
              <span className="settings-name">{option.label}</span>
              <span className="settings-description">{option.description}</span>
            </span>
          </label>
        ))}
      </>
    );
  } else if (!selected) {
    content = <div className="empty">Select an active Workspace.</div>;
  } else if (history.length || tail || streamed.length) {
    content = (
      <>
        <TranscriptNodes items={committed} />
        <TranscriptNodes items={streamed} />
      </>
    );
  } else {
    content = <div className="empty">Send a prompt to start this Thread.</div>;
  }
  return (
    <div
      id="transcript"
      onMouseUp={() => {
        void onTranscriptHighlight();
      }}
    >
      {content}
    </div>
  );
};
