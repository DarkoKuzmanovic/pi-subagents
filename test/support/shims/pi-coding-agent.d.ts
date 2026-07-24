// Type shim for @earendil-works/pi-coding-agent
// Broad types — the goal is import resolution, not type precision

export interface ExtensionAPI {
	registerProvider: (...args: any[]) => any;
	registerCommand: (...args: any[]) => any;
	registerShortcut: (...args: any[]) => any;
	registerMessageRenderer: <T = any>(type: string, renderer: (message: any, options: any, theme: any) => any) => void;
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
	ui: { custom: <T = any>(...args: any[]) => Promise<T>; theme: any; requestRender?: () => void; [key: string]: any };
	sessionManager: any;
	getContextUsage: any;
	modelRegistry?: any;
	[key: string]: any;
}

export interface ToolDefinition<T = any, U = any> {
	name: string;
	description?: string;
	handler?: T;
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
export declare function getSettingsListTheme(...args: any[]): any;
