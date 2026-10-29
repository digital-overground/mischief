import { $isCodeNode, CodeHighlightNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import {
  $createListItemNode,
  $isListItemNode,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
} from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { LexicalExtensionComposer } from "@lexical/react/LexicalExtensionComposer";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $isQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  defineExtension,
} from "lexical";
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent } from "react";

import { AGENTS } from "../../../../agents/update";
import { isDefined, isNonEmpty } from "../../../../present";
import type { PromptImage, ThreadCommand } from "../../../../threads/model";
import { postMessage } from "../../../bridge";
import type {
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../../protocol";
import { ImagePreview } from "../image-preview";
import { respondToElicitation } from "../interaction";
import { FooterControls } from "./controls/footer-controls";

interface ComposerMatch {
  end: number;
  key: string;
  query: string;
  start: number;
}

const resizeComposer = (composer: HTMLDivElement | null): void => {
  if (!composer) {
    return;
  }
  composer.style.height = "auto";
  composer.style.height = `${composer.scrollHeight}px`;
};

const composerContext = (
  value: string,
  cursor: number,
  key: string
): ComposerMatch | undefined => {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@(?<query>[^\s]*)$/u.exec(before);
  const query = match?.groups?.query;
  return query === undefined
    ? undefined
    : {
        end: cursor,
        key,
        query: query.toLowerCase().replaceAll("\\", "/"),
        start: before.length - query.length - 1,
      };
};

const slashCommand = (
  value: string,
  cursor: number,
  key: string
): ComposerMatch | undefined => {
  const match = /^\/(?<query>[^\s]*)$/u.exec(value.slice(0, cursor));
  return match?.groups?.query === undefined
    ? undefined
    : { end: cursor, key, query: match.groups.query.toLowerCase(), start: 0 };
};

const composerExtension = defineExtension({
  editable: false,
  name: "mischief-composer",
  namespace: "mischief-composer",
  nodes: [
    CodeHighlightNode,
    CodeNode,
    HeadingNode,
    LinkNode,
    ListItemNode,
    ListNode,
    QuoteNode,
  ],
  onError: (error: Error): never => {
    throw error;
  },
  theme: {
    code: "composer-code-block",
    heading: {
      h1: "composer-heading",
      h2: "composer-heading",
      h3: "composer-heading",
      h4: "composer-heading",
      h5: "composer-heading",
      h6: "composer-heading",
    },
    link: "composer-link",
    list: {
      listitem: "composer-list-item",
      ol: "composer-list-ordered",
      ul: "composer-list-unordered",
    },
    quote: "composer-quote",
    text: {
      bold: "composer-bold",
      code: "composer-code",
      italic: "composer-italic",
      strikethrough: "composer-strike",
    },
  },
});

interface ComposerProps {
  contextItems: string[];
  copyNotice: number;
  historyItems: RenderedTranscriptItem[];
  onJumpMessage: (id: string) => void;
  selected?: RenderedThreadDetail;
  setup: boolean;
  setupSelected: string[];
}

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

// oxlint-disable-next-line complexity -- composer handles both prompts and inline elicitation
const ComposerInput = ({
  contextItems,
  copyNotice,
  historyItems,
  onJumpMessage,
  selected,
  setup,
  setupSelected,
}: ComposerProps): React.JSX.Element => {
  const [editor] = useLexicalComposerContext();
  const box = useRef<HTMLDivElement>(null);
  const suggestionsBox = useRef<HTMLDivElement>(null);
  const consumedDrafts = useRef("");
  const activeThread = useRef<string | null>(null);
  const draftsByThread = useRef(
    new Map<string, { images: PromptImage[]; text: string }>()
  );
  const [images, setImages] = useState<PromptImage[]>([]);
  const [missingAnswer, setMissingAnswer] = useState(false);
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

  const getComposerText = (): string =>
    editor
      .getEditorState()
      .read(() => $convertToMarkdownString(TRANSFORMERS, undefined, true));

  const updateComposerText = (value: string): void => {
    editor.update(
      () => {
        $convertFromMarkdownString(value, TRANSFORMERS, undefined, true);
        $getRoot().selectEnd();
      },
      { discrete: true }
    );
  };

  const replaceComposerRange = (
    match: ComposerMatch | undefined,
    value: string
  ): void => {
    if (!match) {
      return;
    }
    editor.update(
      () => {
        const node = $getNodeByKey(match.key);
        if (!$isTextNode(node)) {
          return;
        }
        const selection = $createRangeSelection();
        selection.setTextNodeRange(node, match.start, node, match.end);
        $setSelection(selection);
        selection.insertText(value);
      },
      { discrete: true }
    );
  };

  useEffect(() => {
    suggestionsBox.current
      ?.querySelector<HTMLElement>(".selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [contextIndex]);

  const contextRequestActive = useRef(false);
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const { context: nextContext, command: nextCommand } = editorState.read(
          () => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
              return {};
            }
            const { anchor } = selection;
            const node = anchor.getNode();
            if (!$isTextNode(node)) {
              return {};
            }
            const text = node.getTextContent();
            return {
              command:
                node.getTopLevelElement() === $getRoot().getFirstChild()
                  ? slashCommand(text, anchor.offset, node.getKey())
                  : undefined,
              context: composerContext(text, anchor.offset, node.getKey()),
            };
          }
        );
        if (nextContext && !contextRequestActive.current) {
          postMessage({ type: "contextItems" });
        }
        contextRequestActive.current = Boolean(nextContext);
        setContext(nextContext);
        setCommand(nextCommand);
        setContextIndex(0);
        resizeComposer(box.current);
      }),
    [editor]
  );

  useEffect(() => {
    editor.setEditable(!setup && Boolean(selected?.agentId));
  }, [editor, selected?.agentId, setup]);

  useEffect(() => {
    const threadId = selected?.id ?? null;
    if (activeThread.current === threadId) {
      return;
    }
    if (isNonEmpty(activeThread.current)) {
      draftsByThread.current.set(activeThread.current, {
        images,
        text: getComposerText(),
      });
    }
    activeThread.current = threadId;
    contextRequestActive.current = false;
    const threadDraft = isNonEmpty(threadId)
      ? draftsByThread.current.get(threadId)
      : undefined;
    updateComposerText(threadDraft?.text ?? "");
    setImages(threadDraft?.images ?? []);
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
    updateComposerText(
      [getComposerText(), ...drafts].filter(Boolean).join("\n\n")
    );
    consumedDrafts.current = draftKey;
    box.current?.focus();
    postMessage({ type: "draftsConsumed" });
  }, [selected?.drafts, selected?.id]);

  useEffect(() => {
    setMissingAnswer(false);
    if (selected?.agentId || setup) {
      editor.focus();
    }
  }, [editor, selected?.agentId, selected?.interaction?.id, setup]);

  const send = (): void => {
    if (setup) {
      postMessage({ selected: setupSelected, type: "setupContinue" });
      return;
    }
    const text = getComposerText();
    if (selected?.interaction?.kind === "elicitation") {
      if (respondToElicitation(selected.interaction, text)) {
        setMissingAnswer(false);
        updateComposerText("");
        setContext(undefined);
        setCommand(undefined);
      } else {
        setMissingAnswer(true);
      }
      return;
    }
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
    updateComposerText("");
    setImages([]);
    setContext(undefined);
    setCommand(undefined);
  };

  const selectContext = (item: string): void => {
    const value = item.endsWith("/") ? item : `${item} `;
    replaceComposerRange(context, `@${value}`);
    setContext(undefined);
    contextRequestActive.current = false;
    window.requestAnimationFrame(() => {
      editor.focus();
    });
  };

  const selectCommand = (item: ThreadCommand): void => {
    const value = `/${item.name}${item.inputHint === undefined ? "" : " "}`;
    replaceComposerRange(command, value);
    setCommand(undefined);
    window.requestAnimationFrame(() => {
      editor.focus();
    });
  };

  const selectSkill = (item: ThreadCommand): void => {
    const value = `/${item.name} `;
    editor.update(
      () => {
        $getRoot().selectStart();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(value);
        }
      },
      { discrete: true }
    );
    setContext(undefined);
    setCommand(undefined);
    contextRequestActive.current = false;
    window.requestAnimationFrame(() => {
      editor.focus();
    });
  };

  const handleShiftEnter = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter" || !event.shiftKey) {
      return;
    }
    let inserted = false;
    editor.update(
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }
        const node = selection.anchor.getNode();
        const listItem = $isListItemNode(node)
          ? node
          : node.getParents().find($isListItemNode);
        if (listItem) {
          const nextItem = $createListItemNode();
          listItem.insertAfter(nextItem);
          nextItem.selectStart();
          inserted = true;
          return;
        }
        const quote = $isQuoteNode(node)
          ? node
          : node.getParents().find($isQuoteNode);
        if (quote) {
          const paragraph = $createParagraphNode();
          quote.insertAfter(paragraph);
          paragraph.selectStart();
          inserted = true;
        } else if (!$isCodeNode(node) && !node.getParents().some($isCodeNode)) {
          selection.insertParagraph();
          inserted = true;
        }
      },
      { discrete: true }
    );
    if (inserted) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (
      selected?.interaction?.kind !== "elicitation" &&
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

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!("clipboardData" in event) || !event.clipboardData) {
            return false;
          }
          const files = [...event.clipboardData.items]
            .filter((item) => item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (!files.length) {
            return false;
          }
          event.preventDefault();
          for (const file of files) {
            readImage(file);
          }
          return true;
        },
        COMMAND_PRIORITY_HIGH
      ),
    [editor]
  );

  const running = Boolean(
    selected && ["running", "waiting"].includes(selected.status)
  );
  let placeholder = "Choose an Agent to start a Thread";
  if (setup) {
    placeholder = "Press Enter to continue";
  } else if (selected?.agentId) {
    placeholder = `Message ${AGENTS[selected.agentId].name} — @ to include context, / for commands`;
  }
  return (
    <footer>
      {copyNotice ? (
        <div className="toast" role="status" key={copyNotice}>
          copied to clipboard
        </div>
      ) : null}
      <div className="composer-editor">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              id="composer"
              ref={box}
              className={
                (!selected || !selected.agentId) && !setup
                  ? "composer-disabled"
                  : ""
              }
              aria-label={placeholder}
              aria-multiline="true"
              aria-placeholder={placeholder}
              placeholder={
                <div className="composer-placeholder">{placeholder}</div>
              }
              onKeyDown={handleKeyDown}
              onKeyDownCapture={handleShiftEnter}
              tabIndex={0}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
      </div>
      {missingAnswer ? (
        <div className="interaction-validation" role="alert">
          Choose an option or enter a response to the Agent request.
        </div>
      ) : null}
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
            <ImagePreview image={image} thumbnailAlt="Pasted image preview" />
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
        answering={selected?.interaction?.kind === "elicitation"}
        historyItems={historyItems}
        onJumpMessage={onJumpMessage}
        onSelectSkill={selectSkill}
        onSend={() => {
          if (running && selected?.interaction?.kind !== "elicitation") {
            postMessage({ type: "cancel" });
          } else {
            send();
          }
        }}
        selected={selected}
        setup={setup}
      />
    </footer>
  );
};

const ComposerView = (props: ComposerProps): React.JSX.Element => (
  <LexicalExtensionComposer
    contentEditable={null}
    extension={composerExtension}
  >
    <ComposerInput {...props} />
  </LexicalExtensionComposer>
);

export const Composer = memo(ComposerView);
