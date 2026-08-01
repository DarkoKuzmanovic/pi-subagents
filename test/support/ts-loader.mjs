// ESM loader hook: rewrite .js imports to .ts when the .js file doesn't exist
// but a .ts file does. This bridges the gap between source-level .js extension
// imports and the actual .ts files on disk.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const piCodingAgentShim = `
export function getMarkdownTheme() { return {}; }
export function keyText(id) { return id; }
export function rawKeyHint(key, desc) { return key + " " + desc; }
export class DynamicBorder {
  constructor(color) { this.color = color; }
  invalidate() {}
  render(width) { return ["-".repeat(width)]; }
}
export function getSettingsListTheme() { return {}; }
`;

const piTuiShim = `
function wrapText(text, width) {
  if (!width || width <= 0) return [text];
  const lines = [];
  for (const rawLine of String(text).split("\\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }
    for (let i = 0; i < rawLine.length; i += width) {
      lines.push(rawLine.slice(i, i + width));
    }
  }
  return lines;
}

// NOTE: this shim counts every code unit as one cell, so CJK/wide glyphs are
// over-counted as width 1. The wide-Unicode test intentionally uses a single
// character and validates the shim's behavior rather than a real grapheme width.
export function visibleWidth(text) {
  return String(text).replace(/\\x1b\\[[0-9;]*m/g, "").length;
}

export function truncateToWidth(text, width, ellipsis = "...") {
  if (typeof text !== "string") return "";
  const stripped = text.replace(/\\x1b\\[[0-9;]*m/g, "");
  if (stripped.length <= width) return text;
  const suffix = ellipsis ? String(ellipsis) : "";
  const maxLen = Math.max(0, width - suffix.length);
	return stripped.slice(0, maxLen) + suffix;
}

export function fuzzyFilter(items, query, accessor) {
  if (!query) return [...items];
  const tokens = String(query).toLowerCase().split(/[\\s/]+/).filter(Boolean);
  if (tokens.length === 0) return [...items];

  const scored = [];
  for (const item of items) {
    const text = String(accessor(item)).toLowerCase();
    let totalScore = 0;
    let matches = true;
    for (const token of tokens) {
      let index = 0;
      let firstMatch = -1;
      for (let i = 0; i < text.length && index < token.length; i++) {
        if (text[i] === token[index]) {
          if (firstMatch === -1) firstMatch = i;
          index++;
        }
      }
      if (index !== token.length) {
        matches = false;
        break;
      }
      totalScore += firstMatch;
    }
    if (matches) scored.push({ item, score: totalScore });
  }
  return scored.sort((a, b) => a.score - b.score).map((r) => r.item);
}

export function wrapTextWithAnsi(text, width) {
  return wrapText(text, width);
}

export function matchesKey(data, ...keys) {
  for (const key of keys) {
    if (key === "backspace" && (data === "\\b" || data === "\\x7f")) return true;
    if (key === "escape" && data === "\\x1b") return true;
    if (key === "ctrl+c" && data === "\\x03") return true;
    if (key === "tab" && data === "\\t") return true;
    if ((key === "enter" || key === "return") && (data === "\\r" || data === "\\n")) return true;
    if (key === "up" && data === "\\x1b[A") return true;
    if (key === "down" && data === "\\x1b[B") return true;
  }
  return false;
}

export const Key = {};

export class Box {
  constructor(opts) { this.opts = opts; this.children = []; }
  addChild(child) { this.children.push(child); }
  render(width) {
    return this.children.flatMap((child) => child.render ? child.render(width) : [String(child)]);
  }
}

export class Text {
  constructor(text) {
    this.text = text;
  }
  setText(text) { this.text = text; }
  invalidate() {}
  render(width) {
    return wrapText(this.text, width);
  }
}

export class Spacer {
  constructor(lines = 1) {
    this.lines = lines;
  }
  render() {
    return Array.from({ length: this.lines }, () => "");
  }
}

export class Markdown {
  constructor(text) {
    this.text = text;
  }
  render(width) {
    return wrapText(this.text, width);
  }
}

export class Container {
  constructor() {
    this.children = [];
  }
  addChild(child) {
    this.children.push(child);
  }
  clear() {
    this.children = [];
  }
  invalidate() {
    for (const child of this.children) {
      if (typeof child.invalidate === "function") child.invalidate();
    }
  }
  render(width) {
    return this.children.flatMap((child) => child.render(width));
  }
}

// Mirrors @earendil-works/pi-tui dist/components/select-list.js: setSelectedIndex
// clamps without notifying, arrows wrap and fire onSelectionChange, enter fires
// onSelect, escape/ctrl+c fire onCancel. setFilter matches the real component
// exactly: prefix match on item.value, selection reset to 0, no callback fired.
export class SelectList {
  constructor(items, height, theme) {
    this.items = items || [];
    this.filteredItems = this.items;
    this.height = height || 10;
    this.selectedIndex = 0;
    this.theme = theme;
  }
  setFilter(filter) {
    const needle = String(filter || "").toLowerCase();
    this.filteredItems = this.items.filter((item) =>
      String(item.value || "").toLowerCase().startsWith(needle));
    this.selectedIndex = 0;
  }
  getSelected() { return this.filteredItems[this.selectedIndex]; }
  getSelectedItem() { return this.filteredItems[this.selectedIndex] || null; }
  setSelectedIndex(index) {
    const max = Math.max(0, this.filteredItems.length - 1);
    this.selectedIndex = Math.min(Math.max(0, index), max);
  }
  render(width) {
    return this.filteredItems.slice(0, this.height).map((item, index) => {
      const label = String(item.label || item);
      const description = item.description ? " " + item.description : "";
      const prefix = index === this.selectedIndex ? "> " : "  ";
      return prefix + label + description;
    });
  }
  notifySelectionChange() {
    const item = this.filteredItems[this.selectedIndex];
    if (item && this.onSelectionChange) this.onSelectionChange(item);
  }
  handleInput(data) {
    if (matchesKey(data, "up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, "enter")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item && this.onSelect) this.onSelect(item);
      return;
    }
    if (matchesKey(data, "escape", "ctrl+c")) {
      if (this.onCancel) this.onCancel();
    }
  }
  invalidate() {}
}

export class SettingsList {
  constructor(items, height, theme, onChange, onClose, options) {
    this.items = items || [];
    this.height = height || 10;
    this.theme = theme || {};
    this.onChange = onChange;
    this.onClose = onClose;
    this.options = options || {};
    this.selectedIndex = 0;
    this.searchQuery = "";
  }
  // Real SettingsList mutates the live item in place; callers read currentValue back.
  updateValue(id, newValue) {
    const item = this.items.find((entry) => entry.id === id);
    if (item) item.currentValue = newValue;
  }
  getFilteredItems() {
    if (!this.searchQuery) return this.items;
    const q = this.searchQuery.toLowerCase();
    return this.items.filter((item) =>
      String(item.label || "").toLowerCase().includes(q));
  }
  render(width) {
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.getFilteredItems().length - 1));
    const filtered = this.getFilteredItems();
    return filtered.slice(0, this.height).map((item, index) => {
      const label = String(item.label || "");
      const val = String(item.currentValue || "");
      const prefix = index === this.selectedIndex ? "> " : "  ";
      return prefix + label + " [" + val + "]";
    });
  }
  handleInput(data) {
    if (!data) return;
    const filtered = this.getFilteredItems();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
    if (data === "\\x1b[A") {
      if (this.selectedIndex > 0) this.selectedIndex--;
      return;
    }
    if (data === "\\x1b[B") {
      const max = Math.max(0, this.getFilteredItems().length - 1);
      if (this.selectedIndex < max) this.selectedIndex++;
      return;
    }
    if (data === "\\r" || data === "\\n") {
      const item = this.getFilteredItems()[this.selectedIndex];
      if (item && item.values && item.values.length > 0) {
        const currentIdx = item.values.indexOf(item.currentValue);
        const nextIdx = item.values.length === 1 ? 0 : (currentIdx + 1) % item.values.length;
        const newValue = item.values[nextIdx];
        item.currentValue = newValue;
        if (this.onChange) this.onChange(item.id, newValue);
      }
      return;
    }
    if (data === "\\x1b") {
      if (this.onClose) this.onClose();
      return;
    }
    if (data === "\\b" || data === "\\x7f") {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
      }
      return;
    }
    if (data.length >= 1 && /^[\\x20-\\x7e]+$/.test(data)) {
      this.searchQuery += data;
      return;
    }
  }
  invalidate() {}
}
`;

function asDataModule(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

export function resolve(specifier, context, nextResolve) {
  // Shim peer dependencies globally — they are optional peer deps not installed in the test env.
  // The render.ts-specific shim was too narrow and missed imports from index.ts, render-helpers.ts,
  // slash-commands.ts, chain-clarify.ts, and direct test file imports.
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: asDataModule(piCodingAgentShim), shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-tui") {
    return { url: asDataModule(piTuiShim), shortCircuit: true };
  }

  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return nextResolve(specifier, context);
  }

  const parentDir = context.parentURL
    ? path.dirname(fileURLToPath(context.parentURL))
    : process.cwd();
  const jsPath = path.resolve(parentDir, specifier);
  const tsPath = jsPath.replace(/\.js$/, ".ts");

  if (!fs.existsSync(jsPath) && fs.existsSync(tsPath)) {
    return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
  }

  return nextResolve(specifier, context);
}
