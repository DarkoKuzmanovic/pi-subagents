// Type shim for @earendil-works/pi-tui

export interface Component {
	render(width: number): string[];
}

export interface TUI {
	requestRender(): void;
	[key: string]: any;
}

export class Box {
	constructor(...args: any[]);
	addChild(child: any): void;
	render(width: number): string[];
}

export class Container {
	constructor(...args: any[]);
	children: any[];
	addChild(child: any): void;
	clear(): void;
	invalidate(): void;
	render(width: number): string[];
}

export class Text {
	constructor(text: string, paddingX?: number, paddingY?: number, bgFn?: (s: string) => string);
	render(width: number): string[];
}

export class Markdown {
	constructor(text: string, ...args: any[]);
	render(width: number): string[];
}

export class Spacer {
	constructor(lines?: number);
	render(): string[];
}

export function visibleWidth(text: string): number;
export function truncateToWidth(text: string, width: number, ellipsis?: string): string;
export function fuzzyFilter<T>(items: T[], query: string, accessor: (item: T) => string): T[];
export function wrapTextWithAnsi(text: string, width: number, ...args: any[]): string[];

export const Key: Record<string, any>;
export interface SelectItem {
	value: string;
	label: string;
	description?: string;
}

export interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
	values: string[];
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
}

export class SelectList {
	constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: any);
	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;
	setSelectedIndex(index: number): void;
	setFilter(filter: string): void;
	getSelectedItem(): SelectItem | null;
	invalidate(): void;
	render(width: number): string[];
	handleInput(keyData: string): void;
}

export class SettingsList {
	constructor(
		items: SettingItem[],
		height: number,
		theme: any,
		onChange: (id: string, newValue: string) => void,
		onClose: () => void,
		options?: { enableSearch?: boolean },
	);
	handleInput?(data: string): void;
	invalidate(): void;
	render(width: number): string[];
}

export function matchesKey(event: any, ...keys: any[]): boolean;
