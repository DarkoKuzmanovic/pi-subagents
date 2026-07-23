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
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function truncateToWidth(text, width, ellipsis = "...") {
  if (typeof text !== "string") return "";
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= width) return text;
  const suffix = ellipsis ? String(ellipsis) : "";
  const maxLen = Math.max(0, width - suffix.length);
  return stripped.slice(0, maxLen) + suffix;
}

export function wrapTextWithAnsi(text, width) {
  return wrapText(text, width);
}

export function matchesKey() { return false; }

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

export class SelectList {
  constructor(items, height, theme) {
    this.items = items || [];
    this.height = height || 10;
    this.selectedIndex = 0;
    this.theme = theme;
  }
  getSelected() { return this.items[this.selectedIndex]; }
  setSelectedIndex(index) {
    const max = Math.max(0, this.items.length - 1);
    this.selectedIndex = Math.min(Math.max(0, index), max);
    if (this.onSelectionChange) this.onSelectionChange(this.getSelected());
  }
  render(width) {
    return this.items.slice(0, this.height).map((item, index) => {
      const label = String(item.label || item);
      const description = item.description ? " " + item.description : "";
      const prefix = index === this.selectedIndex ? "> " : "  ";
      return prefix + label + description;
    });
  }
  handleInput() { return false; }
  handleKey() { return false; }
  invalidate() { return false; }
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
