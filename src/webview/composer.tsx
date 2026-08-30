import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import type { PromptImage } from "../threads/threads";
import { postMessage } from "./bridge";
import { FooterControls } from "./footer-controls";
import type { RenderedThreadDetail } from "./protocol";

interface ComposerMatch {
  query: string;
  start: number;
}

const composerContext = (
  value: string,
  cursor: number
): ComposerMatch | undefined => {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@(?<query>[^\s]*)$/u);
  const query = match?.groups?.query;
  return query === undefined
    ? undefined
    : {
        query: query.toLowerCase().replaceAll("\\", "/"),
        start: before.length - query.length - 1,
      };
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
  selected,
  workspace,
}: {
  contextItems: string[];
  selected?: RenderedThreadDetail;
  workspace?: string;
}): React.JSX.Element => {
  const box = useRef<HTMLTextAreaElement>(null);
  const consumedDrafts = useRef("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [contextMatches, setContextMatches] = useState<string[]>([]);
  const [contextIndex, setContextIndex] = useState(0);
  const [contextStart, setContextStart] = useState(-1);

  const updateContextSuggestions = useCallback(
    (value: string, cursor: number): void => {
      const context = composerContext(value, cursor);
      if (!context) {
        setContextMatches([]);
        setContextStart(-1);
        return;
      }
      setContextStart(context.start);
      setContextMatches(matchingContextItems(contextItems, context));
      setContextIndex(0);
    },
    [contextItems]
  );

  useEffect(() => {
    const value = box.current?.value ?? "";
    updateContextSuggestions(
      value,
      box.current?.selectionStart ?? value.length
    );
  }, [updateContextSuggestions]);

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
    if (selected) {
      box.current?.focus();
    }
  }, [selected?.id]);

  const newThread = (): void => {
    if (!workspace) {
      return;
    }
    postMessage({ type: "newThread" });
    box.current?.focus();
  };

  const send = (): void => {
    const text = box.current?.value ?? "";
    if (text.trim() === "/new" && !images.length) {
      if (box.current) {
        box.current.value = "";
      }
      setContextMatches([]);
      newThread();
      return;
    }
    if ((!text.trim() && !images.length) || !selected) {
      return;
    }
    postMessage({ images, text, type: "prompt" });
    if (box.current) {
      box.current.value = "";
    }
    setImages([]);
    setContextMatches([]);
  };

  const selectContext = (item: string): void => {
    const text = box.current?.value ?? "";
    const end = box.current?.selectionStart ?? text.length;
    const value = item.endsWith("/") ? item : `${item} `;
    const next = `${text.slice(0, contextStart)}@${value}${text.slice(end)}`;
    const cursor = contextStart + value.length + 1;
    if (box.current) {
      box.current.value = next;
    }
    setContextMatches([]);
    window.requestAnimationFrame(() => {
      box.current?.setSelectionRange(cursor, cursor);
      box.current?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      contextMatches.length &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "Escape") {
        setContextMatches([]);
      } else if (event.key === "ArrowDown") {
        setContextIndex((contextIndex + 1) % contextMatches.length);
      } else if (event.key === "ArrowUp") {
        setContextIndex(
          (contextIndex + contextMatches.length - 1) % contextMatches.length
        );
      } else {
        const match = contextMatches[contextIndex];
        if (match) {
          selectContext(match);
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
      const result = String(reader.result);
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
      <textarea
        id="composer"
        ref={box}
        placeholder="Message magpi-acp — @ to include context, / for commands"
        autoComplete="off"
        disabled={!selected}
        onChange={(event) => {
          updateContextSuggestions(
            event.currentTarget.value,
            event.currentTarget.selectionStart
          );
        }}
        onKeyDown={handleKeyDown}
        onPaste={pasteImages}
      />
      <div
        id="context-suggestions"
        role="listbox"
        hidden={!contextMatches.length}
      >
        {contextMatches.map((item, index) => (
          <button
            type="button"
            className={index === contextIndex ? "selected" : ""}
            role="option"
            aria-selected={index === contextIndex}
            key={item}
            onMouseDown={(event) => {
              event.preventDefault();
              selectContext(item);
            }}
          >
            @{item}
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
              onClick={() =>
                setImages((current) =>
                  current.filter((candidate) => candidate !== image)
                )
              }
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <FooterControls
        onNewThread={newThread}
        onSend={() => (running ? postMessage({ type: "cancel" }) : send())}
        selected={selected}
        workspace={workspace}
      />
    </footer>
  );
};

const sameSelectedControls = (
  previous?: RenderedThreadDetail,
  next?: RenderedThreadDetail
): boolean => {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return false;
  }
  return (
    previous.id === next.id &&
    previous.status === next.status &&
    previous.usage?.used === next.usage?.used &&
    previous.usage?.size === next.usage?.size &&
    JSON.stringify(previous.drafts) === JSON.stringify(next.drafts) &&
    JSON.stringify(previous.configOptions) ===
      JSON.stringify(next.configOptions)
  );
};

export const Composer = memo(
  ComposerView,
  (previous, next) =>
    previous.contextItems === next.contextItems &&
    previous.workspace === next.workspace &&
    sameSelectedControls(previous.selected, next.selected)
);
