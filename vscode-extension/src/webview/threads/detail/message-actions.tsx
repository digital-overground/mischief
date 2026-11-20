import { isNonEmpty } from "../../../present";
import { postMessage } from "../../bridge";
import { SvgIcon } from "../../icon";
import type { RenderedTranscriptItem } from "../../protocol";

const preview = (item: RenderedTranscriptItem): string => {
  if (isNonEmpty(item.text)) {
    return item.text;
  }
  return item.kind === "user" ? "Image prompt" : "Agent response";
};

export const MessageActions = ({
  item,
  onAction,
  selected,
}: {
  item: RenderedTranscriptItem;
  onAction?: () => void;
  selected?: {
    forkSupported?: boolean;
    id: string | null;
    sessionOperation?: string;
    status: string;
    treeNavigationSupported?: boolean;
  };
}): React.JSX.Element | null => {
  const threadId = selected?.id;
  const actionable =
    isNonEmpty(threadId) &&
    selected?.status === "idle" &&
    selected.sessionOperation === undefined &&
    (item.kind === "user" || item.kind === "assistant") &&
    item.id.startsWith(`${item.kind}:`) &&
    item.id.length > item.kind.length + 1 &&
    item.queued === undefined &&
    item.cancelled !== true;
  const canFork =
    actionable && item.kind === "user" && selected?.forkSupported === true;
  const canRollback = actionable && selected?.treeNavigationSupported === true;
  if (!canFork && !canRollback) {
    return null;
  }
  return (
    <div
      aria-label="Message actions"
      className="message-actions"
      onMouseUp={(event) => {
        event.stopPropagation();
      }}
      role="group"
    >
      {canFork ? (
        <button
          type="button"
          aria-label={`Fork at ${preview(item)}`}
          title="Fork here"
          onClick={() => {
            if (isNonEmpty(threadId)) {
              onAction?.();
              postMessage({
                messageId: item.id,
                threadId,
                type: "forkThread",
              });
            }
          }}
        >
          <SvgIcon kind="fork" />
        </button>
      ) : null}
      {canRollback ? (
        <button
          type="button"
          aria-label={`Rollback to ${preview(item)}`}
          title="Rollback to here"
          onClick={() => {
            if (isNonEmpty(threadId)) {
              onAction?.();
              postMessage({
                messageId: item.id,
                threadId,
                type: "navigateThreadTree",
              });
            }
          }}
        >
          <SvgIcon kind="undo2" />
        </button>
      ) : null}
    </div>
  );
};
