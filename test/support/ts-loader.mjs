// ESM loader hook: rewrite .js imports to .ts when the .js file doesn't exist
// but a .ts file does. This bridges the gap between source-level .js extension
// imports and the actual .ts files on disk.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const piCodingAgentShim = `
export function getMarkdownTheme() { return {}; }
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

export function visibleWidth(text) {
  return String(text).replace(/\\x1b\\[[0-9;]*m/g, "").length;
}

export function truncateToWidth(text, width) {
  if (typeof text !== "string") return "";
  const stripped = text.replace(/\\x1b\\[[0-9;]*m/g, "");
  if (stripped.length <= width) return text;
  return stripped.slice(0, width);
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
  render(width) {
    return this.children.flatMap((child) => child.render(width));
  }
}
`;

function asDataModule(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

export function resolve(specifier, context, nextResolve) {
  // Shim peer dependencies globally — they are optional peer deps not installed in the test env.
  // The render.ts-specific shim was too narrow and missed imports from index.ts, render-helpers.ts,
  // slash-commands.ts, chain-clarify.ts, and direct test file imports.
  if (specifier === "@mariozechner/pi-coding-agent") {
    return { url: asDataModule(piCodingAgentShim), shortCircuit: true };
  }
  if (specifier === "@mariozechner/pi-tui") {
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
