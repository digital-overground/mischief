type IconKind =
  | "alert"
  | "bot"
  | "brain"
  | "chat"
  | "plan"
  | "send"
  | "signpost"
  | "stop"
  | "tool"
  | "user"
  | "x";

const paths: Record<IconKind, React.ReactNode> = {
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  bot: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  brain: (
    <>
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </>
  ),
  chat: (
    <>
      <path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M8 10h8" />
      <path d="M12 6v8" />
    </>
  ),
  plan: (
    <>
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
      <path d="m3 17 2 2 4-4" />
      <rect width="6" height="6" x="3" y="4" rx="1" />
    </>
  ),
  send: (
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>
  ),
  signpost: (
    <>
      <path d="M12 13v8" />
      <path d="M12 3v3" />
      <path d="M2.354 10.354a1.207 1.207 0 0 1 0-1.708l2.06-2.06A2 2 0 0 1 5.828 6h12.344a2 2 0 0 1 1.414.586l2.06 2.06a1.207 1.207 0 0 1 0 1.708l-2.06 2.06a2 2 0 0 1-1.414.586H5.828a2 2 0 0 1-1.414-.586z" />
    </>
  ),
  stop: <rect width="18" height="18" x="3" y="3" rx="2" />,
  tool: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-8 8l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 8-8z" />
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
};

export const SvgIcon = ({
  className = "",
  kind,
}: {
  className?: string;
  kind: IconKind;
}): React.JSX.Element => (
  <svg
    className={`lucide${className ? ` ${className}` : ""}`}
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    {paths[kind]}
  </svg>
);

export const Icon = ({
  className,
  kind,
  title,
}: {
  className: string;
  kind: IconKind;
  title: string;
}): React.JSX.Element => (
  <span className={className} title={title} role="img" aria-label={title}>
    <SvgIcon kind={kind} />
  </span>
);
