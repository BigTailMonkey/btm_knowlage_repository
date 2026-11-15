(() => {
  "use strict";

  let nextId = 0;
  let openPicker = null;

  function element(tag, className, attributes = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  }

  function button(className, text, attributes) {
    const node = element("button", className, attributes);
    node.type = "button";
    node.textContent = text;
    return node;
  }

  function makePicker(root, { id, label, placeholder, kind, onChange, labelId }) {
    id ||= `kw-picker-${++nextId}`;
    const list = kind === "choice";
    root.classList.add("kw-picker");
    const trigger = button("kw-picker-trigger", "", {
      id, "aria-haspopup": list ? "listbox" : "dialog", "aria-expanded": "false",
      "aria-controls": `${id}-panel`,
    });
    if (list) trigger.setAttribute("role", "combobox");
    const value = element("span", "kw-picker-value", { id: `${id}-value` });
    const icon = element("span", `kw-picker-icon kw-picker-icon-${kind}`, { "aria-hidden": "true" });
    if (labelId) trigger.setAttribute("aria-labelledby", `${labelId} ${value.id}`);
    trigger.append(value, icon);

    const panel = element("div", `kw-picker-panel kw-picker-panel-${kind}`, {
      id: `${id}-panel`, popover: "manual", role: list ? "listbox" : "dialog", "aria-label": label,
    });
    root.replaceChildren(trigger, panel);

    function position() {
      const anchor = trigger.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const gap = 6;
      const edge = 8;
      if (!anchor.width || !anchor.height || anchor.bottom <= 0 || anchor.top >= height || anchor.right <= 0 || anchor.left >= width) return close();
      const desiredWidth = list ? Math.max(144, anchor.width) : 300;
      const panelWidth = Math.min(desiredWidth, width - 2 * edge);
      const below = height - anchor.bottom - gap - edge;
      const above = anchor.top - gap - edge;
      const preferredHeight = list ? 264 : kind === "date" ? 350 : 200;
      const opensUp = below < preferredHeight && above > below;
      panel.style.width = `${panelWidth}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(preferredHeight, opensUp ? above : below))}px`;
      panel.style.left = `${Math.max(edge, Math.min(anchor.left, width - panelWidth - edge))}px`;
      panel.style.top = opensUp ? "auto" : `${anchor.bottom + gap}px`;
      panel.style.bottom = opensUp ? `${height - anchor.top + gap}px` : "auto";
    }

    function close(restoreFocus = false) {
      if (openPicker?.trigger !== trigger) return;
      openPicker = null;
      if (panel.matches(":popover-open")) panel.hidePopover();
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (restoreFocus && trigger.isConnected) trigger.focus();
    }

    function open() {
      openPicker?.close();
      openPicker = { trigger, panel, close, position };
      panel.showPopover();
      trigger.setAttribute("aria-expanded", "true");
      position();
    }

    function setLabel(next) {
      label = next;
      panel.setAttribute("aria-label", label);
      if (!labelId) trigger.setAttribute("aria-label", value.textContent ? `${label}，${value.textContent}` : label);
    }

    function setValue(next, text) {
      trigger.value = next;
      value.textContent = text || placeholder || "";
      trigger.classList.toggle("kw-picker-placeholder", !text);
      if (!labelId) trigger.setAttribute("aria-label", value.textContent ? `${label}，${value.textContent}` : label);
    }

    function choose(next, text) {
      const previous = trigger.value;
      setValue(next, text);
      close(true);
      if (next === previous) return;
      onChange?.(next);
      trigger.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function setDisabled(disabled) {
      trigger.disabled = disabled;
      if (disabled) close();
    }

    trigger.addEventListener("click", () => {
      if (openPicker?.trigger === trigger) close();
      else root.dispatchEvent(new Event("kw-picker-open"));
    });
    return { trigger, panel, open, close, choose, setLabel, setValue, setDisabled };
  }

  function choice(root, config) {
    const picker = makePicker(root, { ...config, kind: "choice" });
    const { trigger, panel } = picker;
    let options = [];
    let active = -1;
    let typed = "";
    let lastKey = 0;

    function activate(index) {
      panel.children[active]?.classList.remove("is-active");
      active = index;
      const row = panel.children[active];
      if (!row) return;
      row.classList.add("is-active");
      trigger.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    }

    function move(direction) {
      const start = active < 0 ? (direction === 1 ? 0 : options.length - 1) : active + direction;
      for (let index = start; index >= 0 && index < options.length; index += direction) {
        if (!options[index].disabled) {
          activate(index);
          break;
        }
      }
    }

    function open(preferLast = false) {
      picker.open();
      const selected = options.findIndex((option) => option.value === trigger.value && !option.disabled);
      panel.children[active]?.classList.remove("is-active");
      active = -1;
      typed = "";
      if (selected >= 0) activate(selected);
      else move(preferLast ? -1 : 1);
    }

    function select(index) {
      const option = options[index];
      if (!option || option.disabled) return;
      picker.choose(option.value, option.label);
      for (const [i, row] of Array.from(panel.children).entries()) row.setAttribute("aria-selected", String(i === index));
    }

    root.addEventListener("kw-picker-open", () => open());
    panel.addEventListener("mousedown", (event) => event.preventDefault());
    panel.addEventListener("click", (event) => {
      const row = event.target.closest("[data-index]");
      if (row) select(Number(row.dataset.index));
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const expanded = openPicker?.trigger === trigger;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const backwards = event.key === "ArrowUp" || event.key === "End";
        if (!expanded) open(backwards);
        if (event.key === "Home" || event.key === "End") {
          panel.children[active]?.classList.remove("is-active");
          active = -1;
          move(backwards ? -1 : 1);
        } else if (expanded) move(backwards ? -1 : 1);
      } else if (expanded && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        select(active);
      } else if (event.key.length === 1 && event.key !== " ") {
        event.preventDefault();
        if (!expanded) open();
        const now = Date.now();
        const key = event.key.toLocaleLowerCase();
        typed = now - lastKey > 700 || typed === key ? key : typed + key;
        lastKey = now;
        const start = typed.length === 1 ? active + 1 : Math.max(active, 0);
        const ordered = options.slice(start).concat(options.slice(0, start));
        const match = ordered.find((option) => !option.disabled && option.label.toLocaleLowerCase().startsWith(typed));
        if (match) activate(options.indexOf(match));
      }
    });

    function setOptions(next, value = next[0]?.value ?? "") {
      picker.close();
      active = -1;
      options = next;
      picker.setValue(value, options.find((option) => option.value === value)?.label);
      panel.replaceChildren(...options.map((option, index) => {
        const row = element("div", "kw-picker-option", {
          id: `${panel.id}-${index}`, role: "option", "data-index": index,
          "aria-selected": String(option.value === value),
        });
        if (option.disabled) row.setAttribute("aria-disabled", "true");
        row.textContent = option.label;
        return row;
      }));
      picker.setDisabled(!options.some((option) => !option.disabled));
    }

    setOptions(config.options, config.value);
    return { ...picker, setOptions };
  }

  function dateKey(date) {
    return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function utcDate(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    return date;
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(+date) || dateKey(date) !== value || value < "0001-01-01" ? null : date;
  }

  function dayOffset(date, days) {
    return utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days);
  }

  function monthOffset(date, months) {
    const month = utcDate(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
    const last = utcDate(month.getUTCFullYear(), month.getUTCMonth() + 1, 0).getUTCDate();
    return utcDate(month.getUTCFullYear(), month.getUTCMonth(), Math.min(date.getUTCDate(), last));
  }

  function datePicker(root, config) {
    const picker = makePicker(root, { placeholder: "选择日期", ...config, kind: "date" });
    const { trigger, panel } = picker;
    const header = element("div", "kw-calendar-head");
    const previous = button("kw-picker-action", "‹", { "aria-label": "上个月" });
    const next = button("kw-picker-action", "›", { "aria-label": "下个月" });
    const monthLabel = element("strong", "", { "aria-live": "polite", id: `${panel.id}-month` });
    header.append(previous, monthLabel, next);
    const weekdays = element("div", "kw-calendar-weekdays", { "aria-hidden": "true" });
    weekdays.append(...Array.from("一二三四五六日", (day) => {
      const item = element("span");
      item.textContent = day;
      return item;
    }));
    const grid = element("div", "kw-calendar-grid", { role: "group", "aria-labelledby": monthLabel.id });
    const footer = element("div", "kw-picker-footer");
    const input = element("input", "kw-picker-entry", {
      type: "text", placeholder: "YYYY-MM-DD", "aria-label": "输入日期，格式 YYYY-MM-DD", autocomplete: "off",
    });
    const apply = button("kw-picker-action", "确定");
    const clear = button("kw-picker-action", "清除");
    const error = element("p", "kw-picker-error", { role: "status" });
    footer.append(input, apply, clear);
    panel.append(header, weekdays, grid, footer, error);
    let current, today;
    let min = "0001-01-01";
    let max = "9999-12-31";

    function inBounds(key) { return key >= min && key <= max; }

    function render(focusDay = false) {
      const year = current.getUTCFullYear();
      const month = current.getUTCMonth();
      const first = utcDate(year, month, 1);
      const weekStart = dayOffset(first, -((first.getUTCDay() + 6) % 7));
      monthLabel.textContent = `${year} 年 ${month + 1} 月`;
      previous.disabled = dateKey(dayOffset(first, -1)) < min || year === 1 && month === 0;
      next.disabled = dateKey(utcDate(year, month + 1, 1)) > max || year === 9999 && month === 11;
      let activeDay;
      grid.replaceChildren(...Array.from({ length: 42 }, (_, index) => {
        const day = dayOffset(weekStart, index);
        const key = dateKey(day);
        const cell = button("kw-calendar-day", String(day.getUTCDate()), {
          "aria-label": `${day.getUTCFullYear()}年${day.getUTCMonth() + 1}月${day.getUTCDate()}日`,
          "aria-pressed": String(key === trigger.value), "data-date": key, tabindex: "-1",
        });
        cell.disabled = day.getUTCFullYear() < 1 || day.getUTCFullYear() > 9999 || !inBounds(key);
        if (day.getUTCMonth() !== month) cell.classList.add("is-adjacent");
        if (key === today) cell.setAttribute("aria-current", "date");
        if (key === dateKey(current)) {
          activeDay = cell;
          cell.tabIndex = 0;
        }
        return cell;
      }));
      if (focusDay) activeDay?.focus({ preventScroll: true });
    }

    function move(date, focusDay) {
      const key = dateKey(date);
      if (date.getUTCFullYear() < 1 || key < min) current = parseDate(min);
      else if (date.getUTCFullYear() > 9999 || key > max) current = parseDate(max);
      else current = date;
      render(focusDay);
    }

    function changeMonth(months, control) {
      move(monthOffset(current, months), false);
      if (control.disabled) grid.querySelector('[tabindex="0"]')?.focus();
    }

    root.addEventListener("kw-picker-open", () => {
      const now = new Date();
      today = dateKey(utcDate(now.getFullYear(), now.getMonth(), now.getDate()));
      input.value = trigger.value;
      clear.disabled = !trigger.value;
      error.textContent = "";
      input.removeAttribute("aria-invalid");
      picker.open();
      move(parseDate(trigger.value) || parseDate(today), true);
    });
    previous.addEventListener("click", () => changeMonth(-1, previous));
    next.addEventListener("click", () => changeMonth(1, next));
    grid.addEventListener("click", (event) => {
      const key = event.target.closest("[data-date]")?.dataset.date;
      if (key && inBounds(key)) picker.choose(key, key);
    });
    grid.addEventListener("keydown", (event) => {
      const day = parseDate(event.target.dataset.date);
      if (!day) return;
      const weekDay = (day.getUTCDay() + 6) % 7;
      const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekDay, End: 6 - weekDay };
      let target;
      if (Object.hasOwn(offsets, event.key)) target = dayOffset(day, offsets[event.key]);
      if (event.key === "PageUp") target = monthOffset(day, event.shiftKey ? -12 : -1);
      if (event.key === "PageDown") target = monthOffset(day, event.shiftKey ? 12 : 1);
      if (target) {
        event.preventDefault();
        move(target, true);
      }
    });

    function applyEntry() {
      const key = input.value.trim();
      if (!parseDate(key) || !inBounds(key)) {
        input.setAttribute("aria-invalid", "true");
        error.textContent = "请输入范围内的有效日期。";
        input.focus();
        return;
      }
      picker.choose(key, key);
    }
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      error.textContent = "";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      applyEntry();
    });
    apply.addEventListener("click", applyEntry);
    clear.addEventListener("click", () => picker.choose("", ""));
    picker.setValue(config.value || "", config.value);
    return {
      ...picker,
      setBounds(lower, upper) {
        min = parseDate(lower) ? lower : "0001-01-01";
        max = parseDate(upper) && upper >= min ? upper : "9999-12-31";
      },
    };
  }

  function colorPicker(root, config) {
    const picker = makePicker(root, { placeholder: "选择颜色", ...config, kind: "color" });
    const palette = element("div", "kw-color-palette");
    const colors = ["#000000", "#ffffff", "#64748b", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed"];
    for (const color of colors) {
      const swatch = button("kw-color-swatch", "", { "aria-label": color, "data-color": color });
      swatch.style.setProperty("--swatch", color);
      palette.append(swatch);
    }
    const footer = element("div", "kw-picker-footer");
    const input = element("input", "kw-picker-entry", { type: "text", placeholder: "#RRGGBB", "aria-label": "输入十六进制颜色", maxlength: "7" });
    const apply = button("kw-picker-action", "确定");
    const error = element("p", "kw-picker-error", { role: "status" });
    footer.append(input, apply);
    picker.panel.append(palette, footer, error);

    function setValue(value) {
      picker.setValue(value, value);
      picker.trigger.style.setProperty("--swatch", value);
    }

    function select(value) {
      picker.choose(value, value);
      setValue(picker.trigger.value);
    }

    function applyEntry() {
      const value = input.value.trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(value)) select(value);
      else {
        input.setAttribute("aria-invalid", "true");
        error.textContent = "请输入六位十六进制颜色。";
        input.focus();
      }
    }

    root.addEventListener("kw-picker-open", () => {
      input.value = picker.trigger.value;
      input.removeAttribute("aria-invalid");
      error.textContent = "";
      for (const swatch of palette.children) swatch.setAttribute("aria-pressed", String(swatch.dataset.color === input.value));
      picker.open();
      input.focus();
    });
    palette.addEventListener("click", (event) => {
      const color = event.target.closest("[data-color]")?.dataset.color;
      if (color) select(color);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      applyEntry();
    });
    apply.addEventListener("click", applyEntry);
    setValue(config.value);
    return { ...picker, setValue };
  }

  function inside(event) {
    return openPicker?.trigger.contains(event.target) || openPicker?.panel.contains(event.target);
  }

  function dismiss(event) {
    if (openPicker && !inside(event)) openPicker.close();
  }

  document.addEventListener("pointerdown", dismiss, true);
  document.addEventListener("focusin", dismiss);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openPicker) return;
    event.preventDefault();
    event.stopPropagation();
    openPicker.close(true);
  }, true);
  document.addEventListener("scroll", (event) => {
    if (openPicker && !openPicker.panel.contains(event.target)) openPicker.position();
  }, true);
  document.addEventListener("close", (event) => {
    if (openPicker && event.target.contains(openPicker.trigger)) openPicker.close();
  }, true);
  window.addEventListener("resize", () => openPicker?.position());

  window.KnowWeavePickers = { choice, date: datePicker, color: colorPicker };
})();
