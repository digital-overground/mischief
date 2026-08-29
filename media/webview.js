const $ = (id) => document.querySelector(`#${id}`);

const iconButton = (text, title, click) => {
  const button = document.createElement("button");
  button.className = "icon";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", click);
  return button;
};

const compactTime = (value) => {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};

const indicatorKind = (thread) => {
  if (
    ["active", "waiting", "completed", "idle", "error"].includes(
      thread.indicator
    )
  ) {
    return thread.indicator;
  }
  if (thread.status === "running") {
    return "active";
  }
  if (thread.status === "waiting") {
    return "waiting";
  }
  if (thread.status === "error") {
    return "error";
  }
  return "idle";
};

const indicatorLabel = (kind) => {
  if (kind === "active") {
    return "Agent active";
  }
  if (kind === "waiting") {
    return "Waiting for user input";
  }
  if (kind === "completed") {
    return "Completed — needs attention";
  }
  if (kind === "error") {
    return "Agent error — needs attention";
  }
  return "Idle";
};

const configKind = (config) => {
  const id = String(config.id || "").toLowerCase();
  const name = String(config.name || "").toLowerCase();
  if (id === "model" || name === "model") {
    return "model";
  }
  if (isProfileConfig(config)) {
    return "profile";
  }
  if (
    id === "thought_level" ||
    id === "thinking" ||
    name.includes("thinking")
  ) {
    return "thinking";
  }
  return "";
};

const displayModelName = (name) => {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(slash + 1) : name;
};

const isProfileConfig = (config) => {
  const id = String(config.id || "").toLowerCase();
  const name = String(config.name || "").toLowerCase();
  return (
    id === "role" || id === "profile" || name === "role" || name === "profile"
  );
};

const formatUsage = (value) =>
  value < 1000 ? String(value) : `${Math.round(value / 1000)}k`;

const option = (value, name) => {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = name;
  return item;
};

const markdownBody = (item, className = "body markdown") => {
  const body = document.createElement("div");
  body.className = className;
  if (item.html) {
    body.innerHTML = item.html;
  } else {
    body.textContent = item.text || "";
  }
  return body;
};

const imageGallery = (images) => {
  const gallery = document.createElement("div");
  gallery.className = "transcript-images";
  for (const image of images || []) {
    const preview = document.createElement("img");
    preview.alt = "Attached image";
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    gallery.append(preview);
  }
  return gallery;
};

const labelledPre = (label, text) => {
  const container = document.createElement("div");
  const heading = document.createElement("b");
  heading.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  container.append(heading, pre);
  return container;
};

const linkButton = (label, click) => {
  const button = document.createElement("button");
  button.className = "link";
  button.textContent = label;
  button.addEventListener("click", click);
  return button;
};

