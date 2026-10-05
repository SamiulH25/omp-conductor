// Manager-only tools forwarded to omp-conductor through a per-manager file bridge.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const POLL_MS = 300;
const QUICK_TOOLS = new Set(["sub_status", "sub_digest", "sub_diff", "sub_log", "sub_btw", "sub_kill", "sub_cleanup"]);
let requestCounter = 0;

function toolResult(text: string, isError = false): any {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function requestId(): string {
	requestCounter += 1;
	return `${Date.now().toString(36)}${requestCounter.toString(36)}${randomBytes(8).toString("hex")}`;
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// The only bridge operation: atomically publish one request, poll its response, then consume it.
async function bridgeRequest(dir: string, tool: string, args: any, signal?: AbortSignal): Promise<any> {
	let requestTemp = "";
	let requestPublished = false;
	try {
		if (signal?.aborted) return toolResult("Manager tool call aborted", true);
		if (!isAbsolute(dir)) return toolResult("PI_MGR_DIR must be an absolute path", true);
		const reqDir = join(dir, "req");
		const resDir = join(dir, "res");
		if (!(await stat(reqDir)).isDirectory() || !(await stat(resDir)).isDirectory()) {
			return toolResult("PI_MGR_DIR must contain req/ and res/ directories", true);
		}

		const id = requestId();
		const reqPath = join(reqDir, `${id}.json`);
		requestTemp = `${reqPath}.tmp`;
		const resPath = join(resDir, `${id}.json`);
		await writeFile(requestTemp, `${JSON.stringify({ id, tool, args })}\n`, "utf8");
		if (signal?.aborted) {
			await unlink(requestTemp).catch(() => undefined);
			return toolResult("Manager tool call aborted", true);
		}
		await rename(requestTemp, reqPath);
		requestPublished = true;

		const waitSec = Number.isFinite(args?.timeoutSec) ? Math.min(600, Math.max(1, args.timeoutSec)) : 120;
		const timeoutMs = tool === "sub_wait" ? (waitSec + 30) * 1_000 : QUICK_TOOLS.has(tool) ? 120_000 : 660_000;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) return toolResult("Manager tool call aborted", true);
			try {
				const raw = await readFile(resPath, "utf8");
				await unlink(resPath).catch((error: any) => {
					if (error?.code !== "ENOENT") throw error;
				});
				const response = JSON.parse(raw);
				if (!response || response.id !== id || typeof response.ok !== "boolean" || typeof response.text !== "string") {
					return toolResult("Invalid response from manager bridge", true);
				}
				return toolResult(response.text, !response.ok);
			} catch (error: any) {
				if (error?.code !== "ENOENT") throw error;
			}
			if (!(await waitForPoll(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal))) {
				return toolResult("Manager tool call aborted", true);
			}
		}
		return toolResult(`Timed out waiting for ${tool} response after ${Math.ceil(timeoutMs / 1_000)} seconds`, true);
	} catch (error) {
		return toolResult(`Manager bridge error: ${error instanceof Error ? error.message : String(error)}`, true);
	} finally {
		if (!requestPublished && requestTemp) await unlink(requestTemp).catch(() => undefined);
	}
}

const idParam = Type.String({ description: "The id of one of this manager's direct sub-workers." });
const stringArray = () => Type.Array(Type.String());

