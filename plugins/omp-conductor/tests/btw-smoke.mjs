import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rootBase = process.env.TMPDIR || os.tmpdir();
const root = await mkdtemp(path.join(rootBase, "omp-btw-smoke-"));
const sessionDir = path.join(root, "session");
const btwDir = path.join(root, "btw");
await mkdir(sessionDir);
await mkdir(btwDir);
const extension = fileURLToPath(new URL("../extensions/btw.ts", import.meta.url));
const envFile = path.join(os.homedir(), ".pi-workers", "env");
let child;
const output = [];
let secret = "";
let sleepStartedAt;
let sleepEnded = false;

function containsHandled(value) {
	if (!value || typeof value !== "object") return false;
	for (const [key, item] of Object.entries(value)) {
		if (key === "disposition" && item === "handled") return true;
		if (containsHandled(item)) return true;
	}
	return false;
}

function observe(line) {
	output.push(line);
	let value;
	try { value = JSON.parse(line); } catch { return; }
	const serialized = JSON.stringify(value);
	if (/tool_execution_start/.test(serialized) && /sleep\\?\s*40/.test(serialized)) sleepStartedAt ??= Date.now();
	if (/tool_execution_end/.test(serialized) && /sleep\\?\s*40/.test(serialized)) sleepEnded = true;
}

function waitFor(predicate, timeoutMs, label) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (predicate()) return resolve();
			if (child?.exitCode !== null && child?.exitCode !== undefined) {
				return reject(new Error(`Pi exited before ${label} (code ${child.exitCode})`));
			}
			if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
			setTimeout(poll, 100);
		};
		poll();
	});
}

async function sessionSnapshot() {
	const names = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
	assert.ok(names.length > 0, "Pi did not create a session JSONL file");
	const snapshot = new Map();
	for (const name of names) snapshot.set(name, await readFile(path.join(sessionDir, name)));
	return snapshot;
}

function snapshotEqual(before, after) {
	assert.deepEqual([...after.keys()], [...before.keys()], "session JSONL files changed during /btw");
	for (const [name, bytes] of before) {
		assert.ok(bytes.equals(after.get(name)), `session JSONL ${name} changed during /btw`);
	}
}

try {
	const envText = await readFile(envFile, "utf8");
	const keyLine = envText.split(/\r?\n/).find((line) => /^\s*(?:export\s+)?OPENCODE_GO_API_KEY\s*=/.test(line));
	assert.ok(keyLine, `OPENCODE_GO_API_KEY was not found in ${envFile}`);
	secret = keyLine.replace(/^\s*(?:export\s+)?OPENCODE_GO_API_KEY\s*=\s*/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
	assert.ok(secret, "OPENCODE_GO_API_KEY is empty");

	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(os.homedir(), ".pi-workers"),
		PI_BTW_DIR: btwDir,
		OPENCODE_GO_API_KEY: secret,
	};
	child = spawn("pi", [
		"--mode", "rpc", "-e", extension, "--offline", "-ne", "-ns", "-np", "-nc", "-na",
		"--session-dir", sessionDir, "--model", "opencode-go/deepseek-v4.1-flash", "--thinking", "off",
	], { stdio: ["pipe", "pipe", "pipe"], env });
	readline.createInterface({ input: child.stdout }).on("line", observe);
	readline.createInterface({ input: child.stderr }).on("line", (line) => output.push(`[stderr] ${secret ? line.replaceAll(secret, "[REDACTED]") : line}`));
	child.on("error", (error) => output.push(`[spawn error] ${error.message}`));

	const reqId = `smoke_${Date.now()}`;
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Use the bash tool to run `sleep 40` exactly once, do not interrupt it, and then report when it finishes." })}\n`);
	await waitFor(() => sleepStartedAt !== undefined, 60_000, "the sleep 40 bash tool call to start");
	await sleep(8_000);
	const before = await sessionSnapshot();
	const responseStart = output.length;
	const btwPrompt = `/btw ${reqId} What are you doing now, what is left, and are you stuck?`;
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: btwPrompt })}\n`);

	const resultPath = path.join(btwDir, `${reqId}.json`);
	await waitFor(() => output.slice(responseStart).some((line) => {
		try {
			const value = JSON.parse(line);
			return value.type === "response" && value.command === "prompt" && containsHandled(value);
		} catch { return false; }
	}) && existsSync(resultPath), 25_000, "the handled /btw response and result file");

	const result = JSON.parse(await readFile(resultPath, "utf8"));
	assert.equal(result.id, reqId);
	assert.ok(typeof result.a === "string" && result.a.trim().length > 0, `empty /btw answer: ${JSON.stringify(result)}`);
	assert.ok(sleepStartedAt && Date.now() - sleepStartedAt < 40_000, "the sleep 40 call had already finished before the /btw result");
	assert.equal(sleepEnded, false, "the sleep 40 tool call ended before the /btw result");
	snapshotEqual(before, await sessionSnapshot());
	console.log("PASS: /btw response disposition was handled");
	console.log(`PASS: non-empty answer written to ${resultPath}`);
	console.log("PASS: result arrived while the sleep 40 bash call was still running");
	console.log("PASS: session JSONL bytes were identical before and after /btw");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("Pi output (last 40 lines):");
	for (const line of output.slice(-40)) console.error(line);
	process.exitCode = 1;
} finally {
	if (child && child.exitCode === null) {
		try {
			child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
			child.stdin.end();
			await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(8_000)]);
			if (child.exitCode === null) child.kill("SIGTERM");
		} catch { child.kill("SIGTERM"); }
	}
	await rm(root, { recursive: true, force: true });
}

