import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { isDefined, isNonEmpty } from "../../../../present";
import type { PromptImage, ThreadCommand } from "../../../../threads/threads";
import { postMessage } from "../../../bridge";
import type { RenderedThreadDetail } from "../../../protocol";
import { FooterControls } from "./controls/footer-controls";

interface ComposerMatch {
  query: string;
  start: number;
}

const composerContext = (
  value: string,
  cursor: number
): ComposerMatch | undefined => {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@(?<query>[^\s]*)$/u.exec(before);
  const query = match?.groups?.query;
  return query === undefined
    ? undefined
    : {
        query: query.toLowerCase().replaceAll("\\", "/"),
        start: before.length - query.length - 1,
      };
};

const slashCommand = (
  value: string,
  cursor: number
): ComposerMatch | undefined => {
  const match = /^\/(?<query>[^\s]*)$/u.exec(value.slice(0, cursor));
  return match?.groups?.query === undefined
    ? undefined
    : { query: match.groups.query.toLowerCase(), start: 0 };
};

const matchingContextItems = (
  items: string[],
  context: ComposerMatch
): string[] => {
  const matches: string[] = [];
  const directory = context.query.endsWith("/")
    ? context.query
    : context.query.slice(0, context.query.lastIndexOf("/") + 1);
  for (const item of items) {
    const candidate = item.toLowerCase();
    const remainder = candidate.slice(directory.length);
    if (
      (!directory && candidate.includes(context.query)) ||
      (Boolean(directory) &&
        candidate.startsWith(directory) &&
        remainder.split("/").filter(Boolean).length === 1)
    ) {
      matches.push(item);
      if (matches.length === 50) {
        break;
      }
    }
  }
  return matches;
};

