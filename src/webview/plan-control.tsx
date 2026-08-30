import { useState } from "react";

import { postMessage } from "./bridge";
import type { RenderedTranscriptItem } from "./protocol";
import { ThreadControlHeader } from "./thread-control";

export const PlanControl = ({
  plan,
}: {
  plan?: RenderedTranscriptItem;
}): React.JSX.Element | null => {
  const [open, setOpen] = useState(true);
  if (!plan) {
    return null;
  }
  return (
    <details
      id="plan"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <ThreadControlHeader
        action={
          <button
            className="icon"
            id="clear-plan"
            title="Clear Plan (instruct Agent)"
            aria-label="Clear Plan"
            onClick={(event) => {
              event.preventDefault();
              postMessage({ type: "clearPlan" });
            }}
          >
            Clear
          </button>
        }
        icon="plan"
        iconClassName="plan-icon"
        labelId="plan-label"
        summary
        title={plan.title || "Plan"}
      />
      <pre id="plan-body">{plan.text}</pre>
    </details>
  );
};
