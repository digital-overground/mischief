/* oxlint-disable no-await-in-loop, promise/avoid-new -- packaged-browser smoke checks poll DOM changes using browser timers. */
// Executed inside the packaged WKWebView against a disposable Host and fake Agent.
/** @param {number} milliseconds Time for the UI to commit. */
const delay = async (milliseconds) => {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};
/**
 * @param {() => boolean | undefined} predicate Condition to wait for.
 * @param {string} label Failure description.
 */
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate() === true) {
      return;
    }
    await delay(25);
  }
  throw new Error(`${label}: ${document.body.textContent?.slice(0, 800)}`);
};
/**
 * @param {boolean | undefined} condition Expected result.
 * @param {string} label Failure description.
 */
const check = (condition, label) => {
  if (condition !== true) {
    throw new Error(label);
  }
};
await waitFor(
  () =>
    [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("UI smoke Thread")
    ),
  "Thread list did not load"
);
[...document.querySelectorAll("button")]
  .find((button) => button.textContent?.includes("UI smoke Thread"))
  ?.click();
await waitFor(
  () =>
    document.querySelector(".mac-composer textarea") !== null &&
    document.querySelector("#transcript")?.textContent?.includes("History 299"),
  "Thread did not load"
);
check(
  [...document.querySelectorAll("#transcript strong")].some(
    (element) => element.textContent === "restored"
  ),
  "Restored Markdown was not rendered"
);
const composer = document.querySelector(".mac-composer textarea");
const send = [...document.querySelectorAll("button")].find(
  (button) =>
    button.closest(".mac-composer") !== null &&
    button.textContent?.includes("Send")
);
if (!(composer instanceof HTMLTextAreaElement) || send === undefined) {
  throw new Error("Composer missing");
}
/** @param {string} text Prompt to enter through React's input event. */
const type = (text) => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set?.call(composer, text);
  composer.dispatchEvent(new Event("input", { bubbles: true }));
};
/** @param {Element} element Control that must fit inside the window. */
const visible = (element) => {
  const bounds = element.getBoundingClientRect();
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.top >= 0 &&
    bounds.bottom <= innerHeight
  );
};
check(
  visible(composer) && visible(send),
  "Composer/Send is outside the visible window"
);
await waitFor(
  () =>
    document
      .querySelector('button[aria-label="Model"]')
      ?.textContent?.includes("Fast"),
  "Initial Host model was not displayed"
);
const model = document.querySelector('button[aria-label="Model"]');
if (!(model instanceof HTMLButtonElement)) {
  throw new Error("Model control missing");
}
model.click();
await waitFor(
  () =>
    [...document.querySelectorAll('button[role="option"]')].some((option) =>
      option.textContent?.includes("Deep")
    ),
  "Model menu missing"
);
[...document.querySelectorAll("button")]
  .find(
    (option) =>
      option.getAttribute("role") === "option" &&
      option.textContent?.includes("Deep")
  )
  ?.click();
