import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_DELAY = 350;

interface TooltipState {
  container: Element;
  style: CSSProperties;
  text: string;
}

const buttonAt = (target: EventTarget | null): HTMLButtonElement | null =>
  target instanceof Element
    ? target.closest<HTMLButtonElement>("button[title]")
    : null;

const tooltipState = (
  button: HTMLButtonElement,
  point?: { x: number; y: number }
): TooltipState => {
  const bounds = button.getBoundingClientRect();
  const x = point?.x ?? bounds.left + bounds.width / 2;
  const y = point?.y;
  const right = x >= window.innerWidth / 2;
  const above = (y ?? bounds.top) >= window.innerHeight / 2;
  return {
    container: button.closest("dialog") ?? document.body,
    style: {
      ...(right
        ? { right: Math.max(6, window.innerWidth - x + 10) }
        : { left: Math.max(6, x + 10) }),
      ...(above
        ? { bottom: Math.max(6, window.innerHeight - (y ?? bounds.top) + 10) }
        : { top: Math.max(6, (y ?? bounds.bottom) + 10) }),
    },
    text: button.title,
  };
};

export const ButtonTooltip = (): React.JSX.Element | null => {
  const [tooltip, setTooltip] = useState<TooltipState>();
  useEffect(() => {
    let pending: HTMLButtonElement | undefined;
    let timer: number | undefined;
    const show = (button: HTMLButtonElement, next: TooltipState): void => {
      if (pending === button) {
        return;
      }
      pending = button;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTooltip(next), TOOLTIP_DELAY);
    };
    const hide = (): void => {
      pending = undefined;
      window.clearTimeout(timer);
      setTooltip(undefined);
    };
    const showHover = (event: MouseEvent): void => {
      const button = buttonAt(event.target);
      if (button) {
        show(
          button,
          tooltipState(button, { x: event.clientX, y: event.clientY })
        );
      }
    };
    const hideHover = (event: MouseEvent): void => {
      const button = buttonAt(event.target);
      if (button && button !== buttonAt(event.relatedTarget)) {
        hide();
      }
    };
    const showFocus = (event: FocusEvent): void => {
      const button = buttonAt(event.target);
      if (button) {
        show(button, tooltipState(button));
      }
    };
    const hideFocus = (event: FocusEvent): void => {
      if (buttonAt(event.target) !== buttonAt(event.relatedTarget)) {
        hide();
      }
    };
    document.addEventListener("mouseover", showHover);
    document.addEventListener("mouseout", hideHover);
    document.addEventListener("focusin", showFocus);
    document.addEventListener("focusout", hideFocus);
    return () => {
      document.removeEventListener("mouseover", showHover);
      document.removeEventListener("mouseout", hideHover);
      document.removeEventListener("focusin", showFocus);
      document.removeEventListener("focusout", hideFocus);
      window.clearTimeout(timer);
    };
  }, []);
  return tooltip
    ? createPortal(
        <div id="button-tooltip" role="tooltip" style={tooltip.style}>
          {tooltip.text}
        </div>,
        tooltip.container
      )
    : null;
};