export default function (pi: ExtensionAPI) {
	const dir = process.env.PI_MGR_DIR;
	if (!dir) return;

	const definitions: any[] = [
		{
			name: "sub_spawn",
			label: "Spawn sub-worker",
			description: "Delegate one focused slice of this feature to a sub-worker; never implement the feature yourself. Split work into independent tasks with disjoint files/owns patterns, spawn them in parallel where safe, then use sub_wait, inspect every good result with sub_diff, and merge each accepted change with sub_merge before running checks.",
			parameters: Type.Object({
				task: Type.String({ description: "A complete, standalone task for one focused slice of the feature." }),
				agent: Type.String({ description: "Worker type: dev, general, explore, review, planner, or a custom type; never manager." }),
				title: Type.String(),
				owns: stringArray(),
				after: stringArray(),
				maxMinutes: Type.Number(),
				effort: Type.String(),
				skills: stringArray(),
				checks: stringArray(),
				verify: Type.String(),
				codex: Type.Boolean(),
			}, { required: ["task"], additionalProperties: false }),
		},
		{
			name: "sub_wait",
			label: "Wait for sub-workers",
			description: "Wait for one or more of your direct sub-workers and read their change digests. Use this after sub_spawn; default mode first returns when a worker changes state, while all waits for every requested worker. Then review results with sub_diff before deciding what to merge.",
			parameters: Type.Object({
				ids: Type.Optional(stringArray()),
				timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Maximum wait in seconds (default 120, maximum 600)." })),
				mode: Type.Optional(Type.Union([Type.Literal("first"), Type.Literal("all")])),
			}, { additionalProperties: false }),
		},
		{
			name: "sub_status",
			label: "Sub-worker status",
			description: "List the state of your direct sub-workers. Use this to track delegated work, then sub_wait for useful completion digests.",
			parameters: Type.Object({}, { additionalProperties: false }),
		},
		{
			name: "sub_digest",
			label: "Sub-worker digest",
			description: "Read one sub-worker's report, changed files, commands, errors, and git status. Treat claims as unverified; inspect its actual changes with sub_diff before sub_merge.",
			parameters: Type.Object({ id: idParam, detail: Type.Union([Type.Literal("brief"), Type.Literal("full")]) }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_diff",
			label: "Review sub-worker diff",
			description: "Show the real diff from one sub-worker. Review this before accepting work; merge good changes with sub_merge, and send corrections with sub_send rather than implementing the work yourself.",
			parameters: Type.Object({ id: idParam }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_send",
			label: "Send sub-worker correction",
			description: "Give one sub-worker a focused correction or follow-up while preserving its context. Use interrupt:true only to redirect a currently running worker. After it finishes, review its new diff before merging.",
			parameters: Type.Object({ id: idParam, message: Type.String(), interrupt: Type.Boolean() }, { required: ["id", "message"], additionalProperties: false }),
		},
		{
			name: "sub_merge",
			label: "Merge sub-worker",
			description: "Merge one accepted sub-worker's changes into your manager integration branch. First inspect sub_diff and digest; after merging each good worker, run the relevant checks before reporting to the orchestrator.",
			parameters: Type.Object({ id: idParam, message: Type.String() }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_cleanup",
			label: "Clean up sub-worker",
			description: "Remove a finished sub-worker and its worktree after its changes are merged or deliberately discarded. Do not clean up work that still needs review or correction.",
			parameters: Type.Object({ id: idParam, force: Type.Boolean() }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_kill",
			label: "Stop sub-worker",
			description: "Stop one sub-worker that should not continue, or remove it from the queue. Prefer sub_send for recoverable corrections; inspect its partial diff before cleanup.",
			parameters: Type.Object({ id: idParam }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_log",
			label: "Sub-worker activity log",
			description: "Read the recent activity log for one sub-worker to diagnose what it did, errors, and where it is stuck.",
			parameters: Type.Object({ id: idParam, from: Type.Number(), count: Type.Number() }, { required: ["id"], additionalProperties: false }),
		},
		{
			name: "sub_btw",
			label: "Ask sub-worker status question",
			description: "Ask a running sub-worker what it is doing and what remains, without interrupting it. Use this to diagnose slow or quiet work before sending a correction or stopping it.",
			parameters: Type.Object({ id: idParam, question: Type.String() }, { required: ["id"], additionalProperties: false }),
		},
	];

	for (const definition of definitions) {
		pi.registerTool({
			...definition,
			async execute(_toolCallId: string, args: any, signal?: AbortSignal) {
				return bridgeRequest(dir, definition.name, args ?? {}, signal);
			},
		});
	}
}
