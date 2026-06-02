// Type shim for @earendil-works/pi-ai

export interface Message {
	role: string;
	content: any;
	[key: string]: any;
}

export interface OAuthCredentials {
	access: string;
	refresh: string;
	expires: number;
	[key: string]: any;
}

export interface OAuthLoginCallbacks {
	onPrompt: (opts: any) => Promise<string>;
	[key: string]: any;
}