const ComposerView = ({
  contextItems,
  copyNotice,
  selected,
  setup,
  setupSelected,
  workspace,
}: {
  contextItems: string[];
  copyNotice: number;
  selected?: RenderedThreadDetail;
  setup: boolean;
  setupSelected: string[];
  workspace?: string;
}): React.JSX.Element => {
  const box = useRef<HTMLTextAreaElement>(null);
  const suggestionsBox = useRef<HTMLDivElement>(null);
  const consumedDrafts = useRef("");
  const activeThread = useRef<string | null>(null);
  const draftsByThread = useRef(
    new Map<string, { images: PromptImage[]; text: string }>()
  );
  const [images, setImages] = useState<PromptImage[]>([]);
  const [context, setContext] = useState<ComposerMatch>();
  const [command, setCommand] = useState<ComposerMatch>();
  const [contextIndex, setContextIndex] = useState(0);
  const deferredContext = useDeferredValue(context);
  const deferredMatches = useMemo(
    () =>
      deferredContext
        ? matchingContextItems(contextItems, deferredContext)
        : [],
    [contextItems, deferredContext]
  );
  const contextMatches = context === deferredContext ? deferredMatches : [];
  const commandMatches = command
    ? (selected?.commands ?? []).filter(({ name }) =>
        name.toLowerCase().startsWith(command.query)
      )
    : [];
  const suggestions = command ? commandMatches : contextMatches;

  useEffect(() => {
    suggestionsBox.current
      ?.querySelector<HTMLElement>(".selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [contextIndex]);

  const updateSuggestions = (value: string, cursor: number): void => {
    const nextContext = composerContext(value, cursor);
    if (nextContext && !context) {
      postMessage({ type: "contextItems" });
    }
    setContext(nextContext);
    setCommand(slashCommand(value, cursor));
    setContextIndex(0);
  };

  useEffect(() => {
    const threadId = selected?.id ?? null;
    if (activeThread.current === threadId) {
      return;
    }
    if (isNonEmpty(activeThread.current)) {
      draftsByThread.current.set(activeThread.current, {
        images,
        text: box.current?.value ?? "",
      });
    }
    activeThread.current = threadId;
    const draft = isNonEmpty(threadId)
      ? draftsByThread.current.get(threadId)
      : undefined;
    if (box.current) {
      box.current.value = draft?.text ?? "";
    }
    setImages(draft?.images ?? []);
    setContext(undefined);
    setCommand(undefined);
  }, [selected?.id]);

  useEffect(() => {
    const drafts = selected?.drafts ?? [];
    const draftKey = `${selected?.id}:${drafts.join("\u0000")}`;
    if (!drafts.length) {
      consumedDrafts.current = "";
      return;
    }
    if (consumedDrafts.current === draftKey) {
      return;
    }
    if (box.current) {
      box.current.value = [box.current.value, ...drafts]
        .filter(Boolean)
        .join("\n\n");
    }
    consumedDrafts.current = draftKey;
    postMessage({ type: "draftsConsumed" });
  }, [selected?.drafts, selected?.id]);

  useEffect(() => {
    if (selected || setup) {
      box.current?.focus();
    }
  }, [selected?.id, setup]);

  const newThread = (): void => {
    if (!isNonEmpty(workspace)) {
      return;
    }
    postMessage({ type: "newThread" });
    box.current?.focus();
  };

  const send = (): void => {
    if (setup) {
      postMessage({ selected: setupSelected, type: "setupContinue" });
      return;
    }
    const text = box.current?.value ?? "";
    if (
      (!text.trim() && !images.length) ||
      !selected ||
      selected.sessionOperation !== undefined
    ) {
      return;
    }
    postMessage({ images, text, type: "prompt" });
    if (isNonEmpty(selected.id)) {
      draftsByThread.current.delete(selected.id);
    }
    if (box.current) {
      box.current.value = "";
    }
    setImages([]);
    setContext(undefined);
    setCommand(undefined);
  };

  const selectContext = (item: string): void => {
    const text = box.current?.value ?? "";
    const end = box.current?.selectionStart ?? text.length;
    const value = item.endsWith("/") ? item : `${item} `;
    const start = context?.start ?? 0;
    const next = `${text.slice(0, start)}@${value}${text.slice(end)}`;
    const cursor = start + value.length + 1;
    if (box.current) {
      box.current.value = next;
    }
    setContext(undefined);
    window.requestAnimationFrame(() => {
      box.current?.setSelectionRange(cursor, cursor);
      box.current?.focus();
    });
  };

  const selectCommand = (item: ThreadCommand): void => {
    const text = box.current?.value ?? "";
    const end = box.current?.selectionStart ?? text.length;
    const value = `/${item.name}${item.inputHint === undefined ? "" : " "}`;
    if (box.current) {
      box.current.value = `${value}${text.slice(end)}`;
    }
    setCommand(undefined);
    window.requestAnimationFrame(() => {
      box.current?.setSelectionRange(value.length, value.length);
      box.current?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      suggestions.length &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "Escape") {
        setContext(undefined);
        setCommand(undefined);
      } else if (event.key === "ArrowDown") {
        setContextIndex((contextIndex + 1) % suggestions.length);
      } else if (event.key === "ArrowUp") {
        setContextIndex(
          (contextIndex + suggestions.length - 1) % suggestions.length
        );
      } else {
        const match = suggestions[contextIndex];
        if (typeof match === "string") {
          selectContext(match);
        } else if (isDefined(match)) {
          selectCommand(match);
        }
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const readImage = (file: File): void => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        return;
      }
      const { result } = reader;
      setImages((current) => [
        ...current,
        {
          data: result.slice(result.indexOf(",") + 1),
          mimeType: file.type,
        },
      ]);
    });
    reader.readAsDataURL(file);
  };

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    for (const file of files) {
      readImage(file);
    }
  };

  const running = Boolean(
    selected && ["running", "waiting"].includes(selected.status)
  );
  return (
    <footer>
      {copyNotice ? (
        <div className="toast" role="status" key={copyNotice}>
          copied to clipboard
        </div>
      ) : null}
      <textarea
        id="composer"
        ref={box}
        placeholder={
          setup
            ? "Press Enter to continue"
            : "Message magpi-acp — @ to include context, / for commands"
        }
        autoComplete="off"
        disabled={!selected && !setup}
        readOnly={setup}
        onChange={(event) => {
          updateSuggestions(
            event.currentTarget.value,
            event.currentTarget.selectionStart
          );
        }}
        onKeyDown={handleKeyDown}
        onPaste={pasteImages}
      />
      <div
        id="context-suggestions"
        ref={suggestionsBox}
        role="listbox"
        hidden={!suggestions.length}
      >
        {suggestions.map((item, index) => (
          <button
            type="button"
            className={`${index === contextIndex ? "selected " : ""}${typeof item === "string" ? "" : "command-suggestion"}`}
            role="option"
            aria-selected={index === contextIndex}
            title={typeof item === "string" ? "Add context" : "Use command"}
            key={typeof item === "string" ? item : item.name}
            onMouseDown={(event) => {
              event.preventDefault();
              if (typeof item === "string") {
                selectContext(item);
              } else {
                selectCommand(item);
              }
            }}
          >
            {typeof item === "string" ? (
              <>@{item}</>
            ) : (
              <>
                <span className="command-name">
                  /{item.name}
                  {item.inputHint === undefined ? null : (
                    <span className="command-hint"> {item.inputHint}</span>
                  )}
                </span>
                <span className="command-description">{item.description}</span>
              </>
            )}
          </button>
        ))}
      </div>
      <div id="attachments" aria-live="polite">
        {images.map((image, index) => (
          <div className="attachment" key={`${image.mimeType}:${index}`}>
            <img
              alt="Pasted"
              src={`data:${image.mimeType};base64,${image.data}`}
            />
            <button
              className="icon"
              title="Remove pasted image"
              aria-label="Remove pasted image"
              onClick={() => {
                setImages((current) =>
                  current.filter((candidate) => candidate !== image)
                );
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <FooterControls
        onNewThread={newThread}
        onSend={() => {
          if (running) {
            postMessage({ type: "cancel" });
          } else {
            send();
          }
        }}
        selected={selected}
        setup={setup}
        workspace={workspace}
      />
    </footer>
  );
};

export const Composer = memo(ComposerView);
