// Side-channel progress answers for omp-conductor workers. This command deliberately
// uses a separate model call and never sends a message to the worker's session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const DEFAULT_QUESTION = "What exactly are you doing right now, why is it taking this long, what is left, and are you stuck?";
const SYSTEM_PROMPT = "You are a coding worker answering your supervisor's side question about your own progress. You have your normal tools (read, edit, write, bash, grep and so on); this side call simply has no tools of its own, so never say you lack tools or access. Answer only from the transcript and the 'Currently running' line you are given: what you have done, what you are doing right now (the running tool call and how long it has run), why it may be slow, what is left, and whether you are stuck or looping. Be concrete, plain prose, 5 sentences max, no SUMMARY or FINDINGS block.";
const MAX_BRANCH_CHARS = 14_000;
const MAX_RECENT_CHARS = 10_500;
const MAX_RESULT_CHARS = 1_000;
const MODEL_TIMEOUT_MS = 45_000;

function textContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => {
		if (part?.type === "text") return String(part.text ?? "");
		if (part?.type === "image") return "[image]";
		return "";
	}).filter(Boolean).join(" ");
}

function renderEntry(entry: any): string {
	const message = entry?.message ?? entry;
	if (!message || typeof message !== "object") return "";
	const role = String(message.role ?? entry?.type ?? "message");
	const chunks: string[] = [];
	const content = message.content;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part?.type === "text") chunks.push(String(part.text ?? ""));
			else if (part?.type === "toolCall") {
				let args = "";
				try { args = JSON.stringify(part.arguments ?? {}); } catch { args = "[unavailable]"; }
				chunks.push(`[tool call ${String(part.name ?? "unknown")}: ${args.slice(0, MAX_RESULT_CHARS)}]`);
			} else if (part?.type === "image") chunks.push("[image]");
		}
	} else if (typeof content === "string") {
		chunks.push(content);
	}
	if (role === "toolResult" || message.toolName) {
		const name = String(message.toolName ?? message.name ?? "tool");
		return `[${name} result] ${textContent(content).slice(0, MAX_RESULT_CHARS)}`;
	}
	const text = chunks.join(" ").trim();
	if (!text) return "";
	return `[${role}] ${text.slice(0, MAX_RESULT_CHARS)}`;
}

function renderBranch(ctx: any): string {
	const branch = ctx.sessionManager.getBranch();
	const entries = Array.isArray(branch) ? branch : [];
	const firstUser = entries.map((entry: any) => entry?.message ?? entry)
		.find((message: any) => message?.role === "user");
	const task = firstUser ? textContent(firstUser.content).slice(0, 3_000) : "(task unavailable)";
	const recent = entries.map(renderEntry).filter(Boolean).slice(-40).join("\n").slice(-MAX_RECENT_CHARS);
	const rendered = `Task:\n${task}\n\nRecent session branch:\n${recent}`;
	return rendered.length <= MAX_BRANCH_CHARS ? rendered : rendered.slice(-MAX_BRANCH_CHARS);
}

function notify(ctx: any, message: string, level: "error" | "info" = "error"): void {
	try { ctx.ui?.notify?.(message, level); } catch { /* notifications must not escape the handler */ }
}

function writeResult(dir: string, result: Record<string, unknown>): void {
	const target = join(dir, `${String(result.id)}.json`);
	const temp = `${target}.tmp`;
	writeFileSync(temp, `${JSON.stringify(result)}\n`, "utf8");
	renameSync(temp, target);
}

async function getAnswer(ctx: any, question: string, branch: string): Promise<string> {
	if (!ctx.model) throw new Error("The worker's current model is unavailable");
	if (!ctx.modelRegistry?.complete) throw new Error("The provider-neutral nested model API is unavailable");
	const controller = new AbortController();
	const userMessage = {
		role: "user",
		content: [{ type: "text", text: `Supervisor question: ${question}\n\nWorker session context:\n${branch}` }],
		timestamp: Date.now(),
	};
	let sessionId = "";
	try { sessionId = String(ctx.sessionManager?.getSessionId?.() ?? ""); } catch { /* optional */ }
	const timer = setTimeout(() => controller.abort(new Error("Nested model call timed out after 45 seconds")), MODEL_TIMEOUT_MS);
	try {
		const response = await ctx.modelRegistry.complete(ctx.model, {
			systemPrompt: SYSTEM_PROMPT,
			messages: [userMessage],
		}, {
			signal: controller.signal,
			// Some providers (OpenCode Go) reject requests without a session id; send the worker's own, as the main loop does.
			sessionId: sessionId || undefined,
			headers: sessionId ? { "x-opencode-session": sessionId } : undefined,
		});
		const answer = (response.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n").trim();
		if (response.stopReason === "error" || !answer) {
			const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
			throw new Error(`Nested model returned ${response.stopReason === "error" ? "an error" : "an empty answer"}${detail}`);
		}
		return answer;
	} finally {
		clearTimeout(timer);
	}
}

export default function (pi: ExtensionAPI) {
	// The session branch only records finished tool calls; track the one that is running so the answer can name it.
	let inflight: { name: string; input: unknown; at: number } | undefined;
	pi.on("tool_call", async (event: any) => {
		inflight = { name: String(event.toolName ?? "tool"), input: event.input, at: Date.now() };
	});
	pi.on("tool_result", async () => { inflight = undefined; });
	const runningLine = () => {
		if (!inflight) return "Currently running: no tool call (thinking or between steps).";
		let args = "";
		try { args = JSON.stringify(inflight.input ?? {}).slice(0, 300); } catch { args = "[unavailable]"; }
		return `Currently running: ${inflight.name} ${args} for ${Math.round((Date.now() - inflight.at) / 1000)}s.`;
	};
	pi.registerCommand("btw", {
		description: "Answer a supervisor's side question without adding it to this session",
		handler: async (args: string, ctx: any) => {
			let reqId = "";
			let question = DEFAULT_QUESTION;
			let dir = "";
			try {
				const match = String(args ?? "").match(/^\s*([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?\s*$/);
				if (!match) {
					notify(ctx, "Usage: /btw <reqId> <question>");
					return;
				}
				reqId = match[1];
				question = String(match[2] ?? "").trim() || DEFAULT_QUESTION;

				dir = process.env.PI_BTW_DIR ?? "";
				if (!dir) {
					notify(ctx, "PI_BTW_DIR is unset; cannot write the /btw result");
					return;
				}
				let validDir = false;
				try { validDir = isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory(); } catch { /* report the same configuration error */ }
				if (!validDir) {
					notify(ctx, "PI_BTW_DIR must be an absolute path to an existing directory");
					return;
				}

				const started = Date.now();
				const branch = `${renderBranch(ctx)}\n\n${runningLine()}`;
				const answer = await getAnswer(ctx, question, branch);
				if (!answer) throw new Error("Nested model returned an empty answer");
				writeResult(dir, { id: reqId, q: question, a: answer, at: new Date().toISOString(), ms: Date.now() - started });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				let wroteError = false;
				try {
					if (reqId && /^[A-Za-z0-9_-]+$/.test(reqId) && dir && isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory()) {
						writeResult(dir, { id: reqId, q: question, error: message, at: new Date().toISOString() });
						wroteError = true;
					}
				} catch { /* notify below if the failure result cannot be written */ }
				if (!wroteError) notify(ctx, `Could not write /btw result: ${message}`);
				else notify(ctx, `Could not answer /btw: ${message}`);
			}
		},
	});
}
