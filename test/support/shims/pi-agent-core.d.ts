// Type shim for @earendil-works/pi-agent-core

export type AgentToolResult<T = any> = {
	type: string;
	[key: string]: any;
}

export type AgentSource = string;

export interface ExtensionAPI {
	[key: string]: any;
}