await waitFor(
  () =>
    document
      .querySelector('button[aria-label="Model"]')
      ?.textContent?.includes("Deep"),
  "Confirmed model change was not displayed"
);
await waitFor(
  () =>
    document
      .querySelector('button[aria-label="Thinking"]')
      ?.textContent?.includes("High"),
  "Thinking change from the other client was not displayed"
);
type("Send smoke");
await delay(50);
send.click();
await waitFor(
  () =>
    document
      .querySelector("#transcript")
      ?.textContent?.includes("Reply to Send smoke"),
  "Send did not display the Agent reply"
);
check(composer.value === "", "Accepted prompt was not cleared");
type("Enter smoke");
await delay(50);
composer.dispatchEvent(
  new KeyboardEvent("keydown", {
    bubbles: true,
    isComposing: true,
    key: "Enter",
  })
);
composer.dispatchEvent(
  new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true })
);
check(
  composer.value === "Enter smoke" && !composer.disabled,
  "IME or Shift+Enter submitted the prompt"
);
composer.dispatchEvent(
  new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
);
await waitFor(
  () =>
    document
      .querySelector("#transcript")
      ?.textContent?.includes("Reply to Enter smoke"),
  "Enter did not display the Agent reply"
);
await waitFor(
  () =>
    document.querySelector("#transcript h2")?.textContent?.includes("Reply"),
  "Markdown heading was not rendered"
);
check(
  [...document.querySelectorAll("#transcript strong")].some(
    (element) => element.textContent === "bold"
  ),
  "Markdown emphasis missing"
);
check(
  document
    .querySelector("#transcript pre code")
    ?.textContent?.includes("const x = 1"),
  "Code fence missing"
);
check(
  document.querySelector("#transcript ul li")?.textContent === "item",
  "Markdown list missing"
);
check(
  document.querySelector(
    '#transcript script, #transcript img[onerror], #transcript a[href^="javascript:"]'
  ) === null,
  "Unsafe Markdown rendered as active content"
);
await waitFor(
  () => composer.placeholder === "Type your answer…",
  "Elicitation did not reach the composer"
);
type("Do the footer first");
await delay(50);
send.click();
await waitFor(
  () =>
    document
      .querySelector("#transcript")
      ?.textContent?.includes("Answer accepted; still working"),
  "Agent did not receive the elicitation answer"
);
await waitFor(
  () => composer.placeholder !== "Type your answer…",
  "Answered elicitation still occupies the composer"
);
check(
  !document.body.textContent?.includes("Choose the next step"),
  "Answered elicitation question remains visible"
);
const transcriptScroll = document.querySelector(".mac-transcript");
if (!(transcriptScroll instanceof HTMLDivElement)) {
  throw new Error("Transcript scroller missing");
}
check(
  transcriptScroll.scrollHeight -
    transcriptScroll.scrollTop -
    transcriptScroll.clientHeight <
    100,
  "Streaming reply did not follow the scroll tail"
);
check(
  document
    .querySelector("#transcript")
    ?.textContent?.includes("History 0\n") !== true,
  "History was not initially windowed"
);
for (let page = 0; page < 4; page += 1) {
  transcriptScroll.scrollTop = 0;
  transcriptScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await delay(150);
  if (
    document
      .querySelector("#transcript")
      ?.textContent?.includes("History 0") === true
  ) {
    break;
  }
}
await waitFor(
  () =>
    document.querySelector("#transcript")?.textContent?.includes("History 0"),
  "Scrolling did not request older Host pages"
);
check(
  transcriptScroll.scrollTop > 0,
  "Loading older messages lost the scroll anchor"
);
check(
  [...document.querySelectorAll("#transcript .entry")].filter((entry) =>
    entry.textContent?.includes("Reply to Enter smoke")
  ).length === 1,
  "Reply was duplicated"
);
const upload = document.querySelector('.mac-composer input[type="file"]');
if (!(upload instanceof HTMLInputElement)) {
  throw new Error("Image input missing");
}
const transfer = new DataTransfer();
transfer.items.add(new File([], "empty.png", { type: "image/png" }));
upload.files = transfer.files;
upload.dispatchEvent(new Event("change", { bubbles: true }));
await waitFor(
  () =>
    document
      .querySelector(".composer-images")
      ?.textContent?.includes("1 image"),
  "Image attachment missing"
);
const rejected = "Keep this draft when the Host rejects the empty image";
type(rejected);
await delay(50);
send.click();
await waitFor(
  () =>
    document
      .querySelector(".thread-notice")
      ?.textContent?.includes("Invalid Thread prompt"),
  "Rejected send did not show its error"
);
check(
  composer.value === rejected && !composer.disabled,
  "Rejected send lost the editable draft"
);
check(
  document.querySelector(".composer-images")?.textContent?.includes("1 image"),
  "Rejected send lost its image"
);
