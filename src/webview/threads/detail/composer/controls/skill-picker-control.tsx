import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ThreadCommand } from "../../../../../threads/model";
import { SvgIcon } from "../../../../icon";
import { skillPickerGroups } from "./skill-picker";

export const SkillPickerControl = ({
  commands,
  onSelect,
}: {
  commands: ThreadCommand[];
  onSelect: (command: ThreadCommand) => void;
}): React.JSX.Element => {
  const control = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const resultsBox = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [bottom, setBottom] = useState(28);
  const [left, setLeft] = useState(8);
  const [maxHeight, setMaxHeight] = useState(500);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const groups = useMemo(
    () => skillPickerGroups(commands, query),
    [commands, query]
  );
  const flatEntries = groups.flatMap((group) => group.entries);
  const hasSkills = commands.some(
    ({ name }) => name.startsWith("skill:") && name.length > "skill:".length
  );

  useLayoutEffect(() => {
    if (open) {
      searchBox.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= flatEntries.length) {
      setActiveIndex(Math.max(0, flatEntries.length - 1));
    }
    const results = resultsBox.current;
    const selected = results?.querySelector<HTMLElement>(".selected");
    if (results && selected) {
      const resultsBounds = results.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      if (selectedBounds.top < resultsBounds.top) {
        results.scrollTop -= resultsBounds.top - selectedBounds.top;
      } else if (selectedBounds.bottom > resultsBounds.bottom) {
        results.scrollTop += selectedBounds.bottom - resultsBounds.bottom;
      }
    }
  }, [activeIndex, flatEntries.length]);

  useEffect(() => {
    const close = (): void => {
      setOpen(false);
      setQuery("");
      button.current?.focus();
    };
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        control.current?.contains(event.target) !== true
      ) {
        close();
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    if (open) {
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", escape);
    }
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!hasSkills) {
      setOpen(false);
    }
  }, [hasSkills]);

  return (
    <div id="skill-picker-control" ref={control}>
      <button
        ref={button}
        id="skill-picker-button"
        className="action"
        type="button"
        title="Skills"
        aria-label="Skills"
        aria-controls="skill-picker-popup"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!hasSkills}
        onClick={(event) => {
          if (open) {
            setOpen(false);
            setQuery("");
            return;
          }
          const footer = event.currentTarget.closest("footer");
          const bounds = footer?.getBoundingClientRect();
          const width =
            bounds !== undefined && bounds.width > 0
              ? bounds.width
              : window.innerWidth;
          const popupWidth = Math.min(500, width - 16);
          const buttonBounds = event.currentTarget.getBoundingClientRect();
          const clippingTop =
            footer?.closest("#thread")?.getBoundingClientRect().top ?? 0;
          setBottom(
            Math.max(
              0,
              (bounds?.bottom ?? window.innerHeight) - buttonBounds.top
            )
          );
          setMaxHeight(
            Math.max(
              120,
              Math.min(
                buttonBounds.top > 0 ? buttonBounds.top : window.innerHeight,
                window.innerHeight
              ) -
                Math.max(0, clippingTop) -
                8
            )
          );
          setLeft(
            Math.max(
              8,
              Math.min(
                buttonBounds.left - (bounds?.left ?? 0),
                width - popupWidth - 8
              )
            )
          );
          setQuery("");
          setOpen(true);
        }}
      >
        <SvgIcon kind="draftingCompass" />
      </button>
      {open ? (
        <div
          id="skill-picker-popup"
          role="dialog"
          aria-label="Skill picker"
          style={{ bottom, left, maxHeight }}
        >
          <div id="skill-picker-header">
            <div id="skill-picker-title">Skills</div>
            <input
              ref={searchBox}
              id="skill-picker-search"
              type="search"
              placeholder="Search skills"
              role="combobox"
              aria-label="Search skills"
              aria-autocomplete="list"
              aria-controls="skill-picker-results"
              aria-expanded="true"
              aria-activedescendant={
                flatEntries.length
                  ? `skill-picker-option-${activeIndex}`
                  : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (!flatEntries.length) {
                  return;
                }
                if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
                  event.preventDefault();
                }
                if (event.key === "ArrowDown") {
                  setActiveIndex((activeIndex + 1) % flatEntries.length);
                } else if (event.key === "ArrowUp") {
                  setActiveIndex(
                    (activeIndex + flatEntries.length - 1) % flatEntries.length
                  );
                } else if (event.key === "Enter") {
                  const entry = flatEntries[activeIndex];
                  if (entry !== undefined) {
                    onSelect(entry.command);
                    setOpen(false);
                    setQuery("");
                  }
                }
              }}
            />
          </div>
          <div id="skill-picker-results" ref={resultsBox} role="listbox">
            {groups.length ? (
              groups.map(({ entries, name, source }) => (
                <div
                  aria-label={name}
                  className="skill-picker-group"
                  key={source ?? "ungrouped"}
                  role="group"
                >
                  <div className="skill-picker-group-name">{name}</div>
                  {entries.map(({ command, label }) => {
                    const index = flatEntries.findIndex(
                      (entry) => entry.command === command
                    );
                    return (
                      <button
                        className={`skill-picker-entry${index === activeIndex ? " selected" : ""}`}
                        id={`skill-picker-option-${index}`}
                        key={command.name}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        onMouseEnter={() => {
                          setActiveIndex(index);
                        }}
                        onClick={() => {
                          onSelect(command);
                          setOpen(false);
                          setQuery("");
                        }}
                      >
                        <span className="skill-picker-name">{label}</span>
                        <span className="skill-picker-description">
                          {command.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              <div className="skill-picker-empty">No matching skills</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
