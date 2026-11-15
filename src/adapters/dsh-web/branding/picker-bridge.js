(() => {
  "use strict";

  const controls = 'select, input[type="date"], input[type="color"]';
  const mounted = new Map();
  const { choice, date, color } = window.KnowWeavePickers;
  let scheduled = false;

  function labelText(node) {
    if (!node) return "";
    const copy = node.cloneNode(true);
    copy.querySelectorAll(".kw-embedded-picker, select").forEach((child) => child.remove());
    return copy.textContent.trim();
  }

  function labelFor(control) {
    const labels = control.getAttribute("aria-labelledby")?.split(/\s+/)
      .map((id) => labelText(document.getElementById(id))).filter(Boolean);
    return labels?.join(" ") || control.getAttribute("aria-label")
      || labelText(control.labels?.[0]) || control.title
      || (control.type === "color" ? "颜色" : control.type === "date" ? "日期" : "选项");
  }

  function sync(control) {
    let record = mounted.get(control);
    const label = labelFor(control);
    if (!record) {
      const root = document.createElement("div");
      root.className = "kw-embedded-picker";
      const config = {
        label,
        value: control.value,
        onChange(value) {
          // Write through the DOM setter so React's value tracker observes the
          // same input and change events as it would from a user selection.
          const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
          schedule();
        },
      };
      const picker = control instanceof HTMLSelectElement ? choice(root, { ...config, options: [] })
        : control.type === "date" ? date(root, config) : color(root, config);
      control.dataset.kwPickerSource = "";
      control.tabIndex = -1;
      control.setAttribute("aria-hidden", "true");
      control.after(root);
      record = { root, picker, signature: "" };
      mounted.set(control, record);
    }
    const { root, picker } = record;
    if (control.nextElementSibling !== root) control.after(root);
    const disabled = control.matches(":disabled");
    root.hidden = control.hidden;
    const options = control instanceof HTMLSelectElement
      ? Array.from(control.options).filter((option) => !option.hidden).map((option) => ({
        value: option.value, label: option.label,
        disabled: option.matches(":disabled"),
      }))
      : null;
    const signature = JSON.stringify([control.value, options, disabled, control.min, control.max, label]);
    if (record.signature === signature) return;
    record.signature = signature;
    if (options) picker.setOptions(options, control.value);
    else if (control.type === "date") {
      picker.setBounds(control.min, control.max);
      picker.setValue(control.value, control.value);
    } else picker.setValue(control.value);
    picker.setLabel(label);
    picker.setDisabled(disabled || (options?.every((option) => option.disabled) ?? false));
  }

  function refresh() {
    scheduled = false;
    for (const [control, { root, picker }] of mounted) {
      if (control.isConnected && control.matches(controls)) continue;
      picker.close();
      root.remove();
      mounted.delete(control);
    }
    for (const control of document.querySelectorAll(controls)) sync(control);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(refresh);
  }

  new MutationObserver((changes) => {
    if (changes.some(({ target }) => !target.parentElement?.closest(".kw-embedded-picker")
      && !(target instanceof Element && target.closest(".kw-embedded-picker")))) schedule();
  }).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "hidden", "type", "selected", "value", "label", "min", "max", "aria-label", "aria-labelledby"],
  });
  document.addEventListener("change", schedule);
  document.addEventListener("reset", schedule);
  document.addEventListener("click", (event) => {
    const label = event.target.closest?.("label");
    const record = label && mounted.get(label.control);
    if (!record || record.root.contains(event.target) || record.picker.trigger.disabled) return;
    if (event.target.closest("button, a, input, textarea")) return;
    event.preventDefault();
    record.picker.trigger.focus();
    record.picker.trigger.click();
  });
  schedule();
})();
