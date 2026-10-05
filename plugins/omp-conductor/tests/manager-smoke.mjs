import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "omp-manager-smoke-"));
const sessionDir = path.join(root, "session");
const managerDir = path.join(root, "mgr");
const reqDir = path.join(managerDir, "req");
const resDir = path.join(managerDir, "res");
const extension = fileURLToPath(new URL("../extensions/manager.ts", import.meta.url));
const envFile = path.join(os.homedir(), ".pi-workers", "env");
let child;
let responderTask;
let stopping = false;
let secret = "";
let failure;
const output = [];
const requests = [];
let answered = 0;
let intentionalErrorSeen = false;
let finalDoneSeen = false;

function redact(text) {
	return secret ? String(text).replaceAll(secret, "[REDACTED]") : String(text);
}

function findErrorMarker(value) {
	if (!value || typeof value !== "object") return false;
	for (const [key, item] of Object.entries(value)) {
		if ((key === "isError" || key === "is_error") && item === true) return true;
		if (findErrorMarker(item)) return true;
	}
	return false;
}

function observe(line) {
	const safeLine = redact(line);
	output.push(safeLine);
	let value;
	try { value = JSON.parse(line); } catch { return; }
	if (findErrorMarker(value)) intentionalErrorSeen = true;
	const assistantContent = value.type === "message_end" && value.message?.role === "assistant"
		? (value.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" ")
		: "";
	if (answered >= 3 && /DONE/.test(assistantContent)) finalDoneSeen = true;
}

function waitFor(predicate, timeoutMs, label) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (failure) return reject(failure);
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

async function respond(request) {
	const base = { id: request.id };
	let response;
	if (request.tool === "sub_spawn") {
		response = { ...base, ok: true, text: "started w99" };
	} else if (request.tool === "sub_wait") {
		response = { ...base, ok: true, text: "w99 done: wrote hello.txt; no warnings" };
	} else if (request.tool === "sub_status") {
		intentionalErrorSeen = false;
		response = { ...base, ok: false, text: "intentional manager bridge error" };
	} else {
		response = { ...base, ok: false, text: `unexpected tool ${request.tool}` };
	}
	const target = path.join(resDir, `${request.id}.json`);
	const temp = `${target}.tmp`;
	await writeFile(temp, `${JSON.stringify(response)}\n`, "utf8");
	await rename(temp, target);
	answered += 1;
}

async function responder() {
	const handled = new Set();
	while (!stopping) {
		try {
			for (const name of await readdir(reqDir)) {
				if (!name.endsWith(".json") || name.endsWith(".json.tmp") || handled.has(name)) continue;
				handled.add(name);
				const requestPath = path.join(reqDir, name);
				const request = JSON.parse(await readFile(requestPath, "utf8"));
				await rm(requestPath, { force: true });
				requests.push(request);
				await respond(request);
			}
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			return;
		}
		await sleep(100);
	}
}

async function findTmpFiles(dir) {
	const found = [];
	for (const name of await readdir(dir, { withFileTypes: true })) {
		const item = path.join(dir, name.name);
		if (name.isDirectory()) found.push(...await findTmpFiles(item));
		else if (name.name.endsWith(".tmp")) found.push(item);
	}
	return found;
}

try {
	await mkdir(sessionDir);
	await mkdir(reqDir, { recursive: true });
	await mkdir(resDir, { recursive: true });
	const envText = await readFile(envFile, "utf8");
	const keyLine = envText.split(/\r?\n/).find((line) => /^\s*(?:export\s+)?OPENCODE_GO_API_KEY\s*=/.test(line));
	assert.ok(keyLine, `OPENCODE_GO_API_KEY was not found in ${envFile}`);
	secret = keyLine.replace(/^\s*(?:export\s+)?OPENCODE_GO_API_KEY\s*=\s*/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
	assert.ok(secret, "OPENCODE_GO_API_KEY is empty");

	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: path.join(os.homedir(), ".pi-workers"),
		PI_MGR_DIR: managerDir,
		OPENCODE_GO_API_KEY: secret,
	};
	child = spawn("pi", [
		"--mode", "rpc", "-e", extension, "--offline", "-ne", "-ns", "-np", "-nc", "-na",
		"--session-dir", sessionDir, "--model", "opencode-go/deepseek-v4.1-flash", "--thinking", "off",
	], { stdio: ["pipe", "pipe", "pipe"], env });
	readline.createInterface({ input: child.stdout }).on("line", observe);
	readline.createInterface({ input: child.stderr }).on("line", (line) => output.push(`[stderr] ${redact(line)}`));
	child.on("error", (error) => { failure = new Error(`Pi spawn error: ${error.message}`); });
	responderTask = responder();

	child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Call sub_spawn with task 'write hello', then sub_wait for w99, then sub_status, then reply DONE." })}\n`);
	await waitFor(() => requests.length >= 3 && finalDoneSeen, 240_000, "the three manager tools and final DONE reply");

	assert.deepEqual(requests.slice(0, 3).map((request) => request.tool), ["sub_spawn", "sub_wait", "sub_status"]);
	assert.equal(typeof requests[0].args?.task, "string");
	assert.match(requests[0].args.task, /write hello/i);
	assert.ok(requests[1].args?.ids?.includes("w99"), `sub_wait did not target w99: ${JSON.stringify(requests[1].args)}`);
	assert.deepEqual(requests[2].args, {});
	assert.ok(intentionalErrorSeen || output.some((line) => /intentional manager bridge error/.test(line) && /isError|is_error/i.test(line)), "ok:false response was not surfaced as a tool error");
	assert.ok(output.some((line) => /intentional manager bridge error/.test(line)), "the bridge error text was not surfaced to Pi");
	assert.deepEqual(await findTmpFiles(managerDir), [], "stray bridge .tmp files remain");
	console.log("PASS: sub_spawn, sub_wait, and sub_status requests carried the expected tools and arguments");
	console.log("PASS: model completed after bridge responses and replied DONE");
	console.log("PASS: ok:false was surfaced as a tool error without crashing Pi");
	console.log("PASS: no stray bridge .tmp files remain");
} catch (error) {
	console.error(redact(error instanceof Error ? error.message : String(error)));
	console.error("Pi output (last 40 lines):");
	for (const line of output.slice(-40)) console.error(redact(line));
	process.exitCode = 1;
} finally {
	stopping = true;
	if (responderTask) await responderTask;
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
