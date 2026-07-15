import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];

function writeChildScript(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-exit-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("RpcClient child process lifecycle", () => {
	test("rejects an in-flight request when the child process exits", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", () => {
	process.exit(43);
});
process.stdin.resume();
`),
		});

		await client.start();

		await expect(client.getCommands()).rejects.toThrow(/Agent process exited \(code=43 signal=null\)/);
	});

	test("can restart after the child exits following graceful shutdown", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.stdin.once("data", (data) => {
	const command = JSON.parse(data.toString());
	process.stdout.write(JSON.stringify({
		id: command.id,
		type: "response",
		command: "shutdown",
		success: true,
	}) + "\\n", () => process.exit(0));
});
process.stdin.resume();
`),
		});
		await client.start();

		await client.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 100));

		await expect(client.start()).resolves.toBeUndefined();
		await client.stop();
	});

	test("does not signal a child completing graceful shutdown", async () => {
		const client = new RpcClient({
			cliPath: writeChildScript(`
process.on("SIGTERM", () => {
	process.stderr.write("unexpected SIGTERM\\n");
});
process.stdin.once("data", (data) => {
	const command = JSON.parse(data.toString());
	process.stdout.write(JSON.stringify({
		id: command.id,
		type: "response",
		command: "shutdown",
		success: true,
	}) + "\\n");
	setTimeout(() => process.exit(0), 100);
});
process.stdin.resume();
`),
		});
		await client.start();

		await client.shutdown();
		await client.stop();

		expect(client.getStderr()).not.toContain("unexpected SIGTERM");
	});
});
