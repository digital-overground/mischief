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
  const openEntries = plan.planEntries?.filter(
    (entry) => entry.status !== "completed"
  );
  const completedEntries = plan.planEntries?.filter(
    (entry) => entry.status === "completed"
  );
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
      {plan.planEntries ? (
        <div id="plan-body">
          {isNonZero(completedEntries?.length) ? (
            <details className="plan-completed">
              <summary>{completedEntries.length} completed</summary>
              <ol>
                {completedEntries.map((entry, index) => (
                  <li className="plan-task completed" key={index}>
                    <Icon
                      className="plan-task-icon"
                      kind="circleCheck"
                      title="Completed"
                    />
                    <span>{entry.content}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {isNonZero(openEntries?.length) ? (
            <ol>
              {openEntries.map((entry, index) => (
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
                      kind="circle"
                      title="Pending"
                    />
                  )}
                  <span>{entry.content}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : (
        <pre id="plan-body">{plan.text}</pre>
      )}
    </details>
  );
};
