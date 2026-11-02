import { AGENTS } from "../agents/update";
import type { AgentId } from "../agents/update";
import { isNonEmpty } from "../present";

export const AgentIcon = ({
  id,
  icons,
}: {
  id: AgentId;
  icons?: Partial<Record<AgentId, string>>;
}): React.JSX.Element | null => {
  const src = icons?.[id];
  return isNonEmpty(src) ? (
    <span
      className="agent-icon"
      role="img"
      aria-label={AGENTS[id].name}
      title={AGENTS[id].name}
      style={{ maskImage: `url("${src}")` }}
    />
  ) : null;
};
