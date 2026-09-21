import type { SteeringMessage } from "../../../threads/threads";
import { postMessage } from "../../bridge";
import { Icon } from "../../icon";

export const SteeringControl = ({
  messages,
}: {
  messages: SteeringMessage[];
}): React.JSX.Element => (
  <section id="steering" hidden={!messages.length}>
    <div id="steering-title">
      <span id="steering-label">
        <Icon
          className="steering-icon"
          kind="signpost"
          title={`Steering · ${messages.length}`}
        />
        Steering · {messages.length}
      </span>
      <button
        className="icon"
        id="clear-steering"
        title="Clear all steering messages"
        aria-label="Clear all steering messages"
        onClick={() => {
          postMessage({ type: "clearSteering" });
        }}
      >
        Clear all
      </button>
    </div>
    <div id="steering-body">
      {messages.map((message) => (
        <div className="steering-message" key={message.id}>
          <div className="steering-text">{message.text}</div>
          <div className="steering-actions">
            <button
              className="icon"
              title="Send immediately"
              aria-label="Send steering message immediately"
              onClick={() => {
                postMessage({ id: message.id, type: "sendSteering" });
              }}
            >
              <Icon
                className="steering-action-icon"
                kind="send"
                title="Send immediately"
              />
            </button>
            <button
              className="icon"
              title="Remove"
              aria-label="Remove steering message"
              onClick={() => {
                postMessage({ id: message.id, type: "removeSteering" });
              }}
            >
              <Icon className="steering-action-icon" kind="x" title="Remove" />
            </button>
          </div>
        </div>
      ))}
    </div>
  </section>
);
