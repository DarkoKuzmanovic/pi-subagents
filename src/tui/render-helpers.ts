import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";


export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
	const clipped = truncateToWidth(singleLine, innerW);
	return theme.fg("border", "│") + pad(clipped, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}


export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}
