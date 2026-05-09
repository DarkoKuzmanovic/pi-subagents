// Type shim for @earendil-works/pi-ai

export interface Message {
	role: string;
	content: string | any[];
	[key: string]: any;
}
