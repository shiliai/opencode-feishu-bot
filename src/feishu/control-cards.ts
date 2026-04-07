import type {
	InteractiveCard,
	InteractiveCardActionItem,
	InteractiveCardElement,
} from "@larksuiteoapi/node-sdk";
import { plainText } from "./cards.js";
import type { ChatMessage } from "./message-reader.js";

export interface SessionSummary {
	id: string;
	title?: string;
	[key: string]: unknown;
}

const COMMAND_HELP: Array<{ command: string; description: string }> = [
	{ command: "/help", description: "Show available commands" },
	{ command: "/new", description: "Create a new session" },
	{ command: "/sessions", description: "List recent sessions" },
	{
		command: "/session [id]",
		description: "Switch to a session (or show picker)",
	},
	{ command: "/history [count]", description: "Show recent chat messages" },
	{ command: "/model [name]", description: "Switch model (or show picker)" },
	{ command: "/agent [name]", description: "Switch agent (or show picker)" },
	{ command: "/status", description: "Show current status" },
	{ command: "/abort", description: "Abort the current session" },
];

const HISTORY_PREVIEW_LIMIT = 200;

function formatHistoryTimestamp(createdAt: string): string {
	const parsedDate = new Date(createdAt);
	if (Number.isNaN(parsedDate.getTime())) {
		return "--:--";
	}

	const hours = String(parsedDate.getHours()).padStart(2, "0");
	const minutes = String(parsedDate.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

function formatHistorySender(message: ChatMessage): string {
	const senderId = message.senderId.trim();
	if (senderId) {
		return senderId;
	}

	return message.senderType;
}

function buildHistoryPreview(content: string): string {
	const normalized =
		content.replace(/\r\n/g, "\n").trim() || "[no readable content]";
	if (normalized.length <= HISTORY_PREVIEW_LIMIT) {
		return normalized;
	}

	return `${normalized.slice(0, HISTORY_PREVIEW_LIMIT - 1)}…`;
}

export function buildHelpCard(): InteractiveCard {
	const commandLines = COMMAND_HELP.map(
		(c) => `**${c.command}** — ${c.description}`,
	);
	const content = commandLines.join("\n");

	return {
		header: {
			title: plainText("OpenCode Commands"),
			template: "blue",
		},
		elements: [
			{
				tag: "markdown",
				content,
			},
		],
	};
}

export function buildSessionListCard(
	sessions: SessionSummary[],
): InteractiveCard {
	const elements: InteractiveCardElement[] = [];

	if (sessions.length === 0) {
		elements.push({
			tag: "markdown",
			content: "No recent sessions found.",
		});
	} else {
		const lines = sessions
			.map((s, i) => `${i + 1}. **${s.id}**${s.title ? ` — ${s.title}` : ""}`)
			.join("\n");
		elements.push({
			tag: "markdown",
			content: lines,
		});

		const buttons: InteractiveCardActionItem[] = sessions
			.slice(0, 10)
			.map((s) => ({
				tag: "button",
				text: plainText(s.id),
				value: { action: "select_session", sessionId: s.id },
			}));
		elements.push({
			tag: "action",
			actions: buttons,
		});
	}

	return {
		header: {
			title: plainText("Sessions"),
			template: "blue",
		},
		elements,
	};
}

export function buildModelPickerCard(models: string[]): InteractiveCard {
	const elements: InteractiveCardElement[] = [];

	if (models.length === 0) {
		elements.push({
			tag: "markdown",
			content: "No models available.",
		});
	} else {
		elements.push({
			tag: "markdown",
			content: "Select a model:",
		});

		const buttons: InteractiveCardActionItem[] = models.map((m) => ({
			tag: "button",
			text: plainText(m),
			value: { action: "select_model", modelName: m },
		}));
		elements.push({
			tag: "action",
			actions: buttons,
		});
	}

	return {
		header: {
			title: plainText("Model Picker"),
			template: "blue",
		},
		elements,
	};
}

export function buildAgentPickerCard(agents: string[]): InteractiveCard {
	const elements: InteractiveCardElement[] = [];

	if (agents.length === 0) {
		elements.push({
			tag: "markdown",
			content: "No agents available.",
		});
	} else {
		elements.push({
			tag: "markdown",
			content: "Select an agent:",
		});

		const buttons: InteractiveCardActionItem[] = agents.map((a) => ({
			tag: "button",
			text: plainText(a),
			value: { action: "select_agent", agentName: a },
		}));
		elements.push({
			tag: "action",
			actions: buttons,
		});
	}

	return {
		header: {
			title: plainText("Agent Picker"),
			template: "blue",
		},
		elements,
	};
}

export function buildHistoryCard(
	messages: ChatMessage[],
	totalCount?: number,
): InteractiveCard {
	const shownCount = messages.length;
	const title =
		typeof totalCount === "number" && totalCount !== shownCount
			? `Chat History (${shownCount} of ${totalCount})`
			: "Chat History";

	const content =
		shownCount === 0
			? "No recent messages found."
			: messages
					.map(
						(message) =>
							`**[${formatHistorySender(message)}]** (${formatHistoryTimestamp(message.createdAt)})\n${buildHistoryPreview(message.content)}`,
					)
					.join("\n\n");

	return {
		header: {
			title: plainText(title),
			template: "blue",
		},
		elements: [
			{
				tag: "markdown",
				content,
			},
		],
	};
}

export function buildStatusCard(status: {
	session: string | null;
	model: string | null;
	agent: string | null;
	state: string;
}): InteractiveCard {
	const lines: string[] = [];
	lines.push(`**Session**: ${status.session ?? "none"}`);
	lines.push(`**Model**: ${status.model ?? "none"}`);
	lines.push(`**Agent**: ${status.agent ?? "none"}`);
	lines.push(`**State**: ${status.state}`);

	return {
		header: {
			title: plainText("OpenCode Status"),
			template: "blue",
		},
		elements: [
			{
				tag: "markdown",
				content: lines.join("\n"),
			},
		],
	};
}
