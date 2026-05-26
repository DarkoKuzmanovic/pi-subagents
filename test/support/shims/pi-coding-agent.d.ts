// Type shim for @earendil-works/pi-coding-agent
// Broad types — the goal is import resolution, not type precision

export interface ExtensionAPI {
	registerProvider: any;
	registerCommand: any;
	registerShortcut: any;
	on: any;
	exec: any;
	getThinkingLevel: any;
	events: any;
	sendMessage: any;
	[key: string]: any;
}

export interface ExtensionContext {
	cwd: string;
	model?: any;
	hasUI: boolean;
	ui: any;
	sessionManager: any;
	getContextUsage: any;
	[key: string]: any;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	handler: any;
	[key: string]: any;
}

export interface Theme {
	fg: (color: string, text: string) => string;
	inverse: (text: string) => string;
	bold: (text: string) => string;
	dim: (text: string) => string;
	[key: string]: any;
}

export declare function getMarkdownTheme(...args: any[]): Theme;

export class DynamicBorder {
	constructor(color?: (str: string) => string);
	invalidate(): void;
	render(width: number): string[];
}

export declare function rawKeyHint(key: string, description: string): string;

export declare function getSelectListTheme(): any;
export declare function keyText(keybindingId: string): string;
