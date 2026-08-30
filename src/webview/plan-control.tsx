import { postMessage } from "./bridge";
import { Icon } from "./icon";
import type { RenderedTranscriptItem } from "./protocol";

export const PlanControl = ({
  plan,
}: {
  plan?: RenderedTranscriptItem;
}): React.JSX.Element | null => {
  if (!plan) {
    return null;
  }
  return (
    <details id="plan" open>
      <summary id="plan-title">
        <span id="plan-label">
          <Icon
            className="plan-icon"
            kind="plan"
            title={plan.title || "Plan"}
          />
          {plan.title || "Plan"}
        </span>
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
      </summary>
      <pre id="plan-body">{plan.text}</pre>
    </details>
  );
};
