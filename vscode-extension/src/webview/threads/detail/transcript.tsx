import { Transcript as SharedTranscript } from "../../../../../shared/webview/transcript/transcript";
import { postMessage } from "../../bridge";
import type { RenderedSetupStep, RenderedThreadDetail } from "../../protocol";

export const Transcript = ({
  onCopied,
  onSetupOptionChange,
  selected,
  selectedSetupOptions,
  setup,
  visibleCount,
}: {
  onCopied: () => void;
  onSetupOptionChange: (id: string, checked: boolean) => void;
  selected?: RenderedThreadDetail;
  selectedSetupOptions: string[];
  setup?: RenderedSetupStep;
  visibleCount: number;
}): React.JSX.Element => (
  <SharedTranscript
    onAction={postMessage}
    onCopied={onCopied}
    onSetupOptionChange={onSetupOptionChange}
    selected={selected}
    selectedSetupOptions={selectedSetupOptions}
    setup={setup}
    visibleCount={visibleCount}
  />
);