const actionButton = (label, click, primary = false) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action${primary ? " primary" : ""}`;
  button.textContent = label;
  button.addEventListener("click", click);
  return button;
};

const empty = (container, text) => {
  const message = document.createElement("div");
  message.className = "empty";
  message.textContent = text;
  container.append(message);
};

(() => {
  const { postMessage } = acquireVsCodeApi();
  let state = {
    projects: { projects: [], ungrouped: [] },
    threads: { attentionCount: 0, threads: [] },
  };
  let renderedThread;
  let consumedDrafts = "";
  let brailleFrame = 0;
  let images = [];
  let contextItems = [];
  let contextMatches = [];
  let contextIndex = 0;
  let contextStart = -1;
  let contextWorkspace;
  const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const openTools = new Set();
  const panes = [...document.querySelectorAll("main > section")];
  const MIN_PANE_HEIGHT = 72;
  const COLLAPSED_PANE_HEIGHT = 26;

  $("add").addEventListener("click", () => postMessage({ type: "add" }));
  $("refresh").addEventListener("click", () =>
    postMessage({ type: "refresh" })
  );
  $("new-thread").addEventListener("click", () =>
    postMessage({ type: "newThread" })
  );
  $("rename-thread").addEventListener("click", () =>
    postMessage({ type: "renameThread" })
  );
  $("send").addEventListener("click", () => {
    if (
      state.threads.selected &&
      ["running", "waiting"].includes(state.threads.selected.status)
    ) {
      postMessage({ type: "cancel" });
    } else {
      send();
    }
  });
  const contextSuggestions = $("context-suggestions");
  const composerContext = () => {
    const box = $("composer");
    const before = box.value.slice(0, box.selectionStart);
    const match = before.match(/(?:^|\s)@(?<query>[^\s]*)$/u);
    if (!match) {
      return;
    }
    return {
      query: match.groups.query.toLowerCase().replaceAll("\\", "/"),
      start: before.length - match.groups.query.length - 1,
    };
  };

  const renderContextSuggestions = () => {
    contextSuggestions.replaceChildren();
    contextSuggestions.hidden = !contextMatches.length;
    for (const [index, item] of contextMatches.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === contextIndex ? "selected" : "";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === contextIndex));
      button.textContent = `@${item}`;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectContext(item);
      });
      contextSuggestions.append(button);
    }
  };

  const updateContextSuggestions = () => {
    const context = composerContext();
    if (!context) {
      contextMatches = [];
      contextStart = -1;
      renderContextSuggestions();
      return;
    }
    contextStart = context.start;
    const directory = context.query.endsWith("/")
      ? context.query
      : context.query.slice(0, context.query.lastIndexOf("/") + 1);
    contextMatches = contextItems
      .filter((item) => {
        const candidate = item.toLowerCase();
        if (!directory) {
          return candidate.includes(context.query);
        }
        const remainder = candidate.slice(directory.length);
        return (
          candidate.startsWith(directory) &&
          remainder.split("/").filter(Boolean).length === 1
        );
      })
      .slice(0, 50);
    contextIndex = 0;
    renderContextSuggestions();
  };

  const selectContext = (item) => {
    const box = $("composer");
    const end = box.selectionStart;
    const directory = item.endsWith("/");
    const value = directory ? item : `${item} `;
    box.value = `${box.value.slice(0, contextStart)}@${value}${box.value.slice(end)}`;
    const cursor = contextStart + value.length + 1;
    box.setSelectionRange(cursor, cursor);
    contextMatches = [];
    renderContextSuggestions();
    box.focus();
  };

  $("composer").addEventListener("input", updateContextSuggestions);
  $("composer").addEventListener("keydown", (event) => {
    if (
      contextMatches.length &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "Escape") {
        contextMatches = [];
      } else if (event.key === "ArrowDown") {
        contextIndex = (contextIndex + 1) % contextMatches.length;
      } else if (event.key === "ArrowUp") {
        contextIndex =
          (contextIndex + contextMatches.length - 1) % contextMatches.length;
      } else {
        selectContext(contextMatches[contextIndex]);
        return;
      }
      renderContextSuggestions();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  const setupPanes = () => {
    for (const pane of panes) {
      const header = pane.querySelector(":scope > header");
      const toggle = header.querySelector(":scope > .heading");
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-expanded", "true");
      header.addEventListener("click", (event) => {
        if (event.target.closest("button")) {
          return;
        }
        togglePane(pane);
      });
      toggle.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        togglePane(pane);
      });
    }
    for (const resizer of document.querySelectorAll(".resizer")) {
      setupResizer(resizer);
    }
    rebalancePanes();
  };

  const togglePane = (pane) => {
    const collapsed = !pane.classList.contains("collapsed");
    const toggle = pane.querySelector(":scope > header > .heading");
    if (collapsed) {
      pane.dataset.expandedHeight = pane.getBoundingClientRect().height;
    }
    pane.classList.toggle("collapsed", collapsed);
    pane.style.flexBasis = `${
      collapsed
        ? COLLAPSED_PANE_HEIGHT
        : Number(pane.dataset.expandedHeight) || MIN_PANE_HEIGHT
    }px`;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    rebalancePanes();
  };

  const rebalancePanes = () => {
    const expanded = panes.filter(
      (pane) => !pane.classList.contains("collapsed")
    );
    for (const pane of panes) {
      pane.style.flexGrow = "0";
    }
    if (expanded.length) {
      expanded.at(-1).style.flexGrow = "1";
    }
  };

  const setupResizer = (resizer) => {
    let previousY;
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !resizePanes(resizer, 0)) {
        return;
      }
      event.preventDefault();
      previousY = event.clientY;
      resizer.classList.add("active");
      resizer.setPointerCapture(event.pointerId);
    });
    resizer.addEventListener("pointermove", (event) => {
      if (previousY === undefined) {
        return;
      }
      resizePanes(resizer, event.clientY - previousY);
      previousY = event.clientY;
    });
    const stop = () => {
      previousY = undefined;
      resizer.classList.remove("active");
    };
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
    resizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }
      event.preventDefault();
      resizePanes(resizer, event.key === "ArrowUp" ? -12 : 12);
    });
  };

  const resizePanes = (resizer, delta) => {
    const before = $(resizer.dataset.before);
    const after = $(resizer.dataset.after);
    if (
      before.classList.contains("collapsed") ||
      after.classList.contains("collapsed")
    ) {
      return false;
    }
    const beforeHeight = before.getBoundingClientRect().height;
    const afterHeight = after.getBoundingClientRect().height;
    const total = beforeHeight + afterHeight;
    if (total < MIN_PANE_HEIGHT * 2) {
      return false;
    }
    const nextBefore = Math.max(
      MIN_PANE_HEIGHT,
      Math.min(total - MIN_PANE_HEIGHT, beforeHeight + delta)
    );
    before.style.flexBasis = `${nextBefore}px`;
    after.style.flexBasis = `${total - nextBefore}px`;
    before.dataset.expandedHeight = nextBefore;
    after.dataset.expandedHeight = total - nextBefore;
    rebalancePanes();
    return true;
  };

  const removeAttachmentButton = (image) =>
    iconButton("×", "Remove pasted image", () => {
      images = images.filter((candidate) => candidate !== image);
      renderAttachments();
    });

  const renderAttachments = () => {
    const container = $("attachments");
    container.replaceChildren();
    for (const image of images) {
      const attachment = document.createElement("div");
      attachment.className = "attachment";
      const preview = document.createElement("img");
      preview.alt = "Pasted image";
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      const remove = removeAttachmentButton(image);
      attachment.append(preview, remove);
      container.append(attachment);
    }
  };

  const readImage = (file) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result);
      images.push({
        data: result.slice(result.indexOf(",") + 1),
        mimeType: file.type,
      });
      renderAttachments();
    });
    reader.readAsDataURL(file);
  };

  $("composer").addEventListener("paste", (event) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    for (const file of files) {
      readImage(file);
    }
  });

  const send = () => {
    const box = $("composer");
    const text = box.value;
    if ((!text.trim() && !images.length) || !state.threads.selected) {
      return;
    }
    postMessage({ images, text, type: "prompt" });
    box.value = "";
    images = [];
    renderAttachments();
  };

  const workspaceRow = (workspace, removable = false) => {
    const row = document.createElement("div");
    row.className = `row${workspace.current ? " selected" : ""}`;
    const open = document.createElement("button");
    open.className = "row-open";
    open.title = workspace.path;
    open.addEventListener("click", () =>
      postMessage({ path: workspace.path, type: "openWorkspace" })
    );
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = (workspace.current ? "● " : "") + workspace.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [
      workspace.branch,
      workspace.linked ? "worktree" : "",
      workspace.changes ? `✎${workspace.changes}` : "",
      workspace.ahead ? `↑${workspace.ahead}` : "",
      workspace.behind ? `↓${workspace.behind}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    open.append(name, meta);
    row.append(open);
    if (workspace.current) {
      row.append(
        iconButton("＋", "New Thread", (event) => {
          event.stopPropagation();
          postMessage({ type: "newThread" });
        })
      );
    }
    if (removable) {
      row.append(
        iconButton("×", "Remove membership", () =>
          postMessage({ path: workspace.path, type: "removeMembership" })
        )
      );
    }
    return row;
  };

  const projectGroup = (project) => {
    const fragment = document.createDocumentFragment();
    const row = document.createElement("div");
    row.className = "group-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = project.name;
    row.append(
      name,
      iconButton("×", "Remove membership", () =>
        postMessage({ path: project.root, type: "removeMembership" })
      )
    );
    fragment.append(
      row,
      ...project.workspaces.map((workspace) => workspaceRow(workspace))
    );
    return fragment;
  };

  const renderProjects = () => {
    const list = $("project-list");
    list.replaceChildren();
    for (const project of state.projects.projects) {
      list.append(projectGroup(project));
    }
    if (state.projects.ungrouped.length) {
      const heading = document.createElement("div");
      heading.className = "group-row";
      heading.textContent = "Ungrouped";
      list.append(heading);
      for (const workspace of state.projects.ungrouped) {
        list.append(workspaceRow(workspace, true));
      }
    }
    if (!state.projects.projects.length && !state.projects.ungrouped.length) {
      empty(list, "No managed Workspaces. Add one with ＋.");
    }
  };

  const statusIndicator = (kind, label = indicatorLabel(kind)) => {
    const indicator = document.createElement("span");
    indicator.className = `thread-status ${kind}`;
    indicator.textContent =
      kind === "active" ? brailleFrames[brailleFrame] : "";
    indicator.title = label;
    indicator.setAttribute("role", "img");
    indicator.setAttribute("aria-label", label);
    return indicator;
  };

  const renderAttention = () => {
    const badge = $("threads-attention");
    const attention = state.threads.threads.filter(
      (thread) =>
        thread.needsAttention ||
        ["waiting", "completed", "error"].includes(indicatorKind(thread))
    );
    badge.replaceChildren();
    badge.hidden = !attention.length;
    if (!attention.length) {
      return;
    }
    const waiting = attention.some((thread) =>
      ["waiting", "error"].includes(indicatorKind(thread))
    );
    const completed = attention.some(
      (thread) => indicatorKind(thread) === "completed"
    );
    if (waiting) {
      badge.append(statusIndicator("waiting", "Thread waiting for user input"));
    }
    if (completed) {
      badge.append(
        statusIndicator("completed", "Thread completed while unread")
      );
    }
    const count = document.createElement("span");
    count.textContent = String(attention.length);
    badge.append(count);
    badge.title =
      attention.length +
      (attention.length === 1
        ? " Thread needs attention"
        : " Threads need attention");
    badge.setAttribute("aria-label", badge.title);
  };

  const updateThreadIndicators = () => {
    for (const indicator of document.querySelectorAll(
      ".thread-status.active"
    )) {
      indicator.textContent = brailleFrames[brailleFrame];
    }
  };

  const renderThreads = () => {
    const list = $("thread-list");
    list.replaceChildren();
    const { selected } = state.threads;
    $("threads-title").textContent = state.threads.workspace
      ? "Threads"
      : "Threads";
    $("new-thread").disabled = !state.threads.workspace;
    renderAttention();
    for (const thread of state.threads.threads) {
      const row = document.createElement("div");
      row.className = `row${selected?.id === thread.id ? " selected" : ""}`;
      const open = document.createElement("button");
      open.className = "row-open";
      open.addEventListener("click", () =>
        postMessage({ id: thread.id, type: "selectThread" })
      );
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = thread.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${thread.status}  ${compactTime(thread.updatedAt)}`;
      open.append(statusIndicator(indicatorKind(thread)), name, meta);
      row.append(
        open,
        iconButton("×", "Remove Thread", () =>
          postMessage({ id: thread.id, type: "removeThread" })
        )
      );
      list.append(row);
    }
    if (!state.threads.workspace) {
      empty(list, "Open a managed Workspace.");
    } else if (!state.threads.threads.length) {
      empty(list, "No durable Threads yet.");
    }
  };

  const icons = {
    alert:
      '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>',
    bot: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>',
    brain:
      '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg>',
    plan: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path><path d="m3 17 2 2 4-4"></path><rect width="6" height="6" x="3" y="4" rx="1"></rect></svg>',
    tool: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-8 8l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 8-8z"></path></svg>',
    user: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
  };

  const entryMeta = {
    assistant: { icon: "bot", label: "Pi" },
    system: { icon: "alert", label: "Mischief" },
    thought: { icon: "brain", label: "Thinking" },
    user: { icon: "user", label: "You" },
  };

  const appendOptions = (select, config, kind) => {
    if (kind === "model") {
      const groups = new Map();
      for (const item of config.options) {
        if (!("value" in item)) {
          const group = document.createElement("optgroup");
          group.label = item.name;
          for (const child of item.options) {
            group.append(option(child.value, displayModelName(child.name)));
          }
          select.append(group);
          continue;
        }
        const slash = item.name.indexOf("/");
        if (slash < 1) {
          select.append(option(item.value, item.name));
          continue;
        }
        const provider = item.name.slice(0, slash);
        let group = groups.get(provider);
        if (!group) {
          group = document.createElement("optgroup");
          group.label = provider;
          groups.set(provider, group);
          select.append(group);
        }
        group.append(option(item.value, displayModelName(item.name)));
      }
      return;
    }
    for (const item of config.options) {
      if ("value" in item) {
        const name =
          kind === "thinking"
            ? item.name.replace(/^Thinking:\s*/iu, "")
            : item.name;
        select.append(option(item.value, name));
      } else {
        const group = document.createElement("optgroup");
        group.label = item.name;
        for (const child of item.options) {
          group.append(option(child.value, child.name));
        }
        select.append(group);
      }
    }
  };

  const inlineIcon = (kind, className, title) => {
    const icon = document.createElement("span");
    icon.className = className;
    icon.title = title;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", title);
    icon.innerHTML = icons[kind];
    return icon;
  };

  const configIcons = { model: "bot", profile: "user", thinking: "brain" };
  const configIcon = (kind, title) =>
    inlineIcon(configIcons[kind], "config-icon", title);

  const renderUsage = (selected) => {
    const usage = $("usage");
    const fill = $("usage-fill");
    if (!selected?.usage || selected.usage.size <= 0) {
      usage.hidden = true;
      return;
    }
    const { used, size } = selected.usage;
    usage.hidden = false;
    fill.style.width = `${Math.min(100, (used / size) * 100)}%`;
    fill.className = "";
    if (used > 150_000) {
      fill.className = "danger";
    } else if (used >= 100_000) {
      fill.className = "warning";
    }
    usage.title = `${formatUsage(used)}/${formatUsage(size)}`;
    usage.dataset.tooltip = usage.title;
    usage.setAttribute("aria-label", `Context usage ${usage.title}`);
  };

  const renderConfig = (selected) => {
    const configs = $("configs");
    configs.replaceChildren();
    if (!selected) {
      return;
    }
    for (const config of selected.configOptions) {
      if (config.type === "boolean") {
        const label = document.createElement("label");
        label.title = config.description || config.name;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = config.currentValue;
        input.addEventListener("change", () =>
          postMessage({
            id: config.id,
            type: "setConfig",
            value: input.checked,
          })
        );
        label.append(input, config.name);
        configs.append(label);
        continue;
      }
      const kind = configKind(config);
      const select = document.createElement("select");
      select.title = config.description || config.name;
      select.setAttribute("aria-label", config.name);
      appendOptions(select, config, kind);
      select.value = config.currentValue;
      if (isProfileConfig(config) && select.selectedIndex < 0) {
        const custom = option("", "Custom");
        custom.disabled = true;
        select.prepend(custom);
        select.value = "";
      }
      select.addEventListener("change", () =>
        postMessage({
          id: config.id,
          type: "setConfig",
          value: select.value,
        })
      );
      if (kind) {
        const control = document.createElement("div");
        control.className = "config-control";
        control.append(configIcon(kind, config.name), select);
        configs.append(control);
      } else {
        configs.append(select);
      }
    }
  };

  const renderThreadControls = (selected) => {
    $("thread-title").textContent = selected?.name || "Thread";
    $("rename-thread").disabled = !selected?.id;
    renderConfig(selected);
    renderUsage(selected);
    $("notice").textContent = selected?.error || "";
    renderActions(selected);
    renderInteraction(selected?.interaction);
    renderPlan(selected);
    $("composer").disabled = !selected;
    $("processing").hidden =
      !selected || selected.status !== "running" || selected.streaming;
    const running =
      selected && ["running", "waiting"].includes(selected.status);
    const sendButton = $("send");
    sendButton.disabled = !selected;
    sendButton.title = running ? "Stop" : "Send";
    sendButton.setAttribute("aria-label", running ? "Stop" : "Send");
    sendButton.classList.toggle("stop", Boolean(running));
  };

  const renderTranscriptItems = (selected, transcript) => {
    const items = selected?.items.filter((item) => item.kind !== "plan") || [];
    transcript.replaceChildren();
    if (!selected) {
      empty(transcript, "Select a managed Workspace.");
    } else if (items.length) {
      transcript.append(...transcriptNodes(items));
    } else {
      empty(transcript, "Send a prompt to start this Thread.");
    }
  };

  const restoreDrafts = (selected) => {
    const drafts = selected?.drafts || [];
    const draftKey = `${selected?.id}:${drafts.join("\u0000")}`;
    if (!drafts.length) {
      consumedDrafts = "";
      return;
    }
    if (consumedDrafts === draftKey) {
      return;
    }
    const box = $("composer");
    box.value = [box.value, ...drafts].filter(Boolean).join("\n\n");
    consumedDrafts = draftKey;
    postMessage({ type: "draftsConsumed" });
  };

  const renderTranscript = () => {
    const { selected } = state.threads;
    const chat = $("chat");
    const changed = renderedThread !== selected?.id;
    const stick =
      changed || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
    renderedThread = selected?.id;
    if (changed) {
      openTools.clear();
    }
    renderThreadControls(selected);
    renderTranscriptItems(selected, $("transcript"));
    restoreDrafts(selected);
    if (stick) {
      chat.scrollTop = chat.scrollHeight;
    }
    if (changed && selected) {
      $("composer").focus();
    }
  };

  const renderActions = (selected) => {
    const actions = $("actions");
    actions.replaceChildren();
    if (!selected) {
      return;
    }
    if (selected.status === "error") {
      const retry = actionButton(
        "Retry",
        () => postMessage({ type: "retry" }),
        true
      );
      actions.append(retry);
    }
    if (selected.authentication) {
      actions.append(
        actionButton(
          selected.authentication.label,
          () => postMessage({ type: "authenticate" }),
          true
        )
      );
    }
  };

  const renderPlan = (selected) => {
    const plan = selected?.items.find(
      (item) => item.kind === "plan" && item.text
    );
    const title = $("plan-title");
    $("plan").hidden = !plan;
    title.replaceChildren();
    if (plan) {
      title.append(
        inlineIcon("plan", "plan-icon", "Plan"),
        plan.title || "Plan"
      );
    }
    $("plan-body").textContent = plan?.text || "";
  };

  const transcriptNodes = (items) => {
    const nodes = [];
    for (let index = 0; index < items.length;) {
      if (items[index].kind !== "thought") {
        nodes.push(transcriptItem(items[index]));
        index += 1;
        continue;
      }
      const thoughts = [];
      while (items[index]?.kind === "thought") {
        thoughts.push(items[index]);
        index += 1;
      }
      nodes.push(thinkingGroup(thoughts));
    }
    return nodes;
  };

  const thinkingGroup = (items) => {
    const group = document.createElement("section");
    const heading = document.createElement("div");
    const content = document.createElement("div");
    group.className = "entry thought thinking-group";
    heading.className = "thinking-heading";
    content.className = "thinking-content";
    heading.append(inlineIcon("brain", "entry-icon", "Thinking"), "Thinking");
    for (const item of items) {
      content.append(markdownBody(item, "thinking-item markdown"));
    }
    group.append(heading, content);
    return group;
  };

  const transcriptItem = (item) => {
    if (item.kind === "tool") {
      const details = document.createElement("details");
      details.className = "entry tool";
      details.open = openTools.has(item.id);
      details.addEventListener("toggle", () =>
        details.open ? openTools.add(item.id) : openTools.delete(item.id)
      );
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent =
        (item.title || "Tool call") + (item.status ? " · " + item.status : "");
      summary.append(inlineIcon("tool", "entry-icon", "Tool"), label);
      const body = document.createElement("div");
      body.className = "tool-body";
      if (item.input) {
        body.append(labelledPre("Input", item.input));
      }
      if (item.output) {
        body.append(labelledPre("Output", item.output));
      }
      for (const location of item.locations || []) {
        body.append(
          linkButton(
            location.path + (location.line ? ":" + location.line : ""),
            () =>
              postMessage({
                line: location.line,
                path: location.path,
                type: "openLocation",
              })
          )
        );
      }
      for (const diff of item.diffs || []) {
        body.append(
          linkButton(`Open diff · ${diff.path}`, () =>
            postMessage({ path: diff.path, type: "openDiff" })
          )
        );
      }
      details.append(summary, body);
      return details;
    }
    const article = document.createElement("article");
    const meta = entryMeta[item.kind] || entryMeta.system;
    const content = document.createElement("div");
    article.className = `entry ${item.kind}`;
    content.className = "entry-content";
    content.append(markdownBody(item));
    if (item.images?.length) {
      content.append(imageGallery(item.images));
    }
    if (item.kind === "user" || item.kind === "assistant") {
      article.append(content);
    } else {
      article.append(inlineIcon(meta.icon, "entry-icon", meta.label), content);
    }
    if (item.queued) {
      const queued = document.createElement("div");
      queued.className = "cancelled";
      queued.textContent = `Queued · position ${item.queued}`;
      content.append(queued);
    }
    if (item.cancelled) {
      const cancelled = document.createElement("div");
      cancelled.className = "cancelled";
      cancelled.textContent = "Cancelled";
      content.append(cancelled);
    }
    return article;
  };

  const renderInteraction = (interaction) => {
    const container = $("interaction");
    container.replaceChildren();
    if (!interaction) {
      return;
    }
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = interaction.message;
    container.append(message);
    if (interaction.kind === "permission") {
      const buttons = document.createElement("div");
      buttons.className = "interaction-buttons";
      for (const item of interaction.options) {
        buttons.append(
          actionButton(
            item.name,
            () =>
              postMessage({
                id: interaction.id,
                response: { action: "select", optionId: item.id },
                type: "respond",
              }),
            item.kind.startsWith("allow")
          )
        );
      }
      buttons.append(
        actionButton("Cancel", () => respondCancel(interaction.id))
      );
      container.append(buttons);
      return;
    }
    const form = document.createElement("form");
    for (const field of interaction.fields) {
      form.append(formField(field));
    }
    const buttons = document.createElement("div");
    buttons.className = "interaction-buttons";
    buttons.append(
      actionButton(
        "Submit",
        () => {
          /* empty */
        },
        true
      ),
      actionButton("Cancel", () => respondCancel(interaction.id))
    );
    const submit = buttons.firstElementChild;
    submit.type = "submit";
    form.append(buttons);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {};
      for (const field of interaction.fields) {
        const input = form.elements.namedItem(field.name);
        if (field.type === "boolean") {
          values[field.name] = input.checked;
        } else if (field.type === "multiselect") {
          values[field.name] = [...input.selectedOptions].map(
            (item) => item.value
          );
        } else if (field.required || input.value !== "") {
          values[field.name] = input.value;
        }
      }
      postMessage({
        id: interaction.id,
        response: { action: "accept", values },
        type: "respond",
      });
    });
    container.append(form);
  };

  const formField = (field) => {
    const label = document.createElement("label");
    label.textContent = field.label + (field.required ? " *" : "");
    let input;
    if (field.type === "select" || field.type === "multiselect") {
      input = document.createElement("select");
      input.multiple = field.type === "multiselect";
      if (!field.required && field.type === "select") {
        input.append(option("", ""));
      }
      for (const item of field.options || []) {
        input.append(option(item.value, item.name));
      }
      const defaults = Array.isArray(field.defaultValue)
        ? field.defaultValue
        : [field.defaultValue];
      for (const item of input.options) {
        item.selected = defaults.includes(item.value);
      }
    } else if (field.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(field.defaultValue);
    } else if (field.type === "number") {
      input = document.createElement("input");
      input.type = "number";
      input.value = field.defaultValue ?? "";
    } else {
      input = document.createElement("textarea");
      input.rows = 2;
      input.value = field.defaultValue ?? "";
    }
    input.name = field.name;
    input.required =
      field.required &&
      field.type !== "boolean" &&
      field.type !== "multiselect";
    if (field.description) {
      input.title = field.description;
    }
    label.append(input);
    return label;
  };

  const respondCancel = (id) => {
    postMessage({ id, response: { action: "cancel" }, type: "respond" });
  };

  setupPanes();

  window.addEventListener("message", (event) => {
    if (event.data?.type === "contextItems") {
      contextItems = Array.isArray(event.data.items) ? event.data.items : [];
      updateContextSuggestions();
      return;
    }
    if (event.data?.type !== "state") {
      return;
    }
    state = event.data;
    const workspaces = [
      ...(state.projects?.projects?.flatMap((project) => project.workspaces) ||
        []),
      ...(state.projects?.ungrouped || []),
    ];
    const currentWorkspace = workspaces.find(
      (workspace) => workspace.current
    )?.path;
    if (currentWorkspace !== contextWorkspace) {
      contextWorkspace = currentWorkspace;
      contextItems = [];
      postMessage({ type: "contextItems" });
    }
    document.documentElement.style.setProperty(
      "--mischief-mono-font",
      state.font
    );
    renderProjects();
    renderThreads();
    renderTranscript();
  });
  setInterval(renderThreads, 60_000);
  setInterval(() => {
    brailleFrame = (brailleFrame + 1) % brailleFrames.length;
    if (!$("processing").hidden) {
      $("braille").textContent = brailleFrames[brailleFrame];
    }
    updateThreadIndicators();
  }, 60);
  postMessage({ type: "ready" });
  postMessage({ type: "contextItems" });
})();
