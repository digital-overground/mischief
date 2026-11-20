import { ConfigControl as SharedConfigControl } from "../../../../../../../shared/webview/config-control";
import type { AgentId } from "../../../../../agents/update";
import type { ThreadConfigOption } from "../../../../../threads/model";
import { postMessage } from "../../../../bridge";

export const ConfigControl = ({
  agentId,
  config,
}: {
  agentId: AgentId;
  config: ThreadConfigOption;
}): React.JSX.Element => (
  <SharedConfigControl
    agentId={agentId}
    config={config}
    onChange={(value) => {
      postMessage({ id: config.id, type: "setConfig", value });
    }}
  />
);
