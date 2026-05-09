// Type shim for @earendil-works/pi-tui

export interface Component {
	render(width: number): string[];
}

export interface TUI {
	requestRender(): void;
	[key: string]: any;
}

export class Box {
	constructor(opts: any);
	addChild(child: any): void;
	render(width: number): string[];
}

export class Container {
	children: any[];
	addChild(child: any): void;
	render(width: number): string[];
}

export class Text {
	constructor(text: string);
	render(width: number): string[];
}

export class Markdown {
	constructor(text: string);
	render(width: number): string[];
}

export class Spacer {
	constructor(lines?: number);
	render(): string[];
}

export function visibleWidth(text: string): number;
export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
export function wrapTextWithAnsi(text: string, width: number): string[];

export const Key: Record<string, any>;
export function matchesKey(event: any, ...keys: any[]): boolean;
