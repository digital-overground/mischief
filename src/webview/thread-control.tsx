import { Icon } from "./icon";

export const ThreadControlHeader = ({
  action,
  icon,
  iconClassName,
  labelId,
  summary = false,
  title,
}: {
  action: React.ReactNode;
  icon: "plan" | "signpost";
  iconClassName: string;
  labelId: string;
  summary?: boolean;
  title: React.ReactNode;
}): React.JSX.Element => {
  const content = (
    <>
      <span id={labelId}>
        <Icon className={iconClassName} kind={icon} title={String(title)} />
        {title}
      </span>
      {action}
    </>
  );
  return summary ? (
    <summary id="plan-title">{content}</summary>
  ) : (
    <div id="steering-title">{content}</div>
  );
};
