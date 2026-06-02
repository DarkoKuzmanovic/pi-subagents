// Type shim for @earendil-works/pi-agent-core

export type AgentToolResult<T = any> = {
	type?: string;
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
	details?: T;
};

export type AgentSource = string;

export interface ExtensionAPI {
	[key: string]: any;
}
