import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import type { ThreadUsage } from "../../../../../threads/threads";
import { postMessage } from "../../../../bridge";

const formatUsage = (value: number): string =>
  value < 1000 ? String(value) : `${Math.round(value / 1000)}k`;

const usageClass = (percent: number): string => {
  if (percent >= 90) {
    return "danger";
  }
  return percent >= 70 ? "warning" : "";
};

export const UsageControl = ({
  usage: { size, used },
}: {
  usage: ThreadUsage;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const close = (): void => {
      setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const percent = Math.round((used / size) * 100);
  const danger = usageClass(percent);
  const style: CSSProperties & Record<"--usage-percent", string> = {
    "--usage-percent": `${Math.min(100, percent)}%`,
  };
  return (
    <div id="usage-control">
      <button
        className="action"
        id="usage"
        title="Show context usage"
        aria-label={`Context usage ${percent}%`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span
          id="usage-fill"
          className={danger}
          aria-hidden="true"
          style={style}
        />
      </button>
      <div
        id="usage-menu"
        role="dialog"
        aria-label="Context usage details"
        hidden={!open}
      >
        <div id="usage-summary">
          {percent}% · {formatUsage(used)} / {formatUsage(size)}
        </div>
        <button
          className="action primary"
          id="compact"
          type="button"
          title="Compact context"
          onClick={() => {
            postMessage({ images: [], text: "/compact", type: "prompt" });
            setOpen(false);
          }}
        >
          Compact context
        </button>
      </div>
    </div>
  );
};
