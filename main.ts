/*
 * Fractal — Column-based Markdown card tree view for Obsidian
 * Copyright (C) 2026 Alessandro Abrami
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	TextFileView,
	MarkdownRenderer,
	TFile,
	Menu,
	Modal,
	Notice,
	parseYaml,
	Component,
	setIcon,
	MarkdownView
} from "obsidian";

// Unique identifier for the Fractal View
export const VIEW_TYPE_FRACTAL = "fractal-view";

// Interfaces
interface FractalCard {
	id: string; // Stable breadcrumb ID: e.g., "Intro[1]" or "Intro[1] > Scope[1]"
	headingLevel: number; // 0 for root, 1 for H1, 2 for H2, etc.
	title: string;
	content: string;
	children: FractalCard[];
}

interface FractalSettings {
	cardColors: Record<string, Record<string, string>>;      // file.path -> { cardId -> cssClass }
	collapsedNodes: Record<string, Record<string, boolean>>;  // file.path -> { cardId -> collapsed }
	collapsedColumns: Record<string, Record<number, boolean>>;// file.path -> { colIdx -> collapsed }
	zoom: number; // Zoom level
	columnWidth: number; // Default column width in px
	themeMode: "obsidian-theme" | "custom";
	canvasBgColor: string;
	activeCardColor: string;
	inactiveCardColor: string;
	textColor: string;
	auraColor: string;
	centeredNavigation: boolean;
	viewMode: "ginkgo" | "lineage" | "mindmap";
	inactiveCardHeight: number; // Height of inactive cards in px (300 means Auto)
	fontSize: number; // Text size scaling
	showGrid: boolean; // Canvas grid status
	gridOpacity: number; // Canvas grid opacity (0.0 to 1.0)
	titleFontSize: number; // Section titles font size in px
	cardPaddingY: number; // Card vertical padding in px
	cardPaddingX: number; // Card horizontal padding in px
	cardGap: number; // Card gap (space between title and body) in px
	autoCardSpacing: boolean; // Auto card padding/gap sizing status
	sectionBehavior: "keep" | "preview"; // Section behavior: keep open or view preview
	openByDefault: boolean; // Automatically open notes in Fractal view
	customTitleColor: string; // Custom theme title color
}

const DEFAULT_SETTINGS: FractalSettings = {
	cardColors: {},
	collapsedNodes: {},
	collapsedColumns: {},
	zoom: 1.0,
	columnWidth: 450,
	themeMode: "obsidian-theme",
	canvasBgColor: "#0d1b2a",
	activeCardColor: "#ffffff",
	inactiveCardColor: "#1a365d",
	textColor: "#eef1f6",
	auraColor: "#3a86c8",
	centeredNavigation: false,
	viewMode: "ginkgo",
	inactiveCardHeight: 300,
	fontSize: 14,
	showGrid: true,
	gridOpacity: 0.03,
	titleFontSize: 16,
	cardPaddingY: 12,
	cardPaddingX: 14,
	cardGap: 8,
	autoCardSpacing: true,
	sectionBehavior: "preview",
	openByDefault: false,
	customTitleColor: "#ebf8ff"
};

function getHeadingIdAtCursor(markdownView: MarkdownView, app: App): string | null {
	const editor = markdownView.editor;
	const cursor = editor.getCursor();
	const file = markdownView.file;
	if (!file) return null;

	const fileCache = app.metadataCache.getFileCache(file);
	const headings = fileCache?.headings || [];
	if (headings.length === 0) return null;

	let activeHeadingIndex = -1;
	for (let i = 0; i < headings.length; i++) {
		if (headings[i].position.start.line <= cursor.line) {
			activeHeadingIndex = i;
		} else {
			break;
		}
	}
	if (activeHeadingIndex === -1) return null;

	const stack: { id: string; level: number; siblingCounts: Record<string, number> }[] = [
		{ id: "root", level: 0, siblingCounts: {} }
	];

	let targetId: string | null = null;

	for (let i = 0; i <= activeHeadingIndex; i++) {
		const h = headings[i];
		const title = h.heading.trim() || "Untitled";
		const level = h.level;

		while (stack.length > 1 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		parent.siblingCounts[title] = (parent.siblingCounts[title] || 0) + 1;
		const count = parent.siblingCounts[title];

		const id = parent.id === "root" ? `${title}[${count}]` : `${parent.id} > ${title}[${count}]`;

		const newEntry = { id, level, siblingCounts: {} };
		stack.push(newEntry);

		if (i === activeHeadingIndex) {
			targetId = id;
		}
	}

	return targetId;
}

function getLineOfHeadingId(markdownView: MarkdownView, targetId: string, app: App): number | null {
	const file = markdownView.file;
	if (!file) return null;

	const fileCache = app.metadataCache.getFileCache(file);
	const headings = fileCache?.headings || [];
	if (headings.length === 0) return null;

	const stack: { id: string; level: number; siblingCounts: Record<string, number> }[] = [
		{ id: "root", level: 0, siblingCounts: {} }
	];

	for (let i = 0; i < headings.length; i++) {
		const h = headings[i];
		const title = h.heading.trim() || "Untitled";
		const level = h.level;

		while (stack.length > 1 && stack[stack.length - 1].level >= level) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		parent.siblingCounts[title] = (parent.siblingCounts[title] || 0) + 1;
		const count = parent.siblingCounts[title];

		const id = parent.id === "root" ? `${title}[${count}]` : `${parent.id} > ${title}[${count}]`;

		if (id === targetId) {
			return h.position.start.line;
		}

		stack.push({ id, level, siblingCounts: {} });
	}

	return null;
}

// Parser & Serializer Helpers
function parseMarkdown(text: string, title: string): { root: FractalCard, frontmatter: string } {
	let frontmatter = "";
	let markdownContent = text;
	
	// Detect YAML Frontmatter with support for Windows and Unix newlines
	const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (fmMatch) {
		frontmatter = fmMatch[1];
		markdownContent = text.substring(fmMatch[0].length);
	}

	const root: FractalCard = {
		id: "root",
		headingLevel: 0,
		title: title,
		content: "",
		children: []
	};

	const lines = markdownContent.replace(/\r\n/g, "\n").split("\n");
	const stack: FractalCard[] = [root];
	let cardCounter = 0;
	let activeFenceChar: string | null = null;
	let activeFenceLen = 0;

	for (const line of lines) {
		const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
		if (fenceMatch) {
			const fenceStr = fenceMatch[1];
			const fenceChar = fenceStr[0];
			if (!activeFenceChar) {
				if (fenceChar !== "`" || !fenceMatch[2].includes("`")) {
					activeFenceChar = fenceChar;
					activeFenceLen = fenceStr.length;
				}
			} else if (
				fenceChar === activeFenceChar &&
				fenceStr.length >= activeFenceLen &&
				fenceMatch[2].trim() === ""
			) {
				activeFenceChar = null;
				activeFenceLen = 0;
			}
			stack[stack.length - 1].content += line + "\n";
			continue;
		}

		const headingMatch = !activeFenceChar ? line.match(/^(#{1,6})\s+(.*)$/) : null;
		if (headingMatch) {
			const level = headingMatch[1].length;
			const headingTitle = headingMatch[2];

			const newCard: FractalCard = {
				id: `temp-${cardCounter++}`,
				headingLevel: level,
				title: headingTitle,
				content: "",
				children: []
			};

			// Pop stack until parent level is less than new level
			while (stack.length > 1 && stack[stack.length - 1].headingLevel >= level) {
				stack.pop();
			}

			const parent = stack[stack.length - 1];
			parent.children.push(newCard);
			stack.push(newCard);
		} else {
			const activeCard = stack[stack.length - 1];
			activeCard.content += line + "\n";
		}
	}

	// Trim trailing newlines
	const trimContents = (card: FractalCard) => {
		card.content = card.content.trimEnd();
		card.children.forEach(trimContents);
	};
	trimContents(root);

	// Assign stable, unique breadcrumb keys
	assignStableKeys(root);

	return { root, frontmatter };
}

function assignStableKeys(card: FractalCard, parentKey = "") {
	if (card.headingLevel === 0) {
		card.id = "root";
	}
	const siblingCounts: Record<string, number> = {};
	card.children.forEach((child) => {
		const baseTitle = child.title.trim() || "Untitled";
		siblingCounts[baseTitle] = (siblingCounts[baseTitle] || 0) + 1;
		const count = siblingCounts[baseTitle];
		child.id = parentKey ? `${parentKey} > ${baseTitle}[${count}]` : `${baseTitle}[${count}]`;
		assignStableKeys(child, child.id);
	});
}

function serializeCard(card: FractalCard): string {
	let result = "";
	if (card.headingLevel > 0) {
		result += "#".repeat(card.headingLevel) + " " + card.title + "\n";
	}
	if (card.content) {
		result += card.content + "\n";
	} else if (card.headingLevel > 0) {
		result += "\n";
	}
	for (const child of card.children) {
		result += serializeCard(child);
	}
	return result;
}

function serializeTree(root: FractalCard, frontmatter: string): string {
	let result = "";
	if (frontmatter) {
		result += "---\n" + frontmatter + "\n---\n";
	}
	if (root.content) {
		result += root.content + "\n";
	}
	for (const child of root.children) {
		result += serializeCard(child);
	}
	return result;
}

// Fallback simple YAML parser
function parseYAML(yamlStr: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!yamlStr) return result;
	const lines = yamlStr.split("\n");
	for (const line of lines) {
		const match = line.match(/^([a-zA-Z0-9_\-]+)\s*:\s*(.*)$/);
		if (match) {
			result[match[1].trim()] = match[2].trim();
		}
	}
	return result;
}

// Strip markdown syntax and get a clean plain text preview
function getPlainPreview(text: string, limit = 150): string {
	if (!text) return "";
	
	// Remove HTML tags
	let plain = text.replace(/<[^>]*>/g, "");
	
	// Remove markdown formatting
	plain = plain.replace(/^(#{1,6})\s+/gm, ""); // headers
	plain = plain.replace(/(\*\*|__)(.*?)\1/g, "$2"); // bold
	plain = plain.replace(/(\*|_)(.*?)\1/g, "$2"); // italic
	plain = plain.replace(/^\s*[\-\*\+]\s+/gm, ""); // bullets
	plain = plain.replace(/^\s*>\s*/gm, ""); // blockquotes
	plain = plain.replace(/```[\s\S]*?```/g, "[Code]"); // code blocks
	plain = plain.replace(/`([^`]+)`/g, "$1"); // inline code
	plain = plain.replace(/\[\[([^\]]+)\]\]/g, "$1"); // wikilinks
	
	// Replace double newlines or newlines with spaces for a single line preview
	plain = plain.replace(/\n+/g, " ");
	
	// Trim and truncate
	plain = plain.trim();
	if (plain.length > limit) {
		return plain.substring(0, limit) + "...";
	}
	return plain;
}

/**
 * Post-process rendered markdown to fix task lists, image embeds,
 * and media interaction inside custom view contexts.
 */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function postProcessRenderedMarkdown(el: HTMLElement, app?: App, sourcePath?: string): void {
	// 1. Ensure embedded images inside .internal-embed actually resolve and render <img>
	if (app && sourcePath !== undefined) {
		const embeds = Array.from(el.querySelectorAll(".internal-embed")) as HTMLElement[];
		for (const embed of embeds) {
			const existingImg = embed.querySelector("img") as HTMLImageElement | null;
			if (existingImg) {
				existingImg.setAttribute("draggable", "false");
				embed.addClass("is-loaded");
				continue;
			}
			if (embed.querySelector("video, audio, svg, iframe")) {
				continue;
			}

			const rawSrc = embed.getAttribute("src") || "";
			if (!rawSrc) continue;
			const pipeIdx = rawSrc.indexOf("|");
			const linkAndSub = pipeIdx !== -1 ? rawSrc.substring(0, pipeIdx) : rawSrc;
			const sizeSpec = pipeIdx !== -1 ? rawSrc.substring(pipeIdx + 1).trim() : "";
			const linkPath = linkAndSub.split("#")[0].trim();
			if (!linkPath) continue;

			const dest = app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
			if (dest && IMAGE_EXTENSIONS.has(dest.extension.toLowerCase())) {
				const img = embed.createEl("img", {
					attr: {
						src: app.vault.getResourcePath(dest),
						alt: embed.getAttribute("alt") || dest.basename,
						draggable: "false"
					}
				});
				const widthMatch = sizeSpec.match(/^(\d+)(?:x(\d+))?$/);
				if (widthMatch) {
					img.style.width = `${widthMatch[1]}px`;
					if (widthMatch[2]) {
						img.style.height = `${widthMatch[2]}px`;
					}
				}
				embed.addClass("media-embed", "image-embed", "is-loaded");
			}
		}
	}

	// Ensure all rendered images have draggable disabled so clicks/zooms don't trigger card drag
	el.querySelectorAll("img").forEach((img) => {
		img.setAttribute("draggable", "false");
	});

	// 2. Convert [ ] and [x] in list items (and unrendered lists in paragraphs) into checkboxes
	// Sometimes Obsidian fails to parse lists inside blockquotes, leaving them as text starting with "1. [ ]"
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
	const textNodesToCheck: Text[] = [];
	let currNode: Node | null;
	while (currNode = walker.nextNode()) {
		textNodesToCheck.push(currNode as Text);
	}
	
	for (const textNode of textNodesToCheck) {
		const text = textNode.nodeValue || "";
		const checkMatch = text.match(/^(\s*(?:\d+\.|\-|\*)?\s*)\[([ xX])\]\s*/);
		if (checkMatch) {
			const isChecked = checkMatch[2].toLowerCase() === "x";
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.checked = isChecked;
			checkbox.disabled = true;
			checkbox.className = "task-list-item-checkbox";
			checkbox.style.marginRight = "6px";
			
			const parent = textNode.parentNode;
			if (parent) {
				// Keep the list marker (e.g. "1. ") but remove the "[ ]"
				const markerText = document.createTextNode(checkMatch[1]);
				textNode.nodeValue = text.substring(checkMatch[0].length);
				parent.insertBefore(markerText, textNode);
				parent.insertBefore(checkbox, textNode);
				
				if (parent instanceof HTMLElement) {
					parent.classList.add("task-list-item");
					parent.parentElement?.classList.add("contains-task-list");
				}
			}
		}
	}
}


function getContrastColor(hexColor: string): string {
	const hex = hexColor.replace("#", "");
	if (hex.length !== 6) return "#1a202c";
	const r = parseInt(hex.substring(0, 2), 16);
	const g = parseInt(hex.substring(2, 4), 16);
	const b = parseInt(hex.substring(4, 6), 16);
	const yiq = (r * 299 + g * 587 + b * 114) / 1000;
	return yiq >= 128 ? "#1a202c" : "#ffffff";
}

class ConfirmModal extends Modal {
	private titleText: string;
	private message: string;
	private confirmText: string;
	private isWarning: boolean;
	private onConfirm: () => void | Promise<void>;

	constructor(
		app: App,
		options: {
			title: string;
			message: string;
			confirmText?: string;
			isWarning?: boolean;
			onConfirm: () => void | Promise<void>;
		}
	) {
		super(app);
		this.titleText = options.title;
		this.message = options.message;
		this.confirmText = options.confirmText ?? "Confirm";
		this.isWarning = options.isWarning ?? false;
		this.onConfirm = options.onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", { text: this.message });

		const setting = new Setting(contentEl);
		setting.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => this.close())
		);
		setting.addButton((btn) => {
			btn.setButtonText(this.confirmText);
			if (this.isWarning) {
				btn.setWarning();
			} else {
				btn.setCta();
			}
			btn.onClick(async () => {
				this.close();
				await this.onConfirm();
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ImagePreviewModal extends Modal {
	private src: string;
	private alt: string;

	constructor(app: App, src: string, alt: string) {
		super(app);
		this.src = src;
		this.alt = alt;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("fractal-image-modal");
		contentEl.empty();
		if (this.alt) {
			contentEl.createEl("div", { cls: "fractal-image-modal-caption", text: this.alt });
		}
		contentEl.createEl("img", {
			cls: "fractal-image-modal-img",
			attr: { src: this.src, alt: this.alt }
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Custom View class extending TextFileView
export class FractalView extends TextFileView {
	plugin: FractalPlugin;
	root: FractalCard = {
		id: "root",
		headingLevel: 0,
		title: "Untitled",
		content: "",
		children: []
	};
	frontmatter: string = "";
	activeKeysByLevel: Record<number, string> = {};
	previousSelectionByLevel: Record<number, string> = {};
	lastSelectedChildByParent: Record<string, string> = {};
	editingCardId: string | null = null;
	originalCardTitle: string | null = null;
	originalCardContent: string | null = null;
	activeEditorInstance: any = null;
	renderGeneration: number = 0;
	renderedCardState: WeakMap<HTMLElement, { title: string; content: string; expanded: boolean; childCount: number }> = new WeakMap();
	renderedCardComponents: Map<HTMLElement, Component> = new Map();
	introRenderComponent: Component | null = null;

	createCardComponent(cardEl: HTMLElement): Component {
		this.unloadCardComponent(cardEl);
		const comp = new Component();
		this.addChild(comp);
		comp.load();
		this.renderedCardComponents.set(cardEl, comp);
		return comp;
	}

	unloadCardComponent(cardEl: HTMLElement) {
		const existing = this.renderedCardComponents.get(cardEl);
		if (existing) {
			this.removeChild(existing);
			existing.unload();
			this.renderedCardComponents.delete(cardEl);
		}
	}

	unloadComponentsInContainer(container: HTMLElement) {
		const cardEls = Array.from(container.querySelectorAll(".fractal-card")) as HTMLElement[];
		for (const el of cardEls) {
			this.unloadCardComponent(el);
		}
	}

	unloadAllCardComponents() {
		for (const comp of this.renderedCardComponents.values()) {
			this.removeChild(comp);
			comp.unload();
		}
		this.renderedCardComponents.clear();
		if (this.introRenderComponent) {
			this.removeChild(this.introRenderComponent);
			this.introRenderComponent.unload();
			this.introRenderComponent = null;
		}
	}

	captureCardIdMap(): Map<FractalCard, string> {
		const map = new Map<FractalCard, string>();
		const walk = (card: FractalCard) => {
			if (card.headingLevel > 0) {
				map.set(card, card.id);
			}
			card.children.forEach(walk);
		};
		walk(this.root);
		return map;
	}

	migrateTreeSettings(oldIdMap: Map<FractalCard, string>) {
		if (!this.file) return;
		const path = this.file.path;
		const colors = this.plugin.settings.cardColors[path];
		const collapsed = this.plugin.settings.collapsedNodes[path];
		if (!colors && !collapsed) return;

		const newColors: Record<string, string> = colors ? { ...colors } : {};
		const newCollapsed: Record<string, boolean> = collapsed ? { ...collapsed } : {};
		let changed = false;

		for (const [card, oldId] of oldIdMap.entries()) {
			if (card.id === oldId) continue;
			if (colors && colors[oldId] !== undefined) {
				newColors[card.id] = colors[oldId];
				if (newColors[oldId] === colors[oldId]) {
					delete newColors[oldId];
				}
				changed = true;
			}
			if (collapsed && collapsed[oldId] !== undefined) {
				newCollapsed[card.id] = collapsed[oldId];
				if (newCollapsed[oldId] === collapsed[oldId]) {
					delete newCollapsed[oldId];
				}
				changed = true;
			}
		}

		if (changed) {
			if (colors) this.plugin.settings.cardColors[path] = newColors;
			if (collapsed) this.plugin.settings.collapsedNodes[path] = newCollapsed;
			this.plugin.saveSettings();
		}
	}

	cleanupActiveEditor() {
		if (this.activeEditorInstance) {
			try {
				// @ts-expect-error -- undocumented Obsidian workspace property
				if (this.app.workspace._activeEditor === this.activeEditorInstance) {
					// @ts-expect-error -- undocumented Obsidian workspace property
					this.app.workspace._activeEditor = null;
				}
				if (typeof this.activeEditorInstance.unload === "function") {
					this.activeEditorInstance.unload();
				}
			} catch (err) {
				console.warn("Fractal: Error while cleaning up inline editor", err);
			}
			this.activeEditorInstance = null;
		}
	}
	editingYaml: boolean = false;
	editingRootContent: boolean = false;
	showMetadataPanel: boolean = false;
	rootPanelExpanded: boolean = false;
	selectedLevel: number = 1;
	
	// History stacks for document Undo/Redo
	historyUndoStack: string[] = [];
	historyRedoStack: string[] = [];
	editBlurTimeout: number | null = null;
	cardClickTimeout: number | null = null;

	// Drag-to-pan state variables
	isDraggingCanvas = false;
	dragStartX = 0;
	dragStartY = 0;
	dragScrollLeft = 0;
	dragScrollTop = 0;

	// Zen Mode state variables
	isZenMode = false;
	expandedCardIds: Set<string> = new Set();
	savedLeftCollapsed = true;
	savedRightCollapsed = true;

	// Active tab in custom color settings popover
	activeColorTab: "Text" | "Title" | "Canvas" | "Active" | "Dimmed" | "Aura" = "Text";

	pushHistory() {
		const currentState = this.getViewData();
		if (this.historyUndoStack.length === 0 || this.historyUndoStack[this.historyUndoStack.length - 1] !== currentState) {
			this.historyUndoStack.push(currentState);
			if (this.historyUndoStack.length > 100) {
				this.historyUndoStack.shift();
			}
			this.historyRedoStack = [];
		}
	}

	updateActivePathToCard(card: FractalCard) {
		const path: FractalCard[] = [];
		const findPathByRef = (current: FractalCard, target: FractalCard): boolean => {
			if (current === target) {
				path.push(current);
				return true;
			}
			for (const child of current.children) {
				if (findPathByRef(child, target)) {
					path.unshift(current);
					return true;
				}
			}
			return false;
		};

		if (findPathByRef(this.root, card)) {
			for (let i = 1; i < path.length; i++) {
				this.activeKeysByLevel[i] = path[i].id;
			}
			// Clean any active keys beyond the card's depth
			for (let i = path.length; i <= 6; i++) {
				delete this.activeKeysByLevel[i];
			}
			this.selectedLevel = path.length - 1;
		}
	}

	undo() {
		this.saveActiveEdit(); // Save any active edit first!
		if (this.historyUndoStack.length === 0) return;
		const currentState = this.getViewData();
		this.historyRedoStack.push(currentState);
		const prevState = this.historyUndoStack.pop()!;
		this.applySerializedState(prevState);
	}

	redo() {
		this.saveActiveEdit(); // Save any active edit first!
		if (this.historyRedoStack.length === 0) return;
		const currentState = this.getViewData();
		this.historyUndoStack.push(currentState);
		const nextState = this.historyRedoStack.pop()!;
		this.applySerializedState(nextState);
	}

	applySerializedState(stateText: string) {
		this.cleanupActiveEditor();
		this.editingCardId = null;
		this.originalCardTitle = null;
		this.originalCardContent = null;
		this.editingYaml = false;
		this.editingRootContent = false;
		this.data = stateText;
		const parsed = parseMarkdown(stateText, this.file ? this.file.basename : "Untitled");
		this.root = parsed.root;
		this.frontmatter = parsed.frontmatter;
		this.ensureSelectionPath();
		this.selectedLevel = this.getSelectedLevel();
		this.requestSave();
		this.renderFractal();
	}

	saveActiveEdit() {
		if (this.editingCardId === null) return;
		
		const cardEl = Array.from(this.contentEl.querySelectorAll(".fractal-card")).find(
			el => el.getAttribute("data-id") === this.editingCardId
		) as HTMLElement;
		
		if (cardEl) {
			const titleInput = cardEl.querySelector(".fractal-card-edit-title") as HTMLInputElement;
			let newContent = "";
			const cardInfo = this.findParent(this.root, this.editingCardId);
			const card = cardInfo ? cardInfo.parent.children[cardInfo.index] : null;

			if (this.activeEditorInstance) {
				if (this.activeEditorInstance.__fractalReady) {
					try {
						newContent = this.activeEditorInstance.getViewData();
					} catch (err) {
						console.error("Fractal: Failed to get view data", err);
						newContent = card ? card.content : "";
					}
				} else {
					newContent = card ? card.content : "";
				}
			} else {
				const textarea = cardEl.querySelector(".fractal-card-edit-body, .fractal-card-edit-body-raw") as HTMLTextAreaElement;
				if (textarea) newContent = textarea.value;
			}
			
			if (titleInput && card) {
				const newTitle = titleInput.value.trim() || "Untitled";
				
				// Auto-delete empty newly created cards
				if (newTitle === "New card" && newContent === "" && card.children.length === 0) {
					this.cleanupActiveEditor();
					this.editingCardId = null;
					this.originalCardTitle = null;
					this.originalCardContent = null;
					if (this.editBlurTimeout) {
						clearTimeout(this.editBlurTimeout);
						this.editBlurTimeout = null;
					}
					this.deleteCard(card);
					return;
				} else if (card.title !== newTitle || card.content !== newContent) {
					this.pushHistory();
					const oldIdMap = this.captureCardIdMap();
					card.title = newTitle;
					card.content = newContent;
					assignStableKeys(this.root);
					this.migrateTreeSettings(oldIdMap);
					this.updateActivePathToCard(card);
					this.requestSave();
				}
			}
		}
		this.cleanupActiveEditor();
		this.editingCardId = null;
		this.originalCardTitle = null;
		this.originalCardContent = null;
		if (this.editBlurTimeout) {
			clearTimeout(this.editBlurTimeout);
			this.editBlurTimeout = null;
		}
	}

	cancelEditingCard(card: FractalCard) {
		if (this.originalCardTitle !== null) {
			card.title = this.originalCardTitle;
		}
		if (this.originalCardContent !== null) {
			card.content = this.originalCardContent;
		}
		const shouldDelete = card.title === "New card" && card.content === "" && card.children.length === 0;

		this.cleanupActiveEditor();
		this.editingCardId = null;
		this.originalCardTitle = null;
		this.originalCardContent = null;
		if (this.editBlurTimeout) {
			clearTimeout(this.editBlurTimeout);
			this.editBlurTimeout = null;
		}
		
		if (shouldDelete) {
			this.deleteCard(card);
		} else {
			this.renderFractal();
		}
	}

	applyCenteredLayout() {
		const container = this.contentEl.querySelector(".fractal-view-container") as HTMLElement;
		if (!container) return;
		const columnsContainer = container.querySelector(".fractal-columns-container") as HTMLElement;
		if (!columnsContainer) return;

		const columns = Array.from(columnsContainer.querySelectorAll(".fractal-column")) as HTMLElement[];
		
		if (!this.plugin.settings.centeredNavigation) {
			columns.forEach(col => {
				col.style.transform = "";
			});
			columnsContainer.style.height = "";
			return;
		}

		const viewportHeight = container.clientHeight || 600;
		const baseline = viewportHeight / 2;
		let maxColumnHeight = 0;

		columns.forEach(col => {
			let cardEl = col.querySelector(".fractal-card.active") as HTMLElement;
			if (!cardEl) {
				cardEl = col.querySelector(".fractal-card.illuminated") as HTMLElement;
			}

			if (cardEl) {
				const cardCenter = cardEl.offsetTop + cardEl.offsetHeight / 2;
				const translateY = baseline - cardCenter;
				col.style.transform = `translateY(${translateY}px)`;
				
				const colHeight = col.scrollHeight + Math.abs(translateY);
				if (colHeight > maxColumnHeight) {
					maxColumnHeight = colHeight;
				}
			} else {
				col.style.transform = `translateY(${baseline - 50}px)`;
			}
		});

		columnsContainer.style.height = `${maxColumnHeight + baseline}px`;
	}

	constructor(leaf: WorkspaceLeaf, plugin: FractalPlugin) {
		super(leaf);
		this.plugin = plugin;
		
		// Global document-level and window-level resize listeners
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => this.handleKeyDown(e));
		this.registerDomEvent(window, "resize", () => {
			if (this.plugin.settings.centeredNavigation) {
				this.applyCenteredLayout();
			}
		});
	}

	getViewType(): string {
		return VIEW_TYPE_FRACTAL;
	}

	getDisplayText(): string {
		return this.file ? `Fractal: ${this.file.basename}` : "Fractal view";
	}

	resetDocumentState() {
		if (this.editBlurTimeout) {
			clearTimeout(this.editBlurTimeout);
			this.editBlurTimeout = null;
		}
		if (this.cardClickTimeout) {
			clearTimeout(this.cardClickTimeout);
			this.cardClickTimeout = null;
		}
		this.cleanupActiveEditor();
		this.unloadAllCardComponents();
		this.expandedCardIds.clear();
		this.historyUndoStack = [];
		this.historyRedoStack = [];
		this.activeKeysByLevel = {};
		this.previousSelectionByLevel = {};
		this.lastSelectedChildByParent = {};
		this.selectedLevel = 1;
		this.editingCardId = null;
		this.originalCardTitle = null;
		this.originalCardContent = null;
		this.editingYaml = false;
		this.editingRootContent = false;
	}

	// Invoked when file content changes or view loads
	setViewData(data: string, clear: boolean): void {
		if (clear) {
			this.resetDocumentState();
		}
		this.data = data;
		const parsed = parseMarkdown(data, this.file ? this.file.basename : "Untitled");
		this.root = parsed.root;
		this.frontmatter = parsed.frontmatter;

		// Select first cards by default if empty, but preserve the user's current selected level
		this.ensureSelectionPath();

		// If we transitioned from MarkdownView, set active selection path
		const targetId = this.plugin.lastActiveHeadingId;
		if (targetId) {
			const card = this.findCardById(this.root, targetId);
			if (card) {
				this.plugin.lastActiveHeadingId = null; // consume it only if successfully resolved
				this.updateActivePathToCard(card);
			}
		}

		if (!this.selectedLevel) {
			this.selectedLevel = this.getSelectedLevel();
		}

		this.renderFractal();
	}

	// Invoked by Obsidian to retrieve file data for saving
	getViewData(): string {
		return serializeTree(this.root, this.frontmatter);
	}

	clear(): void {
		this.resetDocumentState();
		this.root = {
			id: "root",
			headingLevel: 0,
			title: "Untitled",
			content: "",
			children: []
		};
		this.frontmatter = "";
		this.contentEl.empty();
	}

	async onClose(): Promise<void> {
		this.resetDocumentState();
		await super.onClose();
	}

	// Selection Path logic
	ensureSelectionPath() {
		this.activeKeysByLevel[0] = "root";

		let current = this.root;
		let currentLevel = 0;

		while (current && current.children.length > 0) {
			const level = currentLevel + 1;
			const currentActive = this.activeKeysByLevel[level];
			const childExists = current.children.find(c => c.id === currentActive);

			if (!childExists) {
				this.activeKeysByLevel[level] = current.children[0].id;
			}

			const nextId = this.activeKeysByLevel[level];
			const nextCard = current.children.find(c => c.id === nextId);
			if (nextCard) {
				current = nextCard;
				currentLevel = level;
			} else {
				break;
			}
		}
	}

	// Render the Fractal interface
	// Split into one-time setup (toolbar + canvas events) and per-click column refresh.
	async renderFractal() {
		const gen = ++this.renderGeneration;

		// Save current scroll position
		const oldContainer = this.contentEl.querySelector(".fractal-view-container") as HTMLElement;
		const oldScrollLeft = oldContainer ? oldContainer.scrollLeft : 0;
		const oldScrollTop = oldContainer ? oldContainer.scrollTop : 0;

		// Only rebuild full UI shell if it doesn't exist yet
		let container = this.contentEl.querySelector(".fractal-view-container") as HTMLElement;
		let metadataPanel = this.contentEl.querySelector(".fractal-metadata-panel") as HTMLElement;
		
		this.contentEl.addClass("fractal-view-content");

		if (!container) {
			this.unloadAllCardComponents();
			this.contentEl.empty();

			// 1. Render Top Header Toolbar (created once, not rebuilt on every click)
			const headerToolbar = this.contentEl.createDiv({ cls: "fractal-header-toolbar" });
			this.renderHeaderToolbar(headerToolbar);

			// 2. Create Metadata Panel (YAML & Intro)
			metadataPanel = this.contentEl.createDiv({ cls: "fractal-metadata-panel" });

			// 3. Create Canvas Container with all event listeners (once)
			container = this.contentEl.createDiv({ cls: "fractal-view-container" });
			this.setupCanvasEvents(container);
		} else {
			const titleEl = this.contentEl.querySelector(".fractal-toolbar-title") as HTMLElement;
			if (titleEl) {
				titleEl.setText(this.file ? this.file.basename : "Untitled");
			}
		}

		// Always update/render edit toolbar contents
		const editToolbar = this.contentEl.querySelector(".fractal-header-edit-toolbar") as HTMLElement;
		if (editToolbar) {
			this.renderEditToolbar(editToolbar);
		}

		this.applyThemeStyles();
		this.updateZoomStyles(container);

		// Always update/render metadata panel contents
		if (metadataPanel) {
			await this.renderMetadataPanel(metadataPanel, gen);
			if (gen !== this.renderGeneration) return;
		}

		// Refresh only the columns content (fast, no toolbar/canvas rebuild)
		await this.refreshColumns(container, oldScrollLeft, oldScrollTop, gen);
	}

	// Setup canvas event listeners — called only once during initial render.
	setupCanvasEvents(container: HTMLElement) {
		// Zoom using Ctrl + MouseWheel
		container.addEventListener("wheel", (e) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				let newZoom = this.plugin.settings.zoom - e.deltaY * 0.0002;
				newZoom = Math.min(Math.max(newZoom, 0.2), 1.1);
				this.plugin.settings.zoom = newZoom;
				this.plugin.saveSettings();
				this.updateZoomStyles(container);
				
				const zoomSlider = this.contentEl.querySelector(".fractal-toolbar-slider.zoom") as HTMLInputElement;
				const zoomInput = this.contentEl.querySelector(".zoom-input") as HTMLInputElement;
				if (zoomSlider) zoomSlider.value = newZoom.toString();
				if (zoomInput) zoomInput.value = Math.round(newZoom * 100).toString();
			}
		}, { passive: false });

		// Drag-to-pan Canvas Navigation
		container.addEventListener("mousedown", (e) => {
			const target = e.target as HTMLElement;
			if (target.classList.contains("fractal-view-container") || 
				target.classList.contains("fractal-columns-container") || 
				target.classList.contains("fractal-column")) {
				this.isDraggingCanvas = true;
				container.addClass("dragging");
				this.dragStartX = e.pageX - container.offsetLeft;
				this.dragStartY = e.pageY - container.offsetTop;
				this.dragScrollLeft = container.scrollLeft;
				this.dragScrollTop = container.scrollTop;
			}
		});

		container.addEventListener("mousemove", (e) => {
			if (!this.isDraggingCanvas) return;
			e.preventDefault();
			const x = e.pageX - container.offsetLeft;
			const y = e.pageY - container.offsetTop;
			const walkX = (x - this.dragStartX) * 1.5;
			const walkY = (y - this.dragStartY) * 1.5;
			container.scrollLeft = this.dragScrollLeft - walkX;
			container.scrollTop = this.dragScrollTop - walkY;
		});

		const stopDragging = () => {
			this.isDraggingCanvas = false;
			container.removeClass("dragging");
		};
		container.addEventListener("mouseup", stopDragging);
		container.addEventListener("mouseleave", stopDragging);

		// Keyboard focus
		container.setAttribute("tabindex", "0");
	}

	// Rebuild only the columns inside the canvas — called on every selection change.
	// Preserves toolbar and canvas event listeners for a smooth, flash-free experience.
	async refreshColumns(container: HTMLElement, oldScrollLeft: number, oldScrollTop: number, gen: number) {
		let columnsContainer = container.querySelector(".fractal-columns-container") as HTMLElement;
		if (!columnsContainer) {
			columnsContainer = container.createDiv({ cls: "fractal-columns-container" });
		}
		
		this.contentEl.removeClass("is-canvas-mode");
		this.contentEl.removeClass("is-mindmap-mode");

		// Ginkgo Mode (Default)
		let currentParent = this.root;
		let level = 1;
		// Show columns up to selectedLevel + 1 (preview column with selectable children)
		const maxVisibleLevel = (this.selectedLevel || 1) + 1;
		const levelsRendered = new Set<number>();

		while (currentParent && currentParent.children.length > 0) {
			if (gen !== this.renderGeneration) return;

			const isColCollapsed = this.isColumnCollapsed(level);
			if (isColCollapsed) break;

			const isNodeColl = this.file
				? (this.plugin.settings.collapsedNodes[this.file.path]?.[currentParent.id] || false)
				: false;
			if (isNodeColl) break;

			await this.updateOrCreateColumn(columnsContainer, currentParent, level, gen);
			if (gen !== this.renderGeneration) return;
			levelsRendered.add(level);

			if (level >= maxVisibleLevel) break;

			const activeId = this.activeKeysByLevel[level];
			const activeChild = currentParent.children.find(c => c.id === activeId);
			if (!activeChild) break;

			currentParent = activeChild;
			level++;
		}

		if (gen !== this.renderGeneration) return;

		if (level === 1 && currentParent && currentParent.children.length === 0 && 
			!this.isColumnCollapsed(level) && level <= maxVisibleLevel) {
			let emptyCol = columnsContainer.querySelector(`.fractal-column[data-level="${level}"]`) as HTMLElement;
			if (!emptyCol) {
				emptyCol = columnsContainer.createDiv({
					cls: "fractal-column",
					attr: { "data-level": level.toString() }
				});
				emptyCol.addClass("new-column-fade-in");
			} else {
				emptyCol.empty();
				emptyCol.className = "fractal-column";
			}
			emptyCol.removeAttribute("data-parent-id");

			emptyCol.createDiv({ cls: "fractal-column-spacer" });

			this.setupColumnDragAndDrop(emptyCol, level, currentParent);
			this.renderSiblingInsertContainer(emptyCol, currentParent, 0, level, true);
			levelsRendered.add(level);
		}

		const allColumnEls = Array.from(columnsContainer.querySelectorAll(".fractal-column")) as HTMLElement[];
		for (const colEl of allColumnEls) {
			const colLevel = parseInt(colEl.getAttribute("data-level") || "0");
			if (!levelsRendered.has(colLevel)) {
				this.unloadComponentsInContainer(colEl);
				colEl.remove();
			}
		}

		container.scrollLeft = oldScrollLeft;
		container.scrollTop = oldScrollTop;

		requestAnimationFrame(() => {
			if (gen !== this.renderGeneration) return;
			this.applyCenteredLayout();
			const activeEl = container.querySelector(".fractal-card.active") as HTMLElement;
			if (activeEl) {
				this.centerActiveCard(activeEl, container);
			}
			if (!this.editingCardId) {
				container.focus();
			}

		});
	}



	renderHeaderToolbar(parent: HTMLElement) {
		// Left Title group with toggle info button
		const titleGroup = parent.createDiv({ cls: "fractal-toolbar-title-group" });
		
		// Wrap toggle info button in a group to match the style of new buttons
		const toggleMetaBtnGroup = titleGroup.createDiv({ cls: "fractal-edit-toolbar-group" });
		const toggleMetaBtn = toggleMetaBtnGroup.createEl("button", {
			cls: `fractal-toolbar-btn meta-toggle-btn ${this.showMetadataPanel ? "active" : ""}`,
			title: "Properties and introduction"
		});
		setIcon(toggleMetaBtn, "info");
		toggleMetaBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showMetadataPanel = !this.showMetadataPanel;
			this.renderFractal();
		});



		// Document Title
		titleGroup.createDiv({ 
			cls: "fractal-toolbar-title", 
			text: this.file ? this.file.basename : "Untitled" 
		});

		const controls = parent.createDiv({ cls: "fractal-toolbar-controls" });

		// Create the dynamic edit toolbar container inside controls (on the left side of controls)
		controls.createDiv({ cls: "fractal-header-edit-toolbar" });

		// Group Style and Layout popover buttons in a single group to match the new style
		const viewSettingsGroup = controls.createDiv({ cls: "fractal-edit-toolbar-group" });

		const toggleZenBtn = viewSettingsGroup.createEl("button", {
			cls: `fractal-toolbar-btn zen-toggle-btn ${this.isZenMode ? "active" : ""}`,
			title: "Zen mode (full screen)"
		});
		setIcon(toggleZenBtn, this.isZenMode ? "shrink" : "expand");
		toggleZenBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleZenMode(toggleZenBtn);
		});

		// --- STYLE POPOVER WRAPPER & BUTTON & MENU ---
		const styleWrapper = viewSettingsGroup.createDiv({ cls: "fractal-popover-wrapper" });
		const btnStyle = styleWrapper.createEl("button", {
			cls: "fractal-toolbar-btn style-popover-btn",
			title: "Customize style and colors"
		});
		setIcon(btnStyle, "palette");

		const stylePopover = styleWrapper.createDiv({ cls: "fractal-popover-menu style-popover" });
		stylePopover.style.display = "none";

		// Popover Theme Row
		const themeRow = stylePopover.createDiv({ cls: "fractal-popover-row" });
		themeRow.createEl("span", { text: "Theme:" });
		const themeSelect = themeRow.createEl("select", { cls: "fractal-toolbar-select" });
		themeSelect.createEl("option", { value: "obsidian-theme", text: "Obsidian theme" });
		themeSelect.createEl("option", { value: "custom", text: "Custom" });
		themeSelect.value = this.plugin.settings.themeMode || "obsidian-theme";

		// Popover Swatches Grid
		const customColorsDiv = stylePopover.createDiv({ 
			cls: "fractal-custom-colors-container",
			attr: { style: this.plugin.settings.themeMode === "custom" ? "display: flex;" : "display: none;" }
		});

		this.renderCustomColors(customColorsDiv);

		themeSelect.addEventListener("change", () => {
			const val = themeSelect.value as "obsidian-theme" | "custom";
			this.plugin.settings.themeMode = val;
			this.plugin.saveSettings();
			
			if (val === "custom") {
				customColorsDiv.style.display = "flex";
			} else {
				customColorsDiv.style.display = "none";
			}
			
			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					leaf.view.applyThemeStyles();
				}
			}
		});

		// --- LAYOUT POPOVER WRAPPER & BUTTON & MENU ---
		const layoutWrapper = controls.createDiv({ cls: "fractal-popover-wrapper" });
		const btnLayout = layoutWrapper.createEl("button", {
			cls: "fractal-toolbar-btn layout-popover-btn",
			title: "Layout and zoom settings"
		});
		setIcon(btnLayout, "sliders");

		const layoutPopover = layoutWrapper.createDiv({ cls: "fractal-popover-menu layout-popover" });
		layoutPopover.style.display = "none";

		// Group 1: Canvas & text
		layoutPopover.createEl("div", { 
			cls: "fractal-popover-group-header", 
			text: "Canvas & text" 
		});

		// Zoom Row
		const zoomRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		zoomRow.createEl("span", { text: "Zoom:" });
		const zoomControls = zoomRow.createDiv({ cls: "fractal-popover-controls" });
		const zoomSlider = zoomControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider zoom",
			attr: {
				min: "0.20",
				max: "1.10",
				step: "0.01",
				value: this.plugin.settings.zoom.toString()
			}
		});
		const zoomInput = zoomControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input zoom-input",
			attr: {
				min: "20",
				max: "110",
				step: "1",
				value: Math.round(this.plugin.settings.zoom * 100).toString()
			}
		});
		zoomControls.createEl("span", { text: "%", cls: "fractal-popover-unit" });

		const updateZoom = (newZoom: number) => {
			newZoom = Math.min(Math.max(newZoom, 0.2), 1.1);
			this.plugin.settings.zoom = newZoom;
			this.plugin.saveSettings();
			zoomSlider.value = newZoom.toString();
			zoomInput.value = Math.round(newZoom * 100).toString();
			const container = this.contentEl.querySelector(".fractal-view-container") as HTMLElement;
			if (container) {
				this.updateZoomStyles(container);
			}
		};

		zoomSlider.addEventListener("input", () => {
			updateZoom(parseFloat(zoomSlider.value));
		});

		const commitZoom = () => {
			let val = parseInt(zoomInput.value);
			if (isNaN(val)) {
				zoomInput.value = Math.round(this.plugin.settings.zoom * 100).toString();
				return;
			}
			updateZoom(val / 100);
		};

		zoomInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				zoomInput.blur();
			}
		});

		zoomInput.addEventListener("blur", commitZoom);

		// Card Width Row
		const colWidthRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		colWidthRow.createEl("span", { text: "Card width:" });
		const colWidthControls = colWidthRow.createDiv({ cls: "fractal-popover-controls" });
		const colWidthSlider = colWidthControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "300",
				max: "800",
				step: "10",
				value: this.plugin.settings.columnWidth.toString()
			}
		});
		const colWidthInput = colWidthControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input width-input",
			attr: {
				min: "300",
				max: "800",
				step: "10",
				value: this.plugin.settings.columnWidth.toString()
			}
		});
		colWidthControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updateWidth = (newWidth: number) => {
			newWidth = Math.min(Math.max(newWidth, 300), 800);
			this.plugin.settings.columnWidth = newWidth;
			this.plugin.saveSettings();
			colWidthSlider.value = newWidth.toString();
			colWidthInput.value = newWidth.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		colWidthSlider.addEventListener("input", () => {
			updateWidth(parseInt(colWidthSlider.value));
		});

		const commitWidth = () => {
			let val = parseInt(colWidthInput.value);
			if (isNaN(val)) {
				colWidthInput.value = this.plugin.settings.columnWidth.toString();
				return;
			}
			updateWidth(val);
		};

		colWidthInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				colWidthInput.blur();
			}
		});

		colWidthInput.addEventListener("blur", commitWidth);

		// Inactive Card Height Row
		const inactiveHeightRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		inactiveHeightRow.createEl("span", { text: "Inactive height:" });
		const inactiveHeightControls = inactiveHeightRow.createDiv({ cls: "fractal-popover-controls" });
		
		const autoCheckbox = inactiveHeightControls.createEl("input", {
			type: "checkbox",
			cls: "fractal-popover-checkbox",
			attr: {
				id: "fractal-height-auto"
			}
		});
		const autoLabel = inactiveHeightControls.createEl("label", {
			text: "Auto",
			cls: "fractal-popover-checkbox-label",
			attr: {
				for: "fractal-height-auto"
			}
		});

		const inactiveHeightSlider = inactiveHeightControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "60",
				max: "290",
				step: "10",
				value: (this.plugin.settings.inactiveCardHeight < 300 ? this.plugin.settings.inactiveCardHeight : 150).toString()
			}
		});

		const inactiveHeightInput = inactiveHeightControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input height-input",
			attr: {
				min: "60",
				max: "290",
				step: "10",
				value: (this.plugin.settings.inactiveCardHeight < 300 ? this.plugin.settings.inactiveCardHeight : 150).toString()
			}
		});
		inactiveHeightControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updateInactiveHeight = (newHeight: number, isAuto: boolean) => {
			if (isAuto) {
				this.plugin.settings.inactiveCardHeight = 300;
				inactiveHeightSlider.disabled = true;
				inactiveHeightInput.disabled = true;
			} else {
				newHeight = Math.min(Math.max(newHeight, 60), 290);
				this.plugin.settings.inactiveCardHeight = newHeight;
				inactiveHeightSlider.disabled = false;
				inactiveHeightInput.disabled = false;
				inactiveHeightSlider.value = newHeight.toString();
				inactiveHeightInput.value = newHeight.toString();
			}
			autoCheckbox.checked = isAuto;
			this.plugin.saveSettings();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		// Initial height setup
		updateInactiveHeight(this.plugin.settings.inactiveCardHeight, this.plugin.settings.inactiveCardHeight >= 300);

		autoCheckbox.addEventListener("change", () => {
			const isAuto = autoCheckbox.checked;
			const val = parseInt(inactiveHeightInput.value) || 150;
			updateInactiveHeight(val, isAuto);
		});

		inactiveHeightSlider.addEventListener("input", () => {
			updateInactiveHeight(parseInt(inactiveHeightSlider.value), false);
		});

		const commitInactiveHeight = () => {
			let val = parseInt(inactiveHeightInput.value);
			if (isNaN(val)) {
				const curHeight = this.plugin.settings.inactiveCardHeight < 300 ? this.plugin.settings.inactiveCardHeight : 150;
				inactiveHeightInput.value = curHeight.toString();
				return;
			}
			updateInactiveHeight(val, false);
		};

		inactiveHeightInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				inactiveHeightInput.blur();
			}
		});

		inactiveHeightInput.addEventListener("blur", commitInactiveHeight);

		// Text Size Row
		const textSizeRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		textSizeRow.createEl("span", { text: "Text size:" });
		const textSizeControls = textSizeRow.createDiv({ cls: "fractal-popover-controls" });
		const textSizeSlider = textSizeControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "10",
				max: "24",
				step: "1",
				value: (this.plugin.settings.fontSize || 14).toString()
			}
		});
		const textSizeInput = textSizeControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input text-size-input",
			attr: {
				min: "10",
				max: "24",
				step: "1",
				value: (this.plugin.settings.fontSize || 14).toString()
			}
		});
		textSizeControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updateTextSize = (newSize: number) => {
			newSize = Math.min(Math.max(newSize, 10), 24);
			this.plugin.settings.fontSize = newSize;
			this.plugin.saveSettings();
			textSizeSlider.value = newSize.toString();
			textSizeInput.value = newSize.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		textSizeSlider.addEventListener("input", () => {
			updateTextSize(parseInt(textSizeSlider.value));
		});

		const commitTextSize = () => {
			let val = parseInt(textSizeInput.value);
			if (isNaN(val)) {
				textSizeInput.value = (this.plugin.settings.fontSize || 14).toString();
				return;
			}
			updateTextSize(val);
		};

		textSizeInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				textSizeInput.blur();
			}
		});

		textSizeInput.addEventListener("blur", commitTextSize);

		// Divider 1
		layoutPopover.createEl("hr", { cls: "fractal-popover-divider" });

		// Group 2: Background grid
		layoutPopover.createEl("div", { 
			cls: "fractal-popover-group-header", 
			text: "Background grid" 
		});

		// Show Grid Row
		const showGridRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		showGridRow.createEl("span", { text: "Show grid:" });
		const showGridControls = showGridRow.createDiv({ cls: "fractal-popover-controls" });
		const gridCheckbox = showGridControls.createEl("input", {
			type: "checkbox",
			cls: "fractal-popover-checkbox",
			attr: {
				id: "fractal-show-grid"
			}
		});
		gridCheckbox.checked = (this.plugin.settings.showGrid !== false);
		const gridCheckboxLabel = showGridControls.createEl("label", {
			text: "Enable",
			cls: "fractal-popover-checkbox-label",
			attr: {
				for: "fractal-show-grid"
			}
		});

		// Grid Opacity Row
		const gridOpacityRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		gridOpacityRow.createEl("span", { text: "Grid opacity:" });
		const gridOpacityControls = gridOpacityRow.createDiv({ cls: "fractal-popover-controls" });
		const gridOpacitySlider = gridOpacityControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "0",
				max: "100",
				step: "5",
				value: Math.round((this.plugin.settings.gridOpacity !== undefined ? this.plugin.settings.gridOpacity : 0.03) * 100).toString()
			}
		});
		const gridOpacityInput = gridOpacityControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input grid-opacity-input",
			attr: {
				min: "0",
				max: "100",
				step: "5",
				value: Math.round((this.plugin.settings.gridOpacity !== undefined ? this.plugin.settings.gridOpacity : 0.03) * 100).toString()
			}
		});
		gridOpacityControls.createEl("span", { text: "%", cls: "fractal-popover-unit" });

		const updateGrid = (showGrid: boolean, opacityPct: number) => {
			opacityPct = Math.min(Math.max(opacityPct, 0), 100);
			const opacityVal = opacityPct / 100;
			
			this.plugin.settings.showGrid = showGrid;
			this.plugin.settings.gridOpacity = opacityVal;
			this.plugin.saveSettings();

			gridCheckbox.checked = showGrid;
			gridOpacitySlider.value = opacityPct.toString();
			gridOpacityInput.value = opacityPct.toString();

			gridOpacitySlider.disabled = !showGrid;
			gridOpacityInput.disabled = !showGrid;

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		// Initial grid state setup
		updateGrid(this.plugin.settings.showGrid !== false, Math.round((this.plugin.settings.gridOpacity !== undefined ? this.plugin.settings.gridOpacity : 0.03) * 100));

		gridCheckbox.addEventListener("change", () => {
			const showGrid = gridCheckbox.checked;
			const opacityPct = parseInt(gridOpacityInput.value) || 3;
			updateGrid(showGrid, opacityPct);
		});

		gridOpacitySlider.addEventListener("input", () => {
			updateGrid(gridCheckbox.checked, parseInt(gridOpacitySlider.value));
		});

		const commitGridOpacity = () => {
			let val = parseInt(gridOpacityInput.value);
			if (isNaN(val)) {
				const curOpacity = Math.round((this.plugin.settings.gridOpacity !== undefined ? this.plugin.settings.gridOpacity : 0.03) * 100);
				gridOpacityInput.value = curOpacity.toString();
				return;
			}
			updateGrid(gridCheckbox.checked, val);
		};

		gridOpacityInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				gridOpacityInput.blur();
			}
		});

		gridOpacityInput.addEventListener("blur", commitGridOpacity);

		// Divider 2
		layoutPopover.createEl("hr", { cls: "fractal-popover-divider" });

		// Group 3: Card layout & spacing
		layoutPopover.createEl("div", { 
			cls: "fractal-popover-group-header", 
			text: "Card layout & spacing" 
		});

		// Auto Card Spacing Row
		const autoSpacingRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		autoSpacingRow.createEl("span", { text: "Auto card spacing:" });
		const autoSpacingControls = autoSpacingRow.createDiv({ cls: "fractal-popover-controls" });
		const autoSpacingCheckbox = autoSpacingControls.createEl("input", {
			type: "checkbox",
			cls: "fractal-popover-checkbox",
			attr: {
				id: "fractal-spacing-auto"
			}
		});
		const autoSpacingLabel = autoSpacingControls.createEl("label", {
			text: "Auto",
			cls: "fractal-popover-checkbox-label",
			attr: {
				for: "fractal-spacing-auto"
			}
		});

		// Set initial checkbox state
		autoSpacingCheckbox.checked = this.plugin.settings.autoCardSpacing !== false;

		autoSpacingCheckbox.addEventListener("change", () => {
			const isChecked = autoSpacingCheckbox.checked;
			this.plugin.settings.autoCardSpacing = isChecked;
			this.plugin.saveSettings();
			updateAutoSpacingControlsState(isChecked);

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		});

		// Title Size Row
		const titleSizeRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		titleSizeRow.createEl("span", { text: "Title size:" });
		const titleSizeControls = titleSizeRow.createDiv({ cls: "fractal-popover-controls" });
		const titleSizeSlider = titleSizeControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "12",
				max: "28",
				step: "1",
				value: (this.plugin.settings.titleFontSize || 16).toString()
			}
		});
		const titleSizeInput = titleSizeControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input title-size-input",
			attr: {
				min: "12",
				max: "28",
				step: "1",
				value: (this.plugin.settings.titleFontSize || 16).toString()
			}
		});
		titleSizeControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updateTitleSize = (newSize: number) => {
			newSize = Math.min(Math.max(newSize, 12), 28);
			this.plugin.settings.titleFontSize = newSize;
			this.plugin.saveSettings();
			titleSizeSlider.value = newSize.toString();
			titleSizeInput.value = newSize.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		titleSizeSlider.addEventListener("input", () => {
			updateTitleSize(parseInt(titleSizeSlider.value));
		});

		const commitTitleSize = () => {
			let val = parseInt(titleSizeInput.value);
			if (isNaN(val)) {
				titleSizeInput.value = (this.plugin.settings.titleFontSize || 16).toString();
				return;
			}
			updateTitleSize(val);
		};

		titleSizeInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				titleSizeInput.blur();
			}
		});

		titleSizeInput.addEventListener("blur", commitTitleSize);

		// Card Padding Y Row
		const paddingYRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		paddingYRow.createEl("span", { text: "Card padding Y:" });
		const paddingYControls = paddingYRow.createDiv({ cls: "fractal-popover-controls" });
		const paddingYSlider = paddingYControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "4",
				max: "24",
				step: "1",
				value: (this.plugin.settings.cardPaddingY || 12).toString()
			}
		});
		const paddingYInput = paddingYControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input padding-y-input",
			attr: {
				min: "4",
				max: "24",
				step: "1",
				value: (this.plugin.settings.cardPaddingY || 12).toString()
			}
		});
		paddingYControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updatePaddingY = (newPadding: number) => {
			newPadding = Math.min(Math.max(newPadding, 4), 24);
			this.plugin.settings.cardPaddingY = newPadding;
			this.plugin.saveSettings();
			paddingYSlider.value = newPadding.toString();
			paddingYInput.value = newPadding.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		paddingYSlider.addEventListener("input", () => {
			updatePaddingY(parseInt(paddingYSlider.value));
		});

		const commitPaddingY = () => {
			let val = parseInt(paddingYInput.value);
			if (isNaN(val)) {
				paddingYInput.value = (this.plugin.settings.cardPaddingY || 12).toString();
				return;
			}
			updatePaddingY(val);
		};

		paddingYInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				paddingYInput.blur();
			}
		});

		paddingYInput.addEventListener("blur", commitPaddingY);

		// Card Padding X Row
		const paddingXRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		paddingXRow.createEl("span", { text: "Card padding X:" });
		const paddingXControls = paddingXRow.createDiv({ cls: "fractal-popover-controls" });
		const paddingXSlider = paddingXControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "4",
				max: "24",
				step: "1",
				value: (this.plugin.settings.cardPaddingX || 14).toString()
			}
		});
		const paddingXInput = paddingXControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input padding-x-input",
			attr: {
				min: "4",
				max: "24",
				step: "1",
				value: (this.plugin.settings.cardPaddingX || 14).toString()
			}
		});
		paddingXControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updatePaddingX = (newPadding: number) => {
			newPadding = Math.min(Math.max(newPadding, 4), 24);
			this.plugin.settings.cardPaddingX = newPadding;
			this.plugin.saveSettings();
			paddingXSlider.value = newPadding.toString();
			paddingXInput.value = newPadding.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		paddingXSlider.addEventListener("input", () => {
			updatePaddingX(parseInt(paddingXSlider.value));
		});

		const commitPaddingX = () => {
			let val = parseInt(paddingXInput.value);
			if (isNaN(val)) {
				paddingXInput.value = (this.plugin.settings.cardPaddingX || 14).toString();
				return;
			}
			updatePaddingX(val);
		};

		paddingXInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				paddingXInput.blur();
			}
		});

		paddingXInput.addEventListener("blur", commitPaddingX);

		// Card Gap Row
		const cardGapRow = layoutPopover.createDiv({ cls: "fractal-popover-row" });
		cardGapRow.createEl("span", { text: "Card gap:" });
		const cardGapControls = cardGapRow.createDiv({ cls: "fractal-popover-controls" });
		const cardGapSlider = cardGapControls.createEl("input", {
			type: "range",
			cls: "fractal-toolbar-slider",
			attr: {
				min: "2",
				max: "16",
				step: "1",
				value: (this.plugin.settings.cardGap || 8).toString()
			}
		});
		const cardGapInput = cardGapControls.createEl("input", {
			type: "number",
			cls: "fractal-toolbar-number-input gap-input",
			attr: {
				min: "2",
				max: "16",
				step: "1",
				value: (this.plugin.settings.cardGap || 8).toString()
			}
		});
		cardGapControls.createEl("span", { text: "px", cls: "fractal-popover-unit" });

		const updateCardGap = (newGap: number) => {
			newGap = Math.min(Math.max(newGap, 2), 16);
			this.plugin.settings.cardGap = newGap;
			this.plugin.saveSettings();
			cardGapSlider.value = newGap.toString();
			cardGapInput.value = newGap.toString();

			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					const leafContainer = leaf.view.contentEl.querySelector(".fractal-view-container") as HTMLElement;
					if (leafContainer) {
						leaf.view.updateZoomStyles(leafContainer);
					}
				}
			}
		};

		cardGapSlider.addEventListener("input", () => {
			updateCardGap(parseInt(cardGapSlider.value));
		});

		const commitCardGap = () => {
			let val = parseInt(cardGapInput.value);
			if (isNaN(val)) {
				cardGapInput.value = (this.plugin.settings.cardGap || 8).toString();
				return;
			}
			updateCardGap(val);
		};

		cardGapInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				cardGapInput.blur();
			}
		});

		cardGapInput.addEventListener("blur", commitCardGap);

		// Auto Card Spacing checkbox toggle handler and initial disabled state
		const updateAutoSpacingControlsState = (isAuto: boolean) => {
			titleSizeSlider.disabled = isAuto;
			titleSizeInput.disabled = isAuto;
			paddingYSlider.disabled = isAuto;
			paddingYInput.disabled = isAuto;
			paddingXSlider.disabled = isAuto;
			paddingXInput.disabled = isAuto;
			cardGapSlider.disabled = isAuto;
			cardGapInput.disabled = isAuto;
		};

		// Initialize disabled state based on saved settings
		updateAutoSpacingControlsState(this.plugin.settings.autoCardSpacing !== false);

		// Event listeners to toggle popovers
		btnStyle.addEventListener("click", (evt) => {
			evt.stopPropagation();
			layoutPopover.style.display = "none";
			const current = stylePopover.style.display;
			stylePopover.style.display = current === "none" ? "block" : "none";
		});

		btnLayout.addEventListener("click", (evt) => {
			evt.stopPropagation();
			stylePopover.style.display = "none";
			const current = layoutPopover.style.display;
			layoutPopover.style.display = current === "none" ? "block" : "none";
		});

		// Close popovers on click outside (persists for view lifetime)
		const closePopovers = (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (!target.closest(".fractal-popover-menu") && 
				!target.closest(".style-popover-btn") && 
				!target.closest(".layout-popover-btn")) {
				stylePopover.style.display = "none";
				layoutPopover.style.display = "none";
			}
		};
		this.registerDomEvent(document, "click", closePopovers);

		// --- ACTION BUTTONS (Undo/Redo, grouped in an edit-toolbar-group to match style) ---
		const buttonsGroup = controls.createDiv({ cls: "fractal-edit-toolbar-group" });

		const btnUndo = buttonsGroup.createEl("button", {
			cls: "fractal-toolbar-btn",
			title: "Undo (Ctrl/Cmd + Z)"
		});
		setIcon(btnUndo, "undo");
		btnUndo.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.undo();
		});

		const btnRedo = buttonsGroup.createEl("button", {
			cls: "fractal-toolbar-btn",
			title: "Redo (Ctrl/Cmd + Y)"
		});
		setIcon(btnRedo, "redo");
		btnRedo.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.redo();
		});

		// View Mode Dropdown is hidden as requested
		this.plugin.settings.viewMode = "ginkgo";

	}

	renderEditToolbar(parent: HTMLElement) {
		parent.empty();
		
		const activeId = this.activeKeysByLevel[this.selectedLevel];
		const activeCard = activeId && activeId !== "root" ? this.findCardById(this.root, activeId) : null;
		
		if (this.editingCardId !== null) {
			// --- EDITING MODE: Show Markdown Formatting Controls ---
			const formatGroup = parent.createDiv({ cls: "fractal-edit-toolbar-group formatting" });
			
			// Bold button
			const btnBold = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn format-btn",
				title: "Bold"
			});
			setIcon(btnBold, "bold");
			btnBold.addEventListener("click", (e) => {
				e.stopPropagation();
				this.insertFormatting('bold');
			});
			
			// Italic button
			const btnItalic = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn format-btn",
				title: "Italic"
			});
			setIcon(btnItalic, "italic");
			btnItalic.addEventListener("click", (e) => {
				e.stopPropagation();
				this.insertFormatting('italic');
			});
			
			// Code button
			const btnCode = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn format-btn",
				title: "Code"
			});
			setIcon(btnCode, "code");
			btnCode.addEventListener("click", (e) => {
				e.stopPropagation();
				this.insertFormatting('code');
			});
			
			// Link button
			const btnLink = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn format-btn",
				title: "Internal link [[ ]]"
			});
			setIcon(btnLink, "link");
			btnLink.addEventListener("click", (e) => {
				e.stopPropagation();
				this.insertFormatting('link');
			});
			
			// List button
			const btnList = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn format-btn",
				title: "Bullet list"
			});
			setIcon(btnList, "list");
			btnList.addEventListener("click", (e) => {
				e.stopPropagation();
				this.insertFormatting('list');
			});

			// Divider
			formatGroup.createDiv({ cls: "fractal-toolbar-divider" });

			// Save button
			const btnSave = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn save-btn",
				title: "Save & exit (Esc)"
			});
			setIcon(btnSave, "check");
			btnSave.addEventListener("click", (e) => {
				e.stopPropagation();
				if (activeCard) {
					const cardEl = Array.from(this.contentEl.querySelectorAll(".fractal-card")).find(
						el => el.getAttribute("data-id") === this.editingCardId
					) as HTMLElement;
					if (cardEl) {
						const titleInput = cardEl.querySelector(".fractal-card-edit-title") as HTMLInputElement;
						const editorContainer = cardEl.querySelector(".lineage-inline-editor") as HTMLElement;
						this.triggerAutoSaveAndExit(activeCard, titleInput, editorContainer || cardEl);
					}
				}
			});

			// Cancel button
			const btnCancel = formatGroup.createEl("button", {
				cls: "fractal-toolbar-btn cancel-btn",
				title: "Cancel"
			});
			setIcon(btnCancel, "x");
			btnCancel.addEventListener("click", (e) => {
				e.stopPropagation();
				const editingCard = this.editingCardId
					? this.findCardById(this.root, this.editingCardId)
					: null;
				if (editingCard) {
					this.cancelEditingCard(editingCard);
				} else {
					this.cleanupActiveEditor();
					this.editingCardId = null;
					this.originalCardTitle = null;
					this.originalCardContent = null;
					this.renderFractal();
				}
			});
			
		} else if (activeCard) {
			// --- DISPLAY MODE: Show Card Operations (when a card is selected) ---
			const cardOpsGroup = parent.createDiv({ cls: "fractal-edit-toolbar-group card-ops" });
			
			// Edit Card Button
			const btnEdit = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn",
				title: "Edit card (double-click)"
			});
			setIcon(btnEdit, "pencil");
			btnEdit.addEventListener("click", (e) => {
				e.stopPropagation();
				this.editingCardId = activeCard.id;
				this.originalCardTitle = activeCard.title;
				this.originalCardContent = activeCard.content;
				this.renderFractal();
			});
			
			// Add Child Button
			const btnAddChild = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn",
				title: "Add child card"
			});
			setIcon(btnAddChild, "corner-down-right");
			btnAddChild.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.selectedLevel < 6) {
					this.insertCard(activeCard, activeCard.children.length, this.selectedLevel + 1);
				} else {
					new Notice("Maximum nesting depth reached");
				}
			});
			
			// Add Sibling Button
			const btnAddSibling = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn",
				title: "Add sibling card"
			});
			setIcon(btnAddSibling, "plus");
			btnAddSibling.addEventListener("click", (e) => {
				e.stopPropagation();
				const parentInfo = this.findParent(this.root, activeCard.id);
				if (parentInfo) {
					this.insertCard(parentInfo.parent, parentInfo.index + 1, this.selectedLevel);
				} else {
					this.insertCard(this.root, this.root.children.length, 1);
				}
			});
			
			// Delete Button
			const btnDelete = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn delete-btn",
				title: "Delete card"
			});
			setIcon(btnDelete, "trash");
			btnDelete.addEventListener("click", (e) => {
				e.stopPropagation();
				new ConfirmModal(this.app, {
					title: "Delete card",
					message: `Are you sure you want to delete card "${activeCard.title}" and all of its sub-sections?`,
					confirmText: "Delete",
					isWarning: true,
					onConfirm: () => this.deleteCard(activeCard)
				}).open();
			});

			// Divider
			cardOpsGroup.createDiv({ cls: "fractal-toolbar-divider" });

			// Move Card Buttons (Up / Down)
			const btnMoveUp = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn move-btn",
				title: "Move card up"
			});
			setIcon(btnMoveUp, "arrow-up");
			btnMoveUp.addEventListener("click", (e) => {
				e.stopPropagation();
				this.moveCardInList(activeCard, 'up');
			});

			const btnMoveDown = cardOpsGroup.createEl("button", {
				cls: "fractal-toolbar-btn move-btn",
				title: "Move card down"
			});
			setIcon(btnMoveDown, "arrow-down");
			btnMoveDown.addEventListener("click", (e) => {
				e.stopPropagation();
				this.moveCardInList(activeCard, 'down');
			});
		} else {
			// No card is selected
			const infoGroup = parent.createDiv({ cls: "fractal-edit-toolbar-group info" });
			infoGroup.createSpan({
				cls: "fractal-toolbar-info-text",
				text: "Select a card to view edit options"
			});
		}
	}

	insertFormatting(format: 'bold' | 'italic' | 'code' | 'link' | 'list') {
		if (this.editingCardId === null) return;
		
		if (this.activeEditorInstance && this.activeEditorInstance.editor) {
			const editor = this.activeEditorInstance.editor;
			const selection = editor.getSelection();
			
			switch (format) {
				case 'bold':
					if (selection.startsWith('**') && selection.endsWith('**')) {
						editor.replaceSelection(selection.slice(2, -2));
					} else {
						editor.replaceSelection('**' + selection + '**');
					}
					break;
				case 'italic':
					if (selection.startsWith('*') && selection.endsWith('*')) {
						editor.replaceSelection(selection.slice(1, -1));
					} else {
						editor.replaceSelection('*' + selection + '*');
					}
					break;
				case 'code':
					if (selection.startsWith('`') && selection.endsWith('`')) {
						editor.replaceSelection(selection.slice(1, -1));
					} else {
						editor.replaceSelection('`' + selection + '`');
					}
					break;
				case 'link':
					if (selection.startsWith('[[') && selection.endsWith(']]')) {
						editor.replaceSelection(selection.slice(2, -2));
					} else {
						editor.replaceSelection('[[' + selection + ']]');
					}
					break;
				case 'list':
					const lines = selection.split('\n');
					const formatted = lines.map((line: string) => {
						if (line.startsWith('- ')) {
							return line.substring(2);
						} else {
							return '- ' + line;
						}
					}).join('\n');
					editor.replaceSelection(formatted);
					break;
			}
			editor.focus();
		} else {
			const cardEl = Array.from(this.contentEl.querySelectorAll(".fractal-card")).find(
				el => el.getAttribute("data-id") === this.editingCardId
			) as HTMLElement;
			if (!cardEl) return;
			const textarea = cardEl.querySelector("textarea") as HTMLTextAreaElement;
			if (!textarea) return;
			
			const start = textarea.selectionStart;
			const end = textarea.selectionEnd;
			const text = textarea.value;
			const selection = text.substring(start, end);
			
			let replacement = "";
			switch (format) {
				case 'bold':
					replacement = selection.startsWith('**') && selection.endsWith('**') ? selection.slice(2, -2) : '**' + selection + '**';
					break;
				case 'italic':
					replacement = selection.startsWith('*') && selection.endsWith('*') ? selection.slice(1, -1) : '*' + selection + '*';
					break;
				case 'code':
					replacement = selection.startsWith('`') && selection.endsWith('`') ? selection.slice(1, -1) : '`' + selection + '`';
					break;
				case 'link':
					replacement = selection.startsWith('[[') && selection.endsWith(']]') ? selection.slice(2, -2) : '[[' + selection + ']]';
					break;
				case 'list':
					const lines = selection.split('\n');
					replacement = lines.map((line: string) => line.startsWith('- ') ? line.substring(2) : '- ' + line).join('\n');
					break;
			}
			
			textarea.value = text.substring(0, start) + replacement + text.substring(end);
			textarea.focus();
			textarea.setSelectionRange(start, start + replacement.length);
		}
	}

	moveCardInList(card: FractalCard, direction: 'up' | 'down') {
		const parentInfo = this.findParent(this.root, card.id);
		const parent = parentInfo ? parentInfo.parent : this.root;
		const index = parentInfo ? parentInfo.index : parent.children.findIndex(c => c.id === card.id);
		
		if (index === -1) return;
		
		const targetIndex = direction === 'up' ? index - 1 : index + 1;
		if (targetIndex < 0 || targetIndex >= parent.children.length) {
			new Notice(direction === 'up' ? "Already at the top of the list" : "Already at the bottom of the list");
			return;
		}
		
		this.pushHistory();
		const oldIdMap = this.captureCardIdMap();
		const temp = parent.children[index];
		parent.children[index] = parent.children[targetIndex];
		parent.children[targetIndex] = temp;
		
		assignStableKeys(this.root);
		this.migrateTreeSettings(oldIdMap);
		this.updateActivePathToCard(card);
		this.requestSave();
		this.renderFractal();
		new Notice(`Card "${card.title}" moved`);
	}

	renderCustomColors(customColorsDiv: HTMLElement) {
		customColorsDiv.empty();

		// 1. Render tabs
		const tabsRow = customColorsDiv.createDiv({ cls: "fractal-custom-tabs-row" });
		const tabNames = ["Text", "Title", "Canvas", "Active", "Dimmed", "Aura"] as const;
		
		const updateAllViews = () => {
			const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
			for (const leaf of leaves) {
				if (leaf.view instanceof FractalView) {
					leaf.view.applyThemeStyles();
				}
			}
		};

		tabNames.forEach(tabName => {
			const btn = tabsRow.createEl("button", {
				cls: `fractal-custom-tab-btn ${this.activeColorTab === tabName ? "active" : ""}`,
				text: tabName
			});
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.activeColorTab = tabName;
				this.renderCustomColors(customColorsDiv);
			});
		});

		// 2. Determine current active color for the selected tab
		let currentVal = "#ffffff";
		if (this.activeColorTab === "Text") currentVal = this.plugin.settings.textColor || "#eef1f6";
		else if (this.activeColorTab === "Title") currentVal = this.plugin.settings.customTitleColor || "#ebf8ff";
		else if (this.activeColorTab === "Canvas") currentVal = this.plugin.settings.canvasBgColor || "#0d1b2a";
		else if (this.activeColorTab === "Active") currentVal = this.plugin.settings.activeCardColor || "#ffffff";
		else if (this.activeColorTab === "Dimmed") currentVal = this.plugin.settings.inactiveCardColor || "#1a365d";
		else if (this.activeColorTab === "Aura") currentVal = this.plugin.settings.auraColor || "#3a86c8";

		// Normalize colors for comparison (lowercase)
		const normalizedCurrentVal = currentVal.toLowerCase();

		// 3. Render palettes container
		const palettesContainer = customColorsDiv.createDiv({ cls: "fractal-custom-palettes-container" });
		
		const COLOR_PALETTES = [
			// 1. Scale di nero / grigio scuro (Grayscale Dark - Nero)
			["#777777", "#555555", "#333333", "#111111", "#000000"],
			// 2. Scale di bianco / grigio chiaro (Grayscale Light - Bianco)
			["#FFFFFF", "#D9D9D9", "#B0B0B0", "#999999", "#777777"],
			// 3. Blu (New Blue)
			["#B3CDE0", "#6497B1", "#005B96", "#03396C", "#011F4B"],
			// 4. Verde (New Teal)
			["#b2dfdb", "#4db6ac", "#009688", "#00796b", "#004d40"],
			// 5. Rosso (New Red)
			["#FFBABA", "#FF7B7B", "#FF5252", "#FF0000", "#A70000"],
			// 6. Warm & Neutral
			["#F5E3CB", "#E1DCB6", "#E9C386", "#DA895A", "#BD6060"],
			// 7. Blue/Teal (Classic)
			["#F1F3F5", "#A9BCC6", "#52C1B9", "#29A9D1", "#004B67"],
			// 8. Pink/Purple/Blue
			["#FFE8E8", "#E2F0F9", "#EADBF7", "#E5A1B4", "#414F6E"],
			// 9. Relax
			["#FDF8E2", "#FFDDD3", "#F3BFB3", "#9ACDE0", "#5EA9BE"]
		];

		COLOR_PALETTES.forEach(palette => {
			const row = palettesContainer.createDiv({ cls: "fractal-custom-palette-row" });
			palette.forEach(color => {
				const isSwatchActive = color.toLowerCase() === normalizedCurrentVal;
				const swatch = row.createDiv({
					cls: `fractal-custom-swatch ${isSwatchActive ? "active" : ""}`,
					attr: { style: `background-color: ${color};`, title: color }
				});
				swatch.addEventListener("click", (e) => {
					e.stopPropagation();
					
					// Set the setting
					if (this.activeColorTab === "Text") this.plugin.settings.textColor = color;
					else if (this.activeColorTab === "Title") this.plugin.settings.customTitleColor = color;
					else if (this.activeColorTab === "Canvas") this.plugin.settings.canvasBgColor = color;
					else if (this.activeColorTab === "Active") this.plugin.settings.activeCardColor = color;
					else if (this.activeColorTab === "Dimmed") this.plugin.settings.inactiveCardColor = color;
					else if (this.activeColorTab === "Aura") this.plugin.settings.auraColor = color;

					this.plugin.saveSettings();
					updateAllViews();
					
					// Re-render this custom colors panel to move the active marker
					this.renderCustomColors(customColorsDiv);
				});
			});
		});
	}

	async updateOrCreateColumn(container: HTMLElement, parent: FractalCard, level: number, gen: number) {
		let columnEl = container.querySelector(`.fractal-column[data-level="${level}"]`) as HTMLElement;
		const isPreview = level > (this.selectedLevel || 1);
		const expectedParentId = parent.id;

		const hasEditingCard = parent.children.some(c => c.id === this.editingCardId);
		const isCurrentlyEditing = columnEl ? (
			!!columnEl.querySelector(".fractal-card-edit-body") ||
			!!columnEl.querySelector(".fractal-card-edit-title") ||
			!!columnEl.querySelector(".lineage-inline-editor")
		) : false;

		const needsRebuild = !columnEl || 
			columnEl.getAttribute("data-parent-id") !== expectedParentId ||
			hasEditingCard !== isCurrentlyEditing;

		if (!columnEl) {
			columnEl = container.createDiv({
				cls: `fractal-column ${isPreview ? "preview-column" : ""}`,
				attr: { 
					"data-level": level.toString(),
					"data-parent-id": expectedParentId
				}
			});
			columnEl.addClass("new-column-fade-in");
		} else {
			columnEl.className = `fractal-column ${isPreview ? "preview-column" : ""}`;
			columnEl.setAttribute("data-parent-id", expectedParentId);
			columnEl.removeClass("new-column-fade-in");
		}

		if (needsRebuild) {
			this.unloadComponentsInContainer(columnEl);
			columnEl.empty();
			columnEl.createDiv({ cls: "fractal-column-spacer" });
			this.setupColumnDragAndDrop(columnEl, level, parent);
			this.renderSiblingInsertContainer(columnEl, parent, 0, level);

			for (let i = 0; i < parent.children.length; i++) {
				if (gen !== this.renderGeneration) return;
				const card = parent.children[i];
				const activeId = this.activeKeysByLevel[level];
				const isActive = activeId === card.id && level <= (this.selectedLevel || 1);

				await this.renderCard(columnEl, card, level, isActive);
				this.renderSiblingInsertContainer(columnEl, parent, i + 1, level);
			}
		} else {
			let spacer = columnEl.querySelector(".fractal-column-spacer") as HTMLElement;
			if (!spacer) {
				spacer = document.createElement("div");
				spacer.className = "fractal-column-spacer";
				columnEl.prepend(spacer);
			}
			const cardEls = Array.from(columnEl.querySelectorAll(".fractal-card")) as HTMLElement[];
			
			let idsMatch = cardEls.length === parent.children.length;
			if (idsMatch) {
				for (let i = 0; i < parent.children.length; i++) {
					if (cardEls[i].getAttribute("data-id") !== parent.children[i].id) {
						idsMatch = false;
						break;
					}
				}
			}

			if (idsMatch) {
				for (let i = 0; i < parent.children.length; i++) {
					if (gen !== this.renderGeneration) return;
					const card = parent.children[i];
					const cardEl = cardEls[i];
					
					const activeId = this.activeKeysByLevel[level];
					const isActive = activeId === card.id && level <= (this.selectedLevel || 1);
					const isIlluminated = this.isCardIlluminated(card, level);
					
					const wasExpandedBefore = cardEl.hasClass("was-expanded");
					cardEl.className = "fractal-card";
					if (wasExpandedBefore) {
						cardEl.addClass("was-expanded");
					}
					if (isActive && level === this.selectedLevel) {
						cardEl.addClass("active");
					} else if (isIlluminated) {
						cardEl.addClass("illuminated");
					}
					
					const colorClass = this.file ? (this.plugin.settings.cardColors[this.file.path]?.[card.id] || "") : "";
					if (colorClass) {
						cardEl.addClass(colorClass);
					}

					const prevState = this.renderedCardState.get(cardEl);
					const titleEl = cardEl.querySelector(".fractal-card-title") as HTMLElement;
					if (titleEl && titleEl.textContent !== card.title) {
						titleEl.setText(card.title);
					}

					const isExpanded = this.isCardExpanded(card, level);
					const bodyEl = cardEl.querySelector(".fractal-card-body") as HTMLElement;
					const needsContentRender =
						!prevState ||
						prevState.expanded !== isExpanded ||
						prevState.content !== card.content;

					if (bodyEl && needsContentRender) {
						bodyEl.empty();
						if (isExpanded) {
							const cardComp = this.createCardComponent(cardEl);
							if (card.content && this.file) {
								await MarkdownRenderer.render(this.app, card.content, bodyEl, this.file.path, cardComp);
								postProcessRenderedMarkdown(bodyEl, this.app, this.file.path);
							}
							cardEl.addClass("was-expanded");
						} else {
							this.unloadCardComponent(cardEl);
							const previewText = getPlainPreview(card.content, 150);
							bodyEl.createEl("p", { text: previewText });
							cardEl.removeClass("was-expanded");
						}
					}

					const existingIndicator = cardEl.querySelector(".fractal-collapsed-indicator") as HTMLElement | null;
					if (card.children.length > 0) {
						if (!prevState || prevState.childCount !== card.children.length || !existingIndicator) {
							if (existingIndicator) existingIndicator.remove();
							const indicator = cardEl.createDiv({ cls: "fractal-collapsed-indicator" });
							const iconSpan = indicator.createEl("span", { cls: "fractal-indicator-icon" });
							setIcon(iconSpan, "git-branch");
							indicator.createEl("span", { text: ` ${card.children.length}` });
						}
					} else if (existingIndicator) {
						existingIndicator.remove();
					}

					this.renderedCardState.set(cardEl, {
						title: card.title,
						content: card.content,
						expanded: isExpanded,
						childCount: card.children.length
					});
				}
			} else {
				this.unloadComponentsInContainer(columnEl);
				columnEl.empty();
				columnEl.createDiv({ cls: "fractal-column-spacer" });
				this.setupColumnDragAndDrop(columnEl, level, parent);
				this.renderSiblingInsertContainer(columnEl, parent, 0, level);
				for (let i = 0; i < parent.children.length; i++) {
					if (gen !== this.renderGeneration) return;
					const card = parent.children[i];
					const activeId = this.activeKeysByLevel[level];
					const isActive = activeId === card.id && level <= (this.selectedLevel || 1);
					await this.renderCard(columnEl, card, level, isActive);
					this.renderSiblingInsertContainer(columnEl, parent, i + 1, level);
				}
			}
		}
	}

	toggleZenMode(btnZen: HTMLButtonElement) {
		const workspace = this.app.workspace as any;
		this.isZenMode = !this.isZenMode;
		
		if (this.isZenMode) {
			if (workspace.leftSplit) {
				this.savedLeftCollapsed = workspace.leftSplit.collapsed;
				workspace.leftSplit.collapse();
			}
			if (workspace.rightSplit) {
				this.savedRightCollapsed = workspace.rightSplit.collapsed;
				workspace.rightSplit.collapse();
			}
			btnZen.addClass("active");
			setIcon(btnZen, "shrink");
		} else {
			if (workspace.leftSplit && !this.savedLeftCollapsed) {
				workspace.leftSplit.expand();
			}
			if (workspace.rightSplit && !this.savedRightCollapsed) {
				workspace.rightSplit.expand();
			}
			btnZen.removeClass("active");
			setIcon(btnZen, "expand");
		}
	}

	updateZoomStyles(container: HTMLElement) {
		container.style.setProperty("--fractal-zoom", this.plugin.settings.zoom.toString());
		container.style.setProperty("--fractal-column-width", `${this.plugin.settings.columnWidth}px`);
		const inactiveHeight = this.plugin.settings.inactiveCardHeight || 300;
		if (inactiveHeight >= 300) {
			container.style.setProperty("--fractal-inactive-card-height", "auto");
		} else {
			const scaledHeight = inactiveHeight * this.plugin.settings.zoom;
			container.style.setProperty("--fractal-inactive-card-height", `${scaledHeight}px`);
		}
		container.style.setProperty("--fractal-text-size", `${this.plugin.settings.fontSize || 14}px`);
		container.style.setProperty("--fractal-grid-display", this.plugin.settings.showGrid ? "block" : "none");
		container.style.setProperty("--fractal-grid-opacity", (this.plugin.settings.gridOpacity !== undefined ? this.plugin.settings.gridOpacity : 0.03).toString());
		
		const useAuto = this.plugin.settings.autoCardSpacing !== false;
		const titleSize = useAuto ? 16 : (this.plugin.settings.titleFontSize || 16);
		const paddingY = useAuto ? 12 : (this.plugin.settings.cardPaddingY || 12);
		const paddingX = useAuto ? 14 : (this.plugin.settings.cardPaddingX || 14);
		const gap = useAuto ? 8 : (this.plugin.settings.cardGap || 8);

		container.style.setProperty("--fractal-title-size", `${titleSize}px`);
		container.style.setProperty("--fractal-card-padding-y", `${paddingY}px`);
		container.style.setProperty("--fractal-card-padding-x", `${paddingX}px`);
		container.style.setProperty("--fractal-card-gap", `${gap}px`);

		// Sync toolbar popover inputs if already rendered
		const zoomSlider = this.contentEl.querySelector(".fractal-toolbar-slider.zoom") as HTMLInputElement | null;
		const zoomInput = this.contentEl.querySelector(".zoom-input") as HTMLInputElement | null;
		if (zoomSlider) zoomSlider.value = this.plugin.settings.zoom.toString();
		if (zoomInput) zoomInput.value = Math.round(this.plugin.settings.zoom * 100).toString();

		const widthInput = this.contentEl.querySelector(".width-input") as HTMLInputElement | null;
		if (widthInput) {
			widthInput.value = this.plugin.settings.columnWidth.toString();
			const widthSlider = widthInput.previousElementSibling as HTMLInputElement | null;
			if (widthSlider && widthSlider.type === "range") {
				widthSlider.value = this.plugin.settings.columnWidth.toString();
			}
		}
	}

	applyThemeStyles() {
		const viewContent = this.contentEl;
		let mode = this.plugin.settings.themeMode || "obsidian-theme";
		// compatibility fallback
		if (mode === ("classic" as any) || mode === ("steel-blue" as any)) {
			mode = "obsidian-theme";
		}
		viewContent.setAttribute("data-theme", mode);

		const toolbar = this.contentEl.querySelector(".fractal-header-toolbar") as HTMLElement;

		if (mode === "obsidian-theme") {
			viewContent.style.removeProperty("--fractal-custom-canvas-bg");
			viewContent.style.removeProperty("--fractal-custom-active-bg");
			viewContent.style.removeProperty("--fractal-custom-inactive-bg");
			viewContent.style.removeProperty("--fractal-custom-active-text");
			viewContent.style.removeProperty("--fractal-custom-text-color");
			viewContent.style.removeProperty("--fractal-custom-title-color");
			viewContent.style.removeProperty("--fractal-custom-aura-color");
			if (toolbar) {
				toolbar.style.backgroundColor = "var(--background-secondary-alt)";
				toolbar.style.borderColor = "var(--background-modifier-border)";
			}
		} else if (mode === "custom") {
			viewContent.style.setProperty("--fractal-custom-canvas-bg", this.plugin.settings.canvasBgColor);
			viewContent.style.setProperty("--fractal-custom-active-bg", this.plugin.settings.activeCardColor);
			viewContent.style.setProperty("--fractal-custom-inactive-bg", this.plugin.settings.inactiveCardColor);
			viewContent.style.setProperty("--fractal-custom-text-color", this.plugin.settings.textColor || "#eef1f6");
			viewContent.style.setProperty("--fractal-custom-title-color", this.plugin.settings.customTitleColor || "#ebf8ff");
			viewContent.style.setProperty("--fractal-custom-aura-color", this.plugin.settings.auraColor || "#3a86c8");
			
			const contrastColor = getContrastColor(this.plugin.settings.activeCardColor);
			viewContent.style.setProperty("--fractal-custom-active-text", contrastColor);

			if (toolbar) {
				toolbar.style.backgroundColor = "var(--background-secondary-alt)";
				toolbar.style.borderColor = "var(--background-modifier-border)";
			}
		}
	}

	async renderMetadataPanel(panelEl: HTMLElement, gen?: number) {
		if (this.introRenderComponent) {
			this.removeChild(this.introRenderComponent);
			this.introRenderComponent.unload();
			this.introRenderComponent = null;
		}
		panelEl.empty();
		if (!this.showMetadataPanel) {
			panelEl.addClass("collapsed");
			return;
		}
		panelEl.removeClass("collapsed");

		// Left Column: YAML Properties
		const leftCol = panelEl.createDiv({ cls: "fractal-metadata-column" });
		if (this.editingYaml) {
			this.renderYamlEditor(leftCol);
		} else {
			this.renderYamlViewer(leftCol);
		}

		// Right Column: Introduction
		const rightCol = panelEl.createDiv({ cls: "fractal-metadata-column" });
		const introHeader = rightCol.createDiv({ cls: "fractal-metadata-title" });
		introHeader.createEl("span", { text: "Note introduction" });
		
		const editIntroBtn = introHeader.createEl("span", {
			text: this.editingRootContent ? "Save ✔" : "Edit 📝",
			cls: "fractal-column-collapse-btn",
			title: this.editingRootContent ? "Save changes" : "Edit introduction"
		});

		const bodyEl = rightCol.createDiv({ cls: "fractal-metadata-body" });

		if (this.editingRootContent) {
			const editorContainer = bodyEl.createDiv({
				cls: "lineage-inline-editor"
			});

			const stopProp = (e: Event) => e.stopPropagation();
			editorContainer.addEventListener("click", stopProp);
			editorContainer.addEventListener("mousedown", stopProp);
			editorContainer.addEventListener("dblclick", stopProp);

			try {
				this.cleanupActiveEditor();
				const inlineView = new MarkdownView({
					containerEl: editorContainer,
					app: this.app,
					workspace: this.app.workspace,
					history: {
						backHistory: [],
						forwardHistory: [],
					},
				} as never) as any;
				
				inlineView.save = async () => {};
				inlineView.requestSave = () => {};
				inlineView.__setViewData__ = inlineView.setViewData;
				inlineView.setViewData = async () => {};
				
				this.activeEditorInstance = inlineView;
				inlineView.__fractalReady = false;
				
				if (inlineView.getMode() === 'preview') {
					inlineView.setState({ mode: 'source' }, { history: false });
				}
				
				if (this.file) {
					const targetFile = this.file;
					inlineView.file = targetFile;
					inlineView.onUnloadFile(targetFile).then(() => {
						if (this.activeEditorInstance !== inlineView) return;
						inlineView.__setViewData__(this.root.content || "", true);
						inlineView.__fractalReady = true;
						inlineView.onLoadFile(targetFile);
					});
				} else {
					inlineView.__setViewData__(this.root.content || "", true);
					inlineView.__fractalReady = true;
				}
				
				editorContainer.addEventListener("focusin", () => {
					// @ts-expect-error -- undocumented Obsidian workspace property
					this.app.workspace._activeEditor = inlineView;
				});

				editorContainer.addEventListener("keydown", (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						
						let val = this.root.content || "";
						if (inlineView.__fractalReady) {
							try {
								val = inlineView.getViewData();
							} catch (err) {
								val = this.root.content || "";
							}
						}

						this.cleanupActiveEditor();
						if (this.root.content !== val) {
							this.pushHistory();
							this.root.content = val;
							this.requestSave();
						}
						this.editingRootContent = false;
						this.renderFractal();
					}
				}, true);

				editIntroBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					let val = this.root.content || "";
					if (inlineView.__fractalReady) {
						try {
							val = inlineView.getViewData();
						} catch (err) {
							val = this.root.content || "";
						}
					}

					this.cleanupActiveEditor();
					if (this.root.content !== val) {
						this.pushHistory();
						this.root.content = val;
					}
					this.editingRootContent = false;
					this.requestSave();
					this.renderFractal();
				});

			} catch (error) {
				console.error("Failed to initialize MarkdownView for intro editor:", error);
				// Fallback to textarea
				const textarea = editorContainer.createEl("textarea", {
					cls: "fractal-card-edit-body fractal-card-edit-body-raw"
				});
				textarea.value = this.root.content || "";
				textarea.addEventListener("keydown", (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						this.cleanupActiveEditor();
						if (this.root.content !== textarea.value) {
							this.pushHistory();
							this.root.content = textarea.value;
							this.requestSave();
						}
						this.editingRootContent = false;
						this.renderFractal();
					}
				});

				editIntroBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.cleanupActiveEditor();
					if (this.root.content !== textarea.value) {
						this.pushHistory();
						this.root.content = textarea.value;
					}
					this.editingRootContent = false;
					this.requestSave();
					this.renderFractal();
				});
			}
		} else {
			const introContentEl = bodyEl.createDiv({ cls: "fractal-root-content-body markdown-preview-view markdown-rendered" });
			if (this.root.content) {
				if (this.file) {
					const introComp = new Component();
					this.addChild(introComp);
					introComp.load();
					this.introRenderComponent = introComp;
					await MarkdownRenderer.render(this.app, this.root.content, introContentEl, this.file.path, introComp);
					if (gen !== undefined && gen !== this.renderGeneration) return;
					postProcessRenderedMarkdown(introContentEl, this.app, this.file.path);
					introContentEl.addEventListener("click", (e) => {
						const target = e.target as HTMLElement;
						const linkEl = target.closest("a.internal-link") as HTMLElement | null;
						if (linkEl) {
							e.stopPropagation();
							e.preventDefault();
							const dest = linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "";
							if (dest) {
								this.app.workspace.openLinkText(dest, this.file?.path || "", e.ctrlKey || e.metaKey);
							}
							return;
						}
						const imgTarget = target.closest("img, .internal-embed.image-embed, .internal-embed.media-embed") as HTMLElement | null;
						if (imgTarget) {
							const imgEl = (imgTarget.tagName === "IMG" ? imgTarget : imgTarget.querySelector("img")) as HTMLImageElement | null;
							const hasImageToolkit = Boolean((this.app as any).plugins?.enabledPlugins?.has("obsidian-image-toolkit"));
							if (imgEl && !hasImageToolkit) {
								new ImagePreviewModal(this.app, imgEl.src, imgEl.alt || "").open();
							}
						}
					});
				} else {
					introContentEl.createEl("p", { text: this.root.content });
				}
			} else {
				introContentEl.createEl("em", { text: "No introductory text. Double click here or press 'Edit' to add it." });
			}

			editIntroBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.editingRootContent = true;
				this.renderFractal();
			});

			introContentEl.addEventListener("dblclick", (e) => {
				e.stopPropagation();
				this.editingRootContent = true;
				this.renderFractal();
			});
		}
	}

	renderYamlViewer(parent: HTMLElement) {
		const yamlEl = parent.createDiv({ cls: "fractal-yaml-container" });
		const header = yamlEl.createDiv({ cls: "fractal-yaml-header" });
		header.createEl("span", { text: "Properties", cls: "fractal-yaml-header-title" });
		
		const editBtn = header.createEl("button", { 
			cls: "fractal-yaml-edit-btn",
			title: "Edit properties"
		});
		setIcon(editBtn, "pencil");
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.editingYaml = true;
			this.renderFractal();
		});

		let props: any = {};
		try {
			props = parseYaml(this.frontmatter);
		} catch (e) {
			props = parseYAML(this.frontmatter); // fallback
		}
		
		if (!props || Object.keys(props).length === 0) {
			yamlEl.createEl("em", { text: "No properties set.", cls: "fractal-yaml-empty" });
			return;
		}
		
		const table = yamlEl.createDiv({ cls: "fractal-yaml-table" });

		for (const [key, val] of Object.entries(props)) {
			const row = table.createDiv({ cls: "fractal-yaml-row" });
			
			// Icon and key container
			const keyContainer = row.createDiv({ cls: "fractal-yaml-key-container" });
			const iconEl = keyContainer.createSpan({ cls: "fractal-yaml-key-icon" });
			
			// Choose icon based on key name
			let iconName = "text";
			if (key.toLowerCase() === "tags" || key.toLowerCase() === "tag") {
				iconName = "tags";
			} else if (key.toLowerCase() === "date" || key.toLowerCase() === "created" || key.toLowerCase() === "updated") {
				iconName = "calendar";
			} else if (key.toLowerCase() === "aliases" || key.toLowerCase() === "alias") {
				iconName = "link-2";
			} else if (typeof val === "boolean") {
				iconName = "check-square";
			} else if (typeof val === "number") {
				iconName = "binary";
			}
			setIcon(iconEl, iconName);
			
			keyContainer.createEl("span", { cls: "fractal-yaml-key-text", text: key });
			
			const valueContainer = row.createDiv({ cls: "fractal-yaml-value-container" });
			
			if (key.toLowerCase() === "tags" || key.toLowerCase() === "tag") {
				const tags = Array.isArray(val) ? val : String(val).split(",").map(t => t.trim());
				const tagsWrapper = valueContainer.createDiv({ cls: "fractal-yaml-tags-wrapper" });
				tags.forEach(tag => {
					if (tag) {
						tagsWrapper.createEl("span", { cls: "fractal-yaml-tag-pill", text: tag });
					}
				});
			} else {
				let displayVal = "";
				if (Array.isArray(val)) {
					displayVal = val.join(", ");
				} else if (typeof val === "object" && val !== null) {
					displayVal = JSON.stringify(val);
				} else {
					displayVal = String(val);
				}
				valueContainer.createEl("span", { cls: "fractal-yaml-value-text", text: displayVal });
			}
		}
	}

	renderYamlEditor(parent: HTMLElement) {
		const yamlEl = parent.createDiv({ cls: "fractal-yaml-container" });
		const header = yamlEl.createDiv({ cls: "fractal-yaml-header" });
		header.createEl("span", { text: "Properties (YAML)", cls: "fractal-yaml-header-title" });

		const saveBtn = header.createEl("button", { 
			cls: "fractal-yaml-edit-btn",
			title: "Save and exit"
		});
		setIcon(saveBtn, "check");

		const editorContainer = yamlEl.createDiv({
			cls: "lineage-inline-editor fractal-yaml-native-editor"
		});

		const stopProp = (e: Event) => e.stopPropagation();
		editorContainer.addEventListener("click", stopProp);
		editorContainer.addEventListener("mousedown", stopProp);
		editorContainer.addEventListener("dblclick", stopProp);

		const rawYamlDoc = `---\n${this.frontmatter || ""}\n---`;

		try {
			this.cleanupActiveEditor();
			const inlineView = new MarkdownView({
				containerEl: editorContainer,
				app: this.app,
				workspace: this.app.workspace,
				history: {
					backHistory: [],
					forwardHistory: [],
				},
			} as never) as any;
			
			inlineView.save = async () => {};
			inlineView.requestSave = () => {};
			inlineView.__setViewData__ = inlineView.setViewData;
			inlineView.setViewData = async () => {};
			
			this.activeEditorInstance = inlineView;
			inlineView.__fractalReady = false;
			
			if (inlineView.getMode() === 'preview') {
				inlineView.setState({ mode: 'source' }, { history: false });
			}
			
			if (this.file) {
				const targetFile = this.file;
				inlineView.file = targetFile;
				inlineView.onUnloadFile(targetFile).then(() => {
					if (this.activeEditorInstance !== inlineView) return;
					inlineView.__setViewData__(rawYamlDoc, true);
					inlineView.__fractalReady = true;
					inlineView.onLoadFile(targetFile);
				});
			} else {
				inlineView.__setViewData__(rawYamlDoc, true);
				inlineView.__fractalReady = true;
			}

			editorContainer.addEventListener("focusin", () => {
				// @ts-expect-error -- undocumented Obsidian workspace property
				this.app.workspace._activeEditor = inlineView;
			});

			editorContainer.addEventListener("keydown", (e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					
					let val = rawYamlDoc;
					if (inlineView.__fractalReady) {
						try {
							val = inlineView.getViewData();
						} catch (err) {
							val = rawYamlDoc;
						}
					}

					const fmMatch = val.match(/^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/);
					if (fmMatch) {
						const newFrontmatter = fmMatch[1];
						if (this.frontmatter !== newFrontmatter) {
							this.pushHistory();
							this.frontmatter = newFrontmatter;
							this.requestSave();
						}
					}
					this.cleanupActiveEditor();
					this.editingYaml = false;
					this.renderFractal();
				}
			}, true);

			saveBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				let val = rawYamlDoc;
				if (inlineView.__fractalReady) {
					try {
						val = inlineView.getViewData();
					} catch (err) {
						val = rawYamlDoc;
					}
				}

				const fmMatch = val.match(/^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/);
				if (fmMatch) {
					const newFrontmatter = fmMatch[1];
					if (this.frontmatter !== newFrontmatter) {
						this.pushHistory();
						this.frontmatter = newFrontmatter;
					}
				}
				this.cleanupActiveEditor();
				this.editingYaml = false;
				this.requestSave();
				this.renderFractal();
			});

		} catch (error) {
			console.error("Failed to initialize MarkdownView for properties editor:", error);
			const textarea = editorContainer.createEl("textarea", {
				cls: "fractal-card-edit-body fractal-card-edit-body-raw"
			});
			textarea.value = this.frontmatter || "";
			textarea.style.minHeight = "120px";

			textarea.addEventListener("keydown", (e) => {
				e.stopPropagation();
			});

			saveBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (this.frontmatter !== textarea.value) {
					this.pushHistory();
					this.frontmatter = textarea.value;
				}
				this.cleanupActiveEditor();
				this.editingYaml = false;
				this.requestSave();
				this.renderFractal();
			});
		}
	}

	isColumnCollapsed(level: number): boolean {
		if (!this.file) return false;
		return this.plugin.settings.collapsedColumns[this.file.path]?.[level] || false;
	}

	toggleColumnCollapsed(level: number) {
		if (!this.file) return;
		const path = this.file.path;
		if (!this.plugin.settings.collapsedColumns[path]) {
			this.plugin.settings.collapsedColumns[path] = {};
		}
		const current = this.plugin.settings.collapsedColumns[path][level] || false;
		this.plugin.settings.collapsedColumns[path][level] = !current;
		this.plugin.saveSettings();
		this.renderFractal();
	}

	triggerAutoSaveAndExit(card: FractalCard, titleInput: HTMLInputElement, editorEl: HTMLElement) {
		const newTitle = titleInput.value.trim() || "Untitled";
		let newContent = "";
		if (this.activeEditorInstance) {
			if (this.activeEditorInstance.__fractalReady) {
				try {
					newContent = this.activeEditorInstance.getViewData();
				} catch (err) {
					console.error("Fractal: Failed to get view data", err);
					newContent = card.content || "";
				}
			} else {
				newContent = card.content || "";
			}
		} else {
			const textarea = editorEl.querySelector("textarea, .fractal-card-edit-body, .fractal-card-edit-body-raw") as HTMLTextAreaElement;
			if (textarea) newContent = textarea.value;
		}

		this.cleanupActiveEditor();
		this.editingCardId = null;
		this.originalCardTitle = null;
		this.originalCardContent = null;

		if (newTitle === "New card" && newContent === "" && card.children.length === 0) {
			this.deleteCard(card);
			return;
		}

		if (card.title !== newTitle || card.content !== newContent) {
			this.pushHistory();
			const oldIdMap = this.captureCardIdMap();
			card.title = newTitle;
			card.content = newContent;

			assignStableKeys(this.root);
			this.migrateTreeSettings(oldIdMap);
			this.updateActivePathToCard(card);
			this.requestSave();
		}
		this.renderFractal();
	}

	// Render Generic Card
	async renderCard(parent: HTMLElement, card: FractalCard, level: number, isActive: boolean) {
		const colorClass = this.file ? (this.plugin.settings.cardColors[this.file.path]?.[card.id] || "") : "";
		
		// Determine illuminated and expanded path status
		const isIlluminated = this.isCardIlluminated(card, level);
		const isExpanded = this.isCardExpanded(card, level);
		
		let cls = "fractal-card";
		if (isActive && level === this.selectedLevel) {
			cls += " active";
		} else if (isIlluminated) {
			cls += " illuminated";
		}
		if (colorClass) cls += ` ${colorClass}`;

		const cardEl = parent.createDiv({ cls, attr: { "data-id": card.id } });

		if (this.editingCardId === card.id) {
			// Edit mode
			const titleInput = cardEl.createEl("input", {
				type: "text",
				cls: "fractal-card-edit-title"
			});
			titleInput.value = card.title;

			const editorContainer = cardEl.createDiv({
				cls: "lineage-inline-editor"
			});

			// Prevent bubbling of clicks/mouse events to cardEl
			const stopProp = (e: Event) => e.stopPropagation();
			titleInput.addEventListener("click", stopProp);
			titleInput.addEventListener("mousedown", stopProp);
			titleInput.addEventListener("dblclick", stopProp);
			editorContainer.addEventListener("click", stopProp);
			editorContainer.addEventListener("mousedown", stopProp);
			editorContainer.addEventListener("dblclick", stopProp);

			try {
				this.cleanupActiveEditor();
				// Use MarkdownView directly without calling load()
				const inlineView = new MarkdownView({
					containerEl: editorContainer,
					app: this.app,
					workspace: this.app.workspace,
					history: {
						backHistory: [],
						forwardHistory: [],
					},
				} as never) as any;
				
				inlineView.save = async () => {};
				inlineView.requestSave = () => {};
				inlineView.__setViewData__ = inlineView.setViewData;
				inlineView.setViewData = async () => {};
				
				this.activeEditorInstance = inlineView;
				inlineView.__fractalReady = false;
				
				if (inlineView.getMode() === 'preview') {
					inlineView.setState({ mode: 'source' }, { history: false });
				}
				
				// Set file and content
				if (this.file) {
					const targetFile = this.file;
					inlineView.file = targetFile;
					inlineView.onUnloadFile(targetFile).then(() => {
						if (this.activeEditorInstance !== inlineView) return;
						inlineView.__setViewData__(card.content || "", true);
						inlineView.__fractalReady = true;
						inlineView.onLoadFile(targetFile);
					});
				} else {
					inlineView.__setViewData__(card.content || "", true);
					inlineView.__fractalReady = true;
				}
				
				editorContainer.addEventListener("focusin", () => {
					// @ts-expect-error -- undocumented Obsidian workspace property
					this.app.workspace._activeEditor = inlineView;
				});
				
				requestAnimationFrame(() => {
					titleInput.focus();
					if (card.title === "New card") {
						titleInput.select();
					}
				});
				
				editorContainer.addEventListener("keydown", (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						this.triggerAutoSaveAndExit(card, titleInput, editorContainer);
						return;
					}
				}, true);
				
			} catch (error) {
				console.warn("Fractal: Inline MarkdownView unavailable, using plain textarea fallback:", error);
				const editorEl = editorContainer.createEl("textarea", {
					cls: "fractal-card-edit-body fractal-card-edit-body-raw"
				});
				editorEl.value = card.content || "";
				editorEl.addEventListener("keydown", (e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						this.triggerAutoSaveAndExit(card, titleInput, editorContainer);
					}
				});
			}
			
			// Always default to focusing the title first
			requestAnimationFrame(() => {
				titleInput.focus();
				if (card.title === "New card") {
					titleInput.select();
				}
			});

			titleInput.addEventListener("keydown", (e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					this.triggerAutoSaveAndExit(card, titleInput, editorContainer);
					return;
				}
				if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
					e.preventDefault();
					if (this.activeEditorInstance && this.activeEditorInstance.editor) {
						this.activeEditorInstance.editor.focus();
						const lastLine = this.activeEditorInstance.editor.lastLine();
						const ch = this.activeEditorInstance.editor.getLine(lastLine).length;
						this.activeEditorInstance.editor.setCursor({ line: lastLine, ch });
					} else {
						const rawEditor = editorContainer.querySelector(".fractal-card-edit-body-raw") as HTMLElement;
						if (rawEditor) rawEditor.focus();
					}
					return;
				}
				e.stopPropagation();
			});

			// Minimal View Note Icon Button
			const actionsContainer = cardEl.createDiv({ cls: "fractal-card-edit-actions" });
			const viewNoteBtn = actionsContainer.createEl("button", {
				cls: "fractal-btn view-note-btn",
				title: "View note in Obsidian"
			});
			setIcon(viewNoteBtn, "external-link");
			viewNoteBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				e.preventDefault();
				this.triggerAutoSaveAndExit(card, titleInput, editorContainer);
				await this.plugin.toggleFractalView();
			});

			const handleBlur = (evt: FocusEvent) => {
				if (this.editBlurTimeout) {
					clearTimeout(this.editBlurTimeout);
				}
				this.editBlurTimeout = window.setTimeout(() => {
					const activeEl = document.activeElement;
					if (!activeEl || !cardEl.contains(activeEl)) {
						if (this.editingCardId !== card.id) return;
						this.triggerAutoSaveAndExit(card, titleInput, editorContainer);
					}
				}, 150);
			};

			titleInput.addEventListener("blur", handleBlur);
			editorContainer.addEventListener("blur", handleBlur, true);
		} else {
			// Display mode
			cardEl.createEl("div", { cls: "fractal-card-title", text: card.title });

			const bodyEl = cardEl.createDiv({ cls: "fractal-card-body markdown-preview-view markdown-rendered" });
			
			// Only render rich markdown if the card is expanded (active card or ancestor).
			// Otherwise render a clean, truncated plain text preview.
			if (isExpanded) {
				const cardComp = this.createCardComponent(cardEl);
				if (card.content && this.file) {
					await MarkdownRenderer.render(this.app, card.content, bodyEl, this.file.path, cardComp);
					postProcessRenderedMarkdown(bodyEl, this.app, this.file.path);
				}
				cardEl.addClass("was-expanded");
			} else {
				const previewText = getPlainPreview(card.content, 150);
				bodyEl.createEl("p", { text: previewText });
			}

			// Sub-card indicator: show children count with a horizontal tree icon (git-branch)
			if (card.children.length > 0) {
				const indicator = cardEl.createDiv({ 
					cls: "fractal-collapsed-indicator"
				});
				const iconSpan = indicator.createEl("span", { cls: "fractal-indicator-icon" });
				setIcon(iconSpan, "git-branch");
				indicator.createEl("span", { text: ` ${card.children.length}` });
			}

			this.renderedCardState.set(cardEl, {
				title: card.title,
				content: card.content,
				expanded: isExpanded,
				childCount: card.children.length
			});

			// Add Child Button on the right of the card
			if (level < 6) {
				const addChildBtn = cardEl.createDiv({ 
					cls: "fractal-card-add-child-btn", 
					title: "Add sub-card (child)" 
				});
				// No text inside the button to keep it clean and narrow
				addChildBtn.addEventListener("click", (evt) => {
					evt.stopPropagation();
					this.insertCard(card, card.children.length, level + 1);
				});
			}

			// Setup HTML5 Drag and Drop on the card
			cardEl.setAttribute("draggable", "true");
			
			cardEl.addEventListener("dragstart", (e) => {
				if (this.editingCardId) {
					e.preventDefault();
					return;
				}
				e.dataTransfer?.setData("text/plain", card.id);
				cardEl.addClass("dragging");
			});

			cardEl.addEventListener("dragend", () => {
				cardEl.removeClass("dragging");
				this.contentEl.querySelectorAll(".fractal-card").forEach(el => {
					el.removeClass("drag-over-top");
					el.removeClass("drag-over-bottom");
					el.removeClass("drag-over-middle");
				});
			});

			cardEl.addEventListener("dragover", (e) => {
				if (cardEl.classList.contains("dragging")) return;

				// Prevent cyclic drops using DOM check for dragging element
				const draggingEl = this.contentEl.querySelector(".fractal-card.dragging");
				const draggedId = draggingEl ? draggingEl.getAttribute("data-id") : null;
				if (draggedId) {
					if (card.id === draggedId || card.id.startsWith(draggedId + " > ")) {
						return;
					}
				}

				e.preventDefault();
				const rect = cardEl.getBoundingClientRect();
				const relativeY = e.clientY - rect.top;

				// Allow dropping inside as child if target card is not at max level (level < 6)
				const canAcceptChild = level < 6;

				if (canAcceptChild) {
					const threshold = rect.height * 0.25;
					if (relativeY < threshold) {
						cardEl.addClass("drag-over-top");
						cardEl.removeClass("drag-over-bottom");
						cardEl.removeClass("drag-over-middle");
					} else if (relativeY > rect.height - threshold) {
						cardEl.addClass("drag-over-bottom");
						cardEl.removeClass("drag-over-top");
						cardEl.removeClass("drag-over-middle");
					} else {
						cardEl.addClass("drag-over-middle");
						cardEl.removeClass("drag-over-top");
						cardEl.removeClass("drag-over-bottom");
					}
				} else {
					if (relativeY < rect.height / 2) {
						cardEl.addClass("drag-over-top");
						cardEl.removeClass("drag-over-bottom");
					} else {
						cardEl.addClass("drag-over-bottom");
						cardEl.removeClass("drag-over-top");
					}
				}
			});

			cardEl.addEventListener("dragleave", () => {
				cardEl.removeClass("drag-over-top");
				cardEl.removeClass("drag-over-bottom");
				cardEl.removeClass("drag-over-middle");
			});

			cardEl.addEventListener("drop", (e) => {
				e.preventDefault();
				cardEl.removeClass("drag-over-top");
				cardEl.removeClass("drag-over-bottom");
				cardEl.removeClass("drag-over-middle");
				const draggedId = e.dataTransfer?.getData("text/plain");
				if (!draggedId || draggedId === card.id) return;

				const rect = cardEl.getBoundingClientRect();
				const relativeY = e.clientY - rect.top;

				const canAcceptChild = level < 6;
				if (canAcceptChild) {
					const threshold = rect.height * 0.25;
					if (relativeY >= threshold && relativeY <= rect.height - threshold) {
						this.handleCardDropToColumn(draggedId, level + 1, card);
						return;
					}
				}

				const placeBefore = relativeY < rect.height / 2;
				this.handleCardDrop(draggedId, card.id, placeBefore);
			});

			// Click Selection Handler
			cardEl.addEventListener("click", (e) => {
				const target = e.target as HTMLElement;
				const linkEl = target.closest("a.internal-link") as HTMLElement;
				if (linkEl) {
					e.stopPropagation();
					e.preventDefault();
					const dest = linkEl.getAttribute("data-href") || linkEl.getAttribute("href") || "";
					if (dest) {
						this.app.workspace.openLinkText(dest, this.file?.path || "", e.ctrlKey || e.metaKey);
					}
					return;
				}
				
				if (target.closest("a.external-link")) {
					return;
				}

				const imgTarget = target.closest("img, .internal-embed.image-embed, .internal-embed.media-embed") as HTMLElement | null;
				if (imgTarget) {
					if (cardEl.hasClass("was-expanded")) {
						const imgEl = (imgTarget.tagName === "IMG" ? imgTarget : imgTarget.querySelector("img")) as HTMLImageElement | null;
						const hasImageToolkit = Boolean((this.app as any).plugins?.enabledPlugins?.has("obsidian-image-toolkit"));
						if (imgEl && !hasImageToolkit) {
							new ImagePreviewModal(this.app, imgEl.src, imgEl.alt || "").open();
						}
						return;
					}
				}

				e.stopPropagation();

				if (this.cardClickTimeout) {
					window.clearTimeout(this.cardClickTimeout);
					this.cardClickTimeout = null;
				}

				if (this.activeKeysByLevel[level] === card.id && this.selectedLevel === level) {
					return;
				}

				this.cardClickTimeout = window.setTimeout(() => {
					if (this.editingCardId && this.editingCardId !== card.id) {
						this.saveActiveEdit();
					}
					this.cardClickTimeout = null;
					this.selectCard(card, level);
				}, 200);
			});

			// Double-click edit handler (using capture: true to intercept children events)
			cardEl.addEventListener("dblclick", (e) => {
				const target = e.target as HTMLElement;
				if (target.closest("a.internal-link, a.external-link, img, .internal-embed.image-embed, .internal-embed.media-embed, video, audio")) {
					return;
				}
				e.stopPropagation();
				if (this.cardClickTimeout) {
					window.clearTimeout(this.cardClickTimeout);
					this.cardClickTimeout = null;
				}
				window.getSelection()?.removeAllRanges();
				if (this.editingCardId && this.editingCardId !== card.id) {
					this.saveActiveEdit();
				}
				this.startEditingCard(card);
			}, true);

			// Right-click context menu handler
			cardEl.addEventListener("contextmenu", (e) => {
				e.stopPropagation();
				e.preventDefault();

				const menu = new Menu();
				
				menu.addItem((item) => 
					item.setTitle("Edit card 📝")
						.onClick(() => {
							this.startEditingCard(card);
						})
				);

				const isNodeColl = this.file ? (this.plugin.settings.collapsedNodes[this.file.path]?.[card.id] || false) : false;
				if (card.children.length > 0) {
					menu.addItem((item) => 
						item.setTitle(isNodeColl ? "Show branch 👁" : "Hide branch 🙈")
							.onClick(() => this.toggleCardCollapsed(card))
					);
				}

				menu.addItem((item) => 
					item.setTitle("Add card above")
						.onClick(() => {
							const info = this.findParent(this.root, card.id);
							if (info) this.insertCard(info.parent, info.index, level);
						})
				);

				menu.addItem((item) => 
					item.setTitle("Add card below")
						.onClick(() => {
							const info = this.findParent(this.root, card.id);
							if (info) this.insertCard(info.parent, info.index + 1, level);
						})
				);

				if (level < 6) {
					menu.addItem((item) => 
						item.setTitle("Add sub-card (child)")
							.onClick(() => {
								this.insertCard(card, card.children.length, level + 1);
							})
					);
				}

				menu.addSeparator();

				// Color Picker Submenu
				menu.addItem((item) => {
					item.setTitle("Set color");
					const submenu = (item as any).setSubmenu ? (item as any).setSubmenu() : new Menu();
					
					submenu.addItem((sub: any) => sub.setTitle("Clear color").onClick(() => this.setCardColor(card.id, "")));
					submenu.addItem((sub: any) => sub.setTitle("Teal 🟢").onClick(() => this.setCardColor(card.id, "fractal-color-teal")));
					submenu.addItem((sub: any) => sub.setTitle("Blue 🔵").onClick(() => this.setCardColor(card.id, "fractal-color-blue")));
					submenu.addItem((sub: any) => sub.setTitle("Yellow 🟡").onClick(() => this.setCardColor(card.id, "fractal-color-yellow")));
					submenu.addItem((sub: any) => sub.setTitle("Orange 🟠").onClick(() => this.setCardColor(card.id, "fractal-color-orange")));
					submenu.addItem((sub: any) => sub.setTitle("Crimson 🔴").onClick(() => this.setCardColor(card.id, "fractal-color-crimson")));
					submenu.addItem((sub: any) => sub.setTitle("Purple 🟣").onClick(() => this.setCardColor(card.id, "fractal-color-purple")));
					submenu.addItem((sub: any) => sub.setTitle("Magenta 🌺").onClick(() => this.setCardColor(card.id, "fractal-color-magenta")));
					submenu.addItem((sub: any) => sub.setTitle("Grey ⚪").onClick(() => this.setCardColor(card.id, "fractal-color-grey")));
					
					if (!(item as any).setSubmenu) {
						item.onClick((evt: any) => submenu.showAtMouseEvent(evt));
					}
				});

				menu.addSeparator();

				menu.addItem((item) => 
					item.setTitle("Delete card 🗑")
						.setWarning(true)
						.onClick(() => {
							new ConfirmModal(this.app, {
								title: "Delete card",
								message: `Are you sure you want to delete "${card.title}" and all its descendants?`,
								confirmText: "Delete",
								isWarning: true,
								onConfirm: () => this.deleteCard(card)
							}).open();
						})
				);

				menu.showAtMouseEvent(e);
			});
		}
	}

	setupColumnDragAndDrop(listEl: HTMLElement, level: number, parentCard: FractalCard) {
		listEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			const target = e.target as HTMLElement;
			if (!target.closest(".fractal-card")) {
				listEl.addClass("drag-over-list");
			} else {
				listEl.removeClass("drag-over-list");
			}
		});

		listEl.addEventListener("dragleave", () => {
			listEl.removeClass("drag-over-list");
		});

		listEl.addEventListener("drop", (e) => {
			e.preventDefault();
			listEl.removeClass("drag-over-list");
			const draggedId = e.dataTransfer?.getData("text/plain");
			if (!draggedId) return;

			const target = e.target as HTMLElement;
			if (target.closest(".fractal-card")) return;

			this.handleCardDropToColumn(draggedId, level, parentCard);
		});
	}

	handleCardDrop(draggedId: string, targetId: string, placeBefore: boolean) {
		const draggedInfo = this.findParent(this.root, draggedId);
		if (!draggedInfo) return;

		const targetInfo = this.findParent(this.root, targetId);
		if (!targetInfo) return;

		// Prevent dropping a card into itself or its own descendants
		if (targetId === draggedId || targetId.startsWith(draggedId + " > ")) {
			new Notice("Cannot drag a card inside itself or its own descendants");
			return;
		}

		this.pushHistory();
		const oldIdMap = this.captureCardIdMap();

		const draggedCard = draggedInfo.parent.children[draggedInfo.index];

		// Remove from old parent
		draggedInfo.parent.children.splice(draggedInfo.index, 1);

		// Re-find target parent index after removal
		const freshTargetInfo = this.findParent(this.root, targetId);
		if (!freshTargetInfo) {
			draggedInfo.parent.children.splice(draggedInfo.index, 0, draggedCard);
			return;
		}

		const insertIdx = placeBefore ? freshTargetInfo.index : freshTargetInfo.index + 1;
		freshTargetInfo.parent.children.splice(insertIdx, 0, draggedCard);

		const targetHeadingLevel = Math.min(Math.max(freshTargetInfo.parent.headingLevel + 1, 1), 6);
		this.adjustHeadingLevel(draggedCard, targetHeadingLevel);

		assignStableKeys(this.root);
		this.migrateTreeSettings(oldIdMap);

		const droppedVisualLevel = this.getCardDepth(freshTargetInfo.parent.id) + 1;
		this.activeKeysByLevel[droppedVisualLevel] = draggedCard.id;
		
		for (let i = droppedVisualLevel + 1; i <= 6; i++) {
			delete this.activeKeysByLevel[i];
		}
		this.selectedLevel = droppedVisualLevel;

		this.ensureSelectionPath();
		this.requestSave();
		this.renderFractal();
	}

	handleCardDropToColumn(draggedId: string, targetLevel: number, targetParent: FractalCard) {
		const draggedInfo = this.findParent(this.root, draggedId);
		if (!draggedInfo) return;

		// Prevent dragging parent to its own child column
		if (targetParent.id === draggedId || targetParent.id.startsWith(draggedId + " > ")) {
			new Notice("Cannot drag a card inside itself or its own descendants");
			return;
		}

		this.pushHistory();
		const oldIdMap = this.captureCardIdMap();

		const draggedCard = draggedInfo.parent.children[draggedInfo.index];

		// Remove from old parent
		draggedInfo.parent.children.splice(draggedInfo.index, 1);

		// Append to new parent
		targetParent.children.push(draggedCard);

		const targetHeadingLevel = Math.min(Math.max(targetParent.headingLevel + 1, 1), 6);
		this.adjustHeadingLevel(draggedCard, targetHeadingLevel);

		assignStableKeys(this.root);
		this.migrateTreeSettings(oldIdMap);
		this.activeKeysByLevel[targetLevel] = draggedCard.id;

		for (let i = targetLevel + 1; i <= 6; i++) {
			delete this.activeKeysByLevel[i];
		}
		this.selectedLevel = targetLevel;

		this.ensureSelectionPath();
		this.requestSave();
		this.renderFractal();
	}

	startEditingCard(card: FractalCard) {
		this.editingCardId = card.id;
		this.originalCardTitle = card.title;
		this.originalCardContent = card.content;
		this.renderFractal();
	}

	// A card is "illuminated" (white background) if it is part of the active path.
	// Since we only render children for active cards (Gingko-style), all visible cards
	// that are in the active path get the white highlighting.
	isCardIlluminated(card: FractalCard, level: number): boolean {
		if (level > (this.selectedLevel || 1)) return false;
		return this.activeKeysByLevel[level] === card.id;
	}

	// A card shows full rendered markdown if it is part of the active path.
	// All illuminated/active cards get rich rendering; siblings show truncated preview.
	isCardExpanded(card: FractalCard, level: number): boolean {
		const active = level <= (this.selectedLevel || 1) && this.activeKeysByLevel[level] === card.id;
		if (active) {
			this.expandedCardIds.add(card.id);
			return true;
		}
		if (this.plugin.settings.sectionBehavior === "keep" && this.expandedCardIds.has(card.id)) {
			return true;
		}
		return false;
	}

	toggleCardCollapsed(card: FractalCard) {
		if (!this.file) return;
		const path = this.file.path;
		if (!this.plugin.settings.collapsedNodes[path]) {
			this.plugin.settings.collapsedNodes[path] = {};
		}
		const current = this.plugin.settings.collapsedNodes[path][card.id] || false;
		this.plugin.settings.collapsedNodes[path][card.id] = !current;
		this.plugin.saveSettings();
		this.renderFractal();
	}

	setCardColor(cardId: string, cssClass: string) {
		if (!this.file) return;
		const path = this.file.path;
		if (!this.plugin.settings.cardColors[path]) {
			this.plugin.settings.cardColors[path] = {};
		}
		this.plugin.settings.cardColors[path][cardId] = cssClass;
		this.plugin.saveSettings();
		this.renderFractal();
	}

	migrateNodeSettings(oldId: string, newId: string) {
		if (!this.file) return;
		const path = this.file.path;
		
		if (this.plugin.settings.cardColors[path]?.[oldId]) {
			this.plugin.settings.cardColors[path][newId] = this.plugin.settings.cardColors[path][oldId];
			delete this.plugin.settings.cardColors[path][oldId];
		}
		if (this.plugin.settings.collapsedNodes[path]?.[oldId]) {
			this.plugin.settings.collapsedNodes[path][newId] = this.plugin.settings.collapsedNodes[path][oldId];
			delete this.plugin.settings.collapsedNodes[path][oldId];
		}
		this.plugin.saveSettings();
	}

	renderSiblingInsertContainer(parent: HTMLElement, parentCard: FractalCard, index: number, level: number, isInitialColEmpty = false) {
		const container = parent.createDiv({ 
			cls: `fractal-add-sibling-btn-container ${isInitialColEmpty ? "always-visible" : ""}` 
		});
		const btn = container.createDiv({ 
			cls: "fractal-add-sibling-btn", 
			title: isInitialColEmpty ? "Add first card" : "Add card here" 
		});
		if (isInitialColEmpty) {
			btn.setText("+");
		}
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.insertCard(parentCard, index, level);
		});
	}

	insertCard(parentCard: FractalCard, index: number, level: number) {
		this.saveActiveEdit();

		// Find the active parentCard in the current root to avoid stale object references
		let activeParent = parentCard;
		if (parentCard.headingLevel === 0) {
			activeParent = this.root;
		} else {
			const found = this.findCardById(this.root, parentCard.id);
			if (found) {
				activeParent = found;
			}
		}

		// Use the active parent's children length if we were appending a child
		let targetIndex = index;
		if (index === parentCard.children.length) {
			targetIndex = activeParent.children.length;
		}

		if (this.activeKeysByLevel[level]) {
			this.previousSelectionByLevel[level] = this.activeKeysByLevel[level];
		} else {
			delete this.previousSelectionByLevel[level];
		}
		this.pushHistory();
		const newCard: FractalCard = {
			id: `temp-${Date.now()}`,
			headingLevel: Math.min(Math.max(activeParent.headingLevel + 1, 1), 6),
			title: "New card",
			content: "",
			children: []
		};

		// Resolve path of activeParent from root to ensure it and all ancestors are selected/active
		const path: FractalCard[] = [];
		const findPath = (current: FractalCard, targetId: string): boolean => {
			if (current.id === targetId) {
				path.push(current);
				return true;
			}
			for (const child of current.children) {
				if (findPath(child, targetId)) {
					path.push(current);
					return true;
				}
			}
			return false;
		};
		findPath(this.root, activeParent.id);
		path.reverse();
		path.forEach((c, idx) => {
			this.activeKeysByLevel[idx] = c.id;
		});

		if (activeParent.headingLevel === 0 && level === 1) {
			this.root.children.splice(targetIndex, 0, newCard);
		} else {
			activeParent.children.splice(targetIndex, 0, newCard);
		}

		assignStableKeys(this.root);
		this.activeKeysByLevel[level] = newCard.id;
		
		for (let i = level + 1; i <= 6; i++) {
			delete this.activeKeysByLevel[i];
		}

		this.editingCardId = newCard.id;
		this.selectedLevel = level;

		this.requestSave();
		this.renderFractal();
	}

	deleteCard(card: FractalCard) {
		this.saveActiveEdit();
		const info = this.findParent(this.root, card.id);
		if (info) {
			this.pushHistory();
			const cardDepth = this.getCardDepth(card.id);
			const { parent, index } = info;
			parent.children.splice(index, 1);
			
			if (parent.children.length > 0) {
				let nextId = parent.children[Math.max(0, index - 1)].id;
				const prevId = this.previousSelectionByLevel[cardDepth];
				if (prevId) {
					const prevExists = parent.children.find(c => c.id === prevId);
					if (prevExists) {
						nextId = prevExists.id;
					}
				}
				this.activeKeysByLevel[cardDepth] = nextId;
			} else {
				delete this.activeKeysByLevel[cardDepth];
				if (this.selectedLevel >= cardDepth) {
					this.selectedLevel = cardDepth - 1;
				}
			}
			delete this.previousSelectionByLevel[cardDepth];

			assignStableKeys(this.root);
			this.ensureSelectionPath();
			this.requestSave();
			this.renderFractal();
		}
	}

	adjustHeadingLevel(card: FractalCard, newLevel: number) {
		const diff = newLevel - card.headingLevel;
		const recursiveAdjust = (c: FractalCard) => {
			c.headingLevel = Math.min(Math.max(c.headingLevel + diff, 1), 6);
			c.children.forEach(recursiveAdjust);
		};
		recursiveAdjust(card);
	}

	getCardDepth(cardId: string): number {
		if (cardId === "root") return 0;
		const path: FractalCard[] = [];
		const findPath = (current: FractalCard, targetId: string): boolean => {
			if (current.id === targetId) {
				path.push(current);
				return true;
			}
			for (const child of current.children) {
				if (findPath(child, targetId)) {
					path.push(current);
					return true;
				}
			}
			return false;
		};
		findPath(this.root, cardId);
		return Math.max(0, path.length - 1);
	}

	findCardById(current: FractalCard, targetId: string): FractalCard | null {
		if (current.id === targetId) return current;
		for (const child of current.children) {
			const found = this.findCardById(child, targetId);
			if (found) return found;
		}
		return null;
	}

	findParent(current: FractalCard, targetId: string): { parent: FractalCard, index: number } | null {
		for (let i = 0; i < current.children.length; i++) {
			if (current.children[i].id === targetId) {
				return { parent: current, index: i };
			}
			const result = this.findParent(current.children[i], targetId);
			if (result) return result;
		}
		return null;
	}

	handleKeyDown(e: KeyboardEvent) {
		// 1. Check if this view is the active leaf view
		if (this.app.workspace.getMostRecentLeaf()?.view !== this) return;

		// 2. Ignore shortcut triggers when actively editing card, yaml, or intro fields
		if (this.editingCardId !== null || this.editingYaml || this.editingRootContent) {
			return; // Let the browser/CodeMirror handle standard editor hotkeys natively (Undo/Redo, Copy/Paste)
		}

		// Also check if focus is currently inside any input/textarea/contenteditable
		const target = e.target as HTMLElement;
		if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
			return;
		}

		// Global Undo/Redo shortcuts when not editing card text
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
			e.preventDefault();
			e.stopPropagation();
			if (e.shiftKey) {
				this.redo();
			} else {
				this.undo();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "y") {
			e.preventDefault();
			e.stopPropagation();
			this.redo();
			return;
		}

		// Use selectedLevel (the level the user last interacted with)
		const level = this.selectedLevel || 1;
		const activeId = this.activeKeysByLevel[level];
		if (!activeId) return;

		let currentParent = this.root;
		if (level > 1) {
			const pInfo = this.findParent(this.root, activeId);
			if (pInfo) currentParent = pInfo.parent;
		}

		const currentIdx = currentParent.children.findIndex(c => c.id === activeId);
		if (currentIdx === -1) return;

		const card = currentParent.children[currentIdx];

		// Copy Card & Subtree
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
			e.preventDefault();
			e.stopPropagation();
			(this.plugin as any).copiedCard = JSON.parse(JSON.stringify(card));
			new Notice(`Card "${card.title}" copied`);
			return;
		}

		// Cut Card & Subtree
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
			e.preventDefault();
			e.stopPropagation();
			(this.plugin as any).copiedCard = JSON.parse(JSON.stringify(card));
			new Notice(`Card "${card.title}" cut`);
			this.deleteCard(card);
			return;
		}

		// Paste Card (as Sibling or as Child)
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
			e.preventDefault();
			e.stopPropagation();
			const copied = (this.plugin as any).copiedCard;
			if (!copied) {
				new Notice("No card in clipboard to paste");
				return;
			}
			
			this.pushHistory();
			const pastedCard = JSON.parse(JSON.stringify(copied));

			if (e.shiftKey) {
				// Paste as child of selected card
				card.children.push(pastedCard);
				const targetHeadingLevel = Math.min(Math.max(card.headingLevel + 1, 1), 6);
				this.adjustHeadingLevel(pastedCard, targetHeadingLevel);
				assignStableKeys(this.root);

				const pastedVisualLevel = this.getCardDepth(card.id) + 1;
				this.activeKeysByLevel[pastedVisualLevel] = pastedCard.id;
				for (let i = pastedVisualLevel + 1; i <= 6; i++) {
					delete this.activeKeysByLevel[i];
				}
				this.selectedLevel = pastedVisualLevel;
				new Notice(`Card "${pastedCard.title}" pasted as child`);
			} else {
				// Paste as sibling below selected card
				currentParent.children.splice(currentIdx + 1, 0, pastedCard);
				const targetHeadingLevel = Math.min(Math.max(currentParent.headingLevel + 1, 1), 6);
				this.adjustHeadingLevel(pastedCard, targetHeadingLevel);
				assignStableKeys(this.root);

				const pastedVisualLevel = this.getCardDepth(card.id);
				this.activeKeysByLevel[pastedVisualLevel] = pastedCard.id;
				for (let i = pastedVisualLevel + 1; i <= 6; i++) {
					delete this.activeKeysByLevel[i];
				}
				this.selectedLevel = pastedVisualLevel;
				new Notice(`Card "${pastedCard.title}" pasted`);
			}
			this.requestSave();
			this.renderFractal();
			return;
		}

		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (currentIdx > 0) {
				this.selectCard(currentParent.children[currentIdx - 1], level);
			} else {
				// Auto-create above
				this.insertCard(currentParent, 0, level);
			}
		} 
		else if (e.key === "ArrowDown") {
			e.preventDefault();
			if (currentIdx < currentParent.children.length - 1) {
				this.selectCard(currentParent.children[currentIdx + 1], level);
			} else {
				// Auto-create below
				this.insertCard(currentParent, currentIdx + 1, level);
			}
		} 
		else if (e.key === "ArrowLeft") {
			e.preventDefault();
			if (level > 1) {
				// Navigate to parent level
				const parentInfo = this.findParent(this.root, activeId);
				if (parentInfo) {
					this.selectCard(parentInfo.parent, level - 1);
				}
			}
		} 
		else if (e.key === "ArrowRight") {
			e.preventDefault();
			if (card.children.length > 0) {
				// Enter the child column — select first child (or the auto-selected one)
				const childActiveId = this.lastSelectedChildByParent[card.id] || this.activeKeysByLevel[level + 1];
				const targetChild = card.children.find(c => c.id === childActiveId) || card.children[0];
				this.selectCard(targetChild, level + 1);
			} else if (level < 6) {
				// Auto-create child
				this.insertCard(card, 0, level + 1);
			}
		} 
		else if (e.key === "Enter") {
			e.preventDefault();
			this.startEditingCard(card);
		}
		else if ((e.ctrlKey || e.altKey) && (e.code === "KeyN" || e.key.toLowerCase() === "n")) {
			e.preventDefault();
			if (e.shiftKey) {
				if (level < 6) this.insertCard(card, card.children.length, level + 1);
			} else {
				this.insertCard(currentParent, currentIdx + 1, level);
			}
		}
	}

	getSelectedLevel(): number {
		let maxLevel = 0;
		for (const key of Object.keys(this.activeKeysByLevel)) {
			const level = parseInt(key);
			if (level > maxLevel) maxLevel = level;
		}
		return maxLevel;
	}

	selectCard(card: FractalCard, level: number) {
		// Traverse upwards to fix activeKeysByLevel for ancestors
		let currentCard: FractalCard | null = card;
		let currentLevel = level;
		while (currentCard && currentLevel > 0) {
			this.activeKeysByLevel[currentLevel] = currentCard.id;
			if (currentLevel > 1) {
				const pInfo = this.findParent(this.root, currentCard.id);
				if (pInfo) {
					this.lastSelectedChildByParent[pInfo.parent.id] = currentCard.id;
					currentCard = pInfo.parent;
				} else {
					currentCard = null;
				}
			} else {
				this.lastSelectedChildByParent["root"] = currentCard.id;
				currentCard = null;
			}
			currentLevel--;
		}

		for (let i = level + 1; i <= 6; i++) {
			delete this.activeKeysByLevel[i];
		}
		this.ensureSelectionPath();
		this.selectedLevel = level;
		this.renderFractal();

		setTimeout(() => {
			const activeEl = this.contentEl.querySelector(".fractal-card.active") as HTMLElement;
			const viewContainer = this.contentEl.querySelector(".fractal-view-container") as HTMLElement;
			if (activeEl && viewContainer) {
				this.centerActiveCard(activeEl, viewContainer);
			}
		}, 100);
	}

	centerActiveCard(activeEl: HTMLElement, container: HTMLElement) {
		const containerRect = container.getBoundingClientRect();
		const activeRect = activeEl.getBoundingClientRect();
		
		// Safe zone: middle 40% of the viewport (both horizontally and vertically)
		const safeWidth = containerRect.width * 0.4;
		const safeHeight = containerRect.height * 0.4;
		
		const safeLeft = containerRect.left + (containerRect.width - safeWidth) / 2;
		const safeRight = safeLeft + safeWidth;
		const safeTop = containerRect.top + (containerRect.height - safeHeight) / 2;
		const safeBottom = safeTop + safeHeight;
		
		// Center point of active card
		const activeCenterX = activeRect.left + activeRect.width / 2;
		const activeCenterY = activeRect.top + activeRect.height / 2;
		
		let deltaX = 0;
		let deltaY = 0;
		
		// If active card center is outside the safe horizontal zone, align it to screen center
		if (activeCenterX < safeLeft || activeCenterX > safeRight) {
			deltaX = activeRect.left - containerRect.left - (containerRect.width - activeRect.width) / 2;
		}
		
		// If active card center is outside the safe vertical zone, align it to screen center
		if (activeCenterY < safeTop || activeCenterY > safeBottom) {
			deltaY = activeRect.top - containerRect.top - (containerRect.height - activeRect.height) / 2;
		}
		
		if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
			container.scrollBy({
				left: deltaX,
				top: deltaY,
				behavior: "smooth"
			});
		}
	}


}

// Main Plugin Class
export default class FractalPlugin extends Plugin {
	settings!: FractalSettings;
	togglingView = false;

	async onload() {
		await this.loadSettings();

		// Register the custom view
		this.registerView(
			VIEW_TYPE_FRACTAL,
			(leaf: WorkspaceLeaf) => new FractalView(leaf, this)
		);

		// Auto open markdown files as Fractal view if openByDefault is enabled
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (this.togglingView) return;
				if (this.settings.openByDefault && file && file.extension === "md") {
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView && activeView.file?.path === file.path) {
						const state = activeView.leaf.getViewState();
						if (state.type !== VIEW_TYPE_FRACTAL) {
							activeView.leaf.setViewState({
								type: VIEW_TYPE_FRACTAL,
								active: true,
								state: state.state
							});
						}
					}
				}
			})
		);

		// Keep per-file visual metadata synchronized on file rename or deletion
		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				let changed = false;
				if (this.settings.cardColors[oldPath]) {
					this.settings.cardColors[file.path] = this.settings.cardColors[oldPath];
					delete this.settings.cardColors[oldPath];
					changed = true;
				}
				if (this.settings.collapsedNodes[oldPath]) {
					this.settings.collapsedNodes[file.path] = this.settings.collapsedNodes[oldPath];
					delete this.settings.collapsedNodes[oldPath];
					changed = true;
				}
				if (this.settings.collapsedColumns[oldPath]) {
					this.settings.collapsedColumns[file.path] = this.settings.collapsedColumns[oldPath];
					delete this.settings.collapsedColumns[oldPath];
					changed = true;
				}
				if (changed) {
					await this.saveSettings();
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", async (file) => {
				let changed = false;
				if (this.settings.cardColors[file.path]) {
					delete this.settings.cardColors[file.path];
					changed = true;
				}
				if (this.settings.collapsedNodes[file.path]) {
					delete this.settings.collapsedNodes[file.path];
					changed = true;
				}
				if (this.settings.collapsedColumns[file.path]) {
					delete this.settings.collapsedColumns[file.path];
					changed = true;
				}
				if (changed) {
					await this.saveSettings();
				}
			})
		);

		// Add Ribbon icon to toggle view
		this.addRibbonIcon("network", "Toggle Fractal view", () => {
			this.toggleFractalView();
		});

		// Add Command to toggle view
		this.addCommand({
			id: "toggle-view",
			name: "Toggle view",
			callback: () => this.toggleFractalView()
		});

		// Re-render open Fractal views once vault metadata cache resolves embeds/links
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
				for (const leaf of leaves) {
					if (leaf.view instanceof FractalView) {
						const unresolvedEmbeds = leaf.view.contentEl.querySelectorAll(".internal-embed:not(.is-loaded)");
						if (unresolvedEmbeds.length > 0) {
							leaf.view.renderFractal();
						}
					}
				}
			})
		);

		// Register settings tab
		this.addSettingTab(new FractalSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.viewMode = "ginkgo";
		if (this.settings.themeMode === ("steel-blue" as any) || this.settings.themeMode === ("classic" as any)) {
			this.settings.themeMode = "obsidian-theme";
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	lastActiveHeadingId: string | null = null;

	// Toggle active tab between standard Markdown and Fractal View
	async toggleFractalView() {
		this.togglingView = true;
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		if (!activeLeaf) {
			this.togglingView = false;
			return;
		}

		const currentViewState = activeLeaf.getViewState();

		if (currentViewState.type === "markdown") {
			const markdownView = activeLeaf.view as MarkdownView;
			const targetId = getHeadingIdAtCursor(markdownView, this.app);
			this.lastActiveHeadingId = targetId; // set or reset the last active heading

			await activeLeaf.setViewState({
				type: VIEW_TYPE_FRACTAL,
				active: true,
				state: currentViewState.state
			});
		} else if (currentViewState.type === VIEW_TYPE_FRACTAL) {
			const fractalView = activeLeaf.view as FractalView;
			fractalView.saveActiveEdit();
			const selectedId = fractalView.activeKeysByLevel[fractalView.selectedLevel];

			await activeLeaf.setViewState({
				type: "markdown",
				active: true,
				state: currentViewState.state
			});

			if (selectedId && selectedId !== "root") {
				const focusHeading = () => {
					const activeView = activeLeaf.view;
					if (activeView && activeView.getViewType() === "markdown") {
						const markdownView = activeView as MarkdownView;
						const line = getLineOfHeadingId(markdownView, selectedId, this.app);
						if (line !== null) {
							markdownView.editor.focus();
							markdownView.editor.setCursor({ line, ch: 0 });
							markdownView.editor.scrollIntoView({
								from: { line: Math.max(0, line - 3), ch: 0 },
								to: { line: line + 3, ch: 0 }
							}, true);
						}
					}
				};

				// Execute multiple times to override Obsidian's async layout & native scroll-restore mechanisms
				setTimeout(focusHeading, 50);
				setTimeout(focusHeading, 150);
				setTimeout(focusHeading, 300);
				setTimeout(focusHeading, 600);
			}
		}
		setTimeout(() => {
			this.togglingView = false;
		}, 500);
	}
}

// Settings Tab
class FractalSettingTab extends PluginSettingTab {
	plugin: FractalPlugin;

	constructor(app: App, plugin: FractalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Column width")
			.setDesc("Set the default column width for all notes (from 300px to 800px).")
			.addSlider((slider) =>
				slider
					.setLimits(300, 800, 10)
					.setValue(this.plugin.settings.columnWidth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.columnWidth = value;
						await this.plugin.saveSettings();
						// Re-render open Fractal views instantly
						const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
						for (const leaf of leaves) {
							if (leaf.view instanceof FractalView) {
								leaf.view.renderFractal();
							}
						}
					})
			);

		new Setting(containerEl)
			.setName("Section behavior")
			.setDesc("Choose whether cards should remain expanded after deselection or collapse back to preview mode.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("preview", "View preview after selection")
					.addOption("keep", "Keep open after selection")
					.setValue(this.plugin.settings.sectionBehavior || "preview")
					.onChange(async (value) => {
						this.plugin.settings.sectionBehavior = value as "keep" | "preview";
						await this.plugin.saveSettings();
						const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
						for (const leaf of leaves) {
							if (leaf.view instanceof FractalView) {
								leaf.view.expandedCardIds.clear();
								leaf.view.renderFractal();
							}
						}
					})
			);

		new Setting(containerEl)
			.setName("Open notes in Fractal view by default")
			.setDesc("Automatically open Markdown notes in Fractal view when clicking on them.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openByDefault || false)
					.onChange(async (value) => {
						this.plugin.settings.openByDefault = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Centered navigation")
			.setDesc("Keep the active card centered in the viewport when navigating.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.centeredNavigation || false)
					.onChange(async (value) => {
						this.plugin.settings.centeredNavigation = value;
						await this.plugin.saveSettings();
						const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
						for (const leaf of leaves) {
							if (leaf.view instanceof FractalView) {
								leaf.view.applyCenteredLayout();
							}
						}
					})
			);

		new Setting(containerEl)
			.setName("Clear style data")
			.setDesc("Clear all saved card colors and column/node collapse states.")
			.addButton((btn) =>
				btn.setButtonText("Clear data").onClick(() => {
					new ConfirmModal(this.app, {
						title: "Clear style data",
						message: "Are you sure you want to clear all note color customizations and collapse states?",
						confirmText: "Clear data",
						isWarning: true,
						onConfirm: async () => {
							this.plugin.settings.cardColors = {};
							this.plugin.settings.collapsedNodes = {};
							this.plugin.settings.collapsedColumns = {};
							this.plugin.settings.zoom = 1.0;
							await this.plugin.saveSettings();
							new Notice("All style settings have been reset.");
							// Re-render open views
							const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FRACTAL);
							for (const leaf of leaves) {
								if (leaf.view instanceof FractalView) {
									leaf.view.renderFractal();
								}
							}
						}
					}).open();
				})
			);
	}
}
