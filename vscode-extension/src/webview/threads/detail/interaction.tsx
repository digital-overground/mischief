import {
  Interaction as SharedInteraction,
  respondToElicitation as respond,
} from "../../../../../shared/webview/thread/interaction";
import type { ThreadInteraction } from "../../../threads/threads/models";
import { postMessage } from "../../bridge";

export { InteractionQuestion } from "../../../../../shared/webview/thread/interaction";

export const respondToElicitation = (
  interaction: ThreadInteraction,
  text: string
): boolean =>
  respond(interaction, text, (id, response) => {
    postMessage({ id, response, type: "respond" });
  });

export const Interaction = ({
  interaction,
}: {
  interaction?: ThreadInteraction;
}): React.JSX.Element | null => (
  <SharedInteraction
    interaction={interaction}
    onCancel={() => {
      postMessage({ type: "cancel" });
    }}
    onRespond={(id, response) => {
      postMessage({ id, response, type: "respond" });
    }}
  />
);
