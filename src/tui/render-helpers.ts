import { visibleWidth } from "@earendil-works/pi-tui";


export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}
