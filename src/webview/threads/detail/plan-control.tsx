import { isNonZero } from "../../../present";
import { postMessage } from "../../bridge";
import { Icon } from "../../icon";
import type { RenderedTranscriptItem } from "../../protocol";

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
            title={
              plan.title !== undefined && plan.title.length > 0
                ? plan.title
                : "Plan"
            }
          />
          {plan.title !== undefined && plan.title.length > 0
            ? plan.title
            : "Plan"}
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
      {isNonZero(plan.planEntries?.length) ? (
        <ol id="plan-body">
          {plan.planEntries.map((entry, index) => (
            <li className={`plan-task ${entry.status}`} key={index}>
              {entry.status === "in_progress" ? (
                <span
                  className="plan-task-indicator"
                  role="img"
                  aria-label="In progress"
                />
              ) : (
                <Icon
                  className="plan-task-icon"
                  kind={entry.status === "completed" ? "circleCheck" : "circle"}
                  title={entry.status === "completed" ? "Completed" : "Pending"}
                />
              )}
              <span>{entry.content}</span>
            </li>
          ))}
        </ol>
      ) : (
        <pre id="plan-body">{plan.text}</pre>
      )}
    </details>
  );
};
