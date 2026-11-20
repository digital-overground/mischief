import { act } from "react";
// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { testValue } from "../../../../../test-value";
import { SkillPickerControl } from "./skill-picker-control";

testValue<{ IS_REACT_ACT_ENVIRONMENT?: boolean }>(
  globalThis
).IS_REACT_ACT_ENVIRONMENT = true;

const commands = [
  {
    description: "Main skill",
    name: "skill:ponytail",
    skill: true,
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Review changes",
    name: "skill:ponytail-review",
    skill: true,
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Standalone",
    name: "skill:solo",
    skill: true,
    source: "local",
  },
  { description: "Not a skill", name: "review", skill: false },
];

let root: Root;

const rectangle = (
  top: number,
  bottom: number,
  width: number,
  left = 0
): DOMRect => ({
  bottom,
  height: bottom - top,
  left,
  right: left + width,
  toJSON: () => ({}),
  top,
  width,
  x: left,
  y: top,
});

describe("Skill picker control", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<section id="thread"><footer><div id="root"></div></footer></section>';
    const container = document.querySelector<HTMLElement>("#root");
    if (!container) {
      throw new Error("Missing test root");
    }
    root = createRoot(container);
  });

  afterEach(async () => {
    await Promise.resolve();
    act(() => {
      root.unmount();
    });
  });

  test("searches grouped skills and selects with the keyboard", () => {
    let selected = "";
    act(() => {
      root.render(
        <SkillPickerControl
          commands={commands}
          onSelect={(command) => {
            selected = command.name;
          }}
        />
      );
    });
    const button = document.querySelector<HTMLButtonElement>(
      "#skill-picker-button"
    );
    const footer = document.querySelector("footer");
    const thread = document.querySelector<HTMLElement>("#thread");
    if (!footer || !thread) {
      throw new Error("Missing picker layout");
    }
    footer.getBoundingClientRect = () => rectangle(600, 700, 800, 100);
    thread.getBoundingClientRect = () => rectangle(200, 700, 800, 100);
    if (button) {
      button.getBoundingClientRect = () => rectangle(670, 692, 22, 140);
    }
    act(() => button?.click());
    const search = document.querySelector<HTMLInputElement>(
      "#skill-picker-search"
    );
    expect({
      bottom: document.querySelector<HTMLElement>("#skill-picker-popup")?.style
        .bottom,
      focus: document.activeElement,
      left: document.querySelector<HTMLElement>("#skill-picker-popup")?.style
        .left,
      maxHeight: document.querySelector<HTMLElement>("#skill-picker-popup")
        ?.style.maxHeight,
      title: document.querySelector("#skill-picker-title")?.textContent,
    }).toStrictEqual({
      bottom: "30px",
      focus: search,
      left: "40px",
      maxHeight: "462px",
      title: "Skills",
    });
    expect(
      [...document.querySelectorAll(".skill-picker-group")].map((group) => ({
        entries: [...group.querySelectorAll(".skill-picker-name")].map(
          (entry) => entry.textContent
        ),
        name: group.getAttribute("aria-label"),
      }))
    ).toStrictEqual([
      {
        entries: ["ponytail", "ponytail-review"],
        name: "DietrichGebert/ponytail",
      },
      { entries: ["solo"], name: "local" },
    ]);

    const value = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    );
    act(() => {
      value?.set?.call(search, "review");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...document.querySelectorAll(".skill-picker-name")].map(
        (entry) => entry.textContent
      )
    ).toStrictEqual(["ponytail-review"]);
    act(() => {
      value?.set?.call(search, "");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    act(() => {
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect(selected).toBe("skill:ponytail-review");
    expect(document.querySelector("#skill-picker-popup")).toBeNull();
  });

  test("disables an empty picker and restores focus after dismissal", () => {
    act(() => {
      root.render(
        <SkillPickerControl commands={commands} onSelect={() => {}} />
      );
    });
    const button = document.querySelector<HTMLButtonElement>(
      "#skill-picker-button"
    );
    act(() => button?.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("#skill-picker-popup")).toBeNull();

    act(() => button?.click());
    act(() => {
      root.render(
        <SkillPickerControl
          commands={[
            { description: "New skill", name: "skill:updated", skill: true },
          ]}
          onSelect={() => {}}
        />
      );
    });
    expect(document.querySelector(".skill-picker-name")?.textContent).toBe(
      "updated"
    );
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect({
      focus: document.activeElement,
      popup: document.querySelector("#skill-picker-popup"),
    }).toStrictEqual({ focus: button, popup: null });

    act(() => {
      root.render(
        <SkillPickerControl
          commands={[{ description: "Command", name: "review", skill: false }]}
          onSelect={() => {}}
        />
      );
    });
    expect(button?.disabled).toBeTruthy();
  });
});
