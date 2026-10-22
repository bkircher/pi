import { Worker } from "node:worker_threads";
import * as codemode from "@earendil-works/pi-codemode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCodemode } from "../src/extensions/codemode/execute.ts";

const terminate = Worker.prototype.terminate;
const terminations = new Map<Worker, (code: number) => void>();

beforeEach(() => {
	vi.stubEnv("PI_CODEMODE_MAX_WORKERS", undefined);
	vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
		this.ref();
		return new Promise<number>((resolve) => {
			terminations.set(this, resolve);
		});
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await Promise.all(
		[...terminations].map(async ([worker, resolve]) => {
			resolve(await terminate.call(worker));
		}),
	);
	terminations.clear();
});

const run = (code: string, signal?: AbortSignal, maxWorkers?: number) =>
	executeCodemode("worker-admission", { code }, signal, undefined, undefined, { getMaxWorkers: () => maxWorkers });

/** Let the first held worker actually exit. */
async function releaseOne(): Promise<void> {
	const [worker, resolve] = [...terminations][0];
	terminations.delete(worker);
	resolve(await terminate.call(worker));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("codemode worker admission", () => {
	// #10748: fresh sandboxes must share capacity and retain it until actual worker exit.
	it.each(["timeout", "abort", "success"] as const)("bounds surviving workers after %s", async (how) => {
		const once = vi.spyOn(Worker.prototype, "once");
		for (let i = 0; i < 2; i++) {
			const controller = new AbortController();
			const exitListenersBefore = once.mock.calls.filter(([event]) => event === "exit").length;
			const pending = run(
				how === "timeout"
					? '// @options: {"timeout_ms": 200}\nwhile (true) {}'
					: how === "abort"
						? "while (true) {}"
						: "return 1",
				controller.signal,
			);
			if (how === "abort") {
				await vi.waitFor(() =>
					expect(once.mock.calls.filter(([event]) => event === "exit").length).toBeGreaterThan(
						exitListenersBefore,
					),
				);
				controller.abort();
			}
			const result = await pending;
			if (how === "success") expect(result.isError).toBeUndefined();
			else {
				expect(result.isError).toBe(true);
				expect(result.content).toContainEqual({
					type: "text",
					text: expect.stringContaining(how === "timeout" ? "Script timed out:" : "Script aborted:"),
				});
			}
			expect(terminations.size).toBe(i + 1);
		}

		// #11184: at capacity, a script waits for a worker instead of failing.
		let waitingSettled = false;
		const waiting = run("return 3").finally(() => {
			waitingSettled = true;
		});

		const abortWhileWaiting = new AbortController();
		const aborted = run("while (true) {}", abortWhileWaiting.signal);
		await sleep(50);
		abortWhileWaiting.abort();
		const abortedResult = await aborted;
		expect(abortedResult.isError).toBe(true);
		expect(abortedResult.content).toContainEqual({
			type: "text",
			text: expect.stringMatching(/Script aborted:[\s\S]*The script did not start\./),
		});

		const timedOut = await run('// @options: {"timeout_ms": 50}\nreturn 1');
		expect(timedOut.isError).toBe(true);
		expect(timedOut.content).toContainEqual({
			type: "text",
			text: expect.stringContaining("Execution timed out after 50 ms while waiting for a free codemode worker"),
		});

		expect(waitingSettled).toBe(false);
		expect(terminations.size).toBe(2);

		// Releasing one actual worker, not its result, admits exactly the waiting script.
		await releaseOne();
		const admitted = await waiting;
		expect(admitted.isError).toBeUndefined();
		expect(admitted.content).toContainEqual({ type: "text", text: "3" });
		expect(terminations.size).toBe(2);
	});

	// #10748: timed-out launches resuming after WASM loading must not start workers.
	it("starts no worker for a launch that resumes after its result timed out", async () => {
		const wasm = await codemode.loadQuickJSWasm();
		const loading = Promise.withResolvers<codemode.CodemodeWasmModule>();
		vi.spyOn(codemode, "loadQuickJSWasm").mockReturnValue(loading.promise);
		try {
			const results = await Promise.all(
				Array.from({ length: 3 }, () => run('// @options: {"timeout_ms": 20}\nwhile (true) {}')),
			);
			expect(results.every((result) => result.isError)).toBe(true);
			expect(terminations.size).toBe(0);
			loading.resolve(wasm);
			expect((await run("return 1")).isError).toBeUndefined();
			// Only the last script's worker started.
			expect(terminations.size).toBe(1);
		} finally {
			loading.resolve(wasm);
		}
	});

	// #10748, #11184: a concurrent burst runs two workers at a time and queues the rest.
	it("queues a concurrent burst behind two workers", async () => {
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 6 }, () => run("return 1").then((result) => results.push(result)));
		for (let released = 0; released < 4; released++) {
			await vi.waitFor(() => {
				expect(terminations.size).toBe(2);
				expect(results).toHaveLength(released + 2);
			});
			await sleep(50);
			expect(results).toHaveLength(released + 2);
			await releaseOne();
		}
		await Promise.all(pending);
		expect(results.every((result) => result.isError === undefined)).toBe(true);
		expect(terminations.size).toBe(2);
	});

	// #11184: in-process hosts with many sessions can raise the limit.
	it("reads the limit from PI_CODEMODE_MAX_WORKERS", async () => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", "3");
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 4 }, () => run("return 1").then((result) => results.push(result)));
		await vi.waitFor(() => expect(results).toHaveLength(3));
		await sleep(50);
		expect(results).toHaveLength(3);
		expect(terminations.size).toBe(3);
		await releaseOne();
		await Promise.all(pending);
		expect(results.every((result) => result.isError === undefined)).toBe(true);
	});

	it.each([
		{ source: "user settings", maxWorkers: 3, env: undefined },
		{ source: "the environment instead of user settings", maxWorkers: 1, env: "3" },
		{ source: "user settings when the environment value is invalid", maxWorkers: 3, env: "0" },
	])("reads the worker limit from $source", async ({ maxWorkers, env }) => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", env);
		const results: Awaited<ReturnType<typeof run>>[] = [];

		const pending = [
			run("return 1", undefined, maxWorkers).then((result) => results.push(result)),
			run("return 2", undefined, maxWorkers).then((result) => results.push(result)),
			run("return 3", undefined, maxWorkers).then((result) => results.push(result)),
			run("return 4", undefined, maxWorkers).then((result) => results.push(result)),
		];
		await vi.waitFor(() => expect(results).toHaveLength(3));

		expect(terminations.size).toBe(3);
		await releaseOne();
		await Promise.all(pending);
		expect(results).toHaveLength(4);
		expect(results.every((result) => result.isError === undefined)).toBe(true);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9007199254740992, "3", null])(
		"uses two workers for an invalid setting: %s",
		async (maxWorkers) => {
			const results: Awaited<ReturnType<typeof run>>[] = [];

			const pending = [
				run("return 1", undefined, maxWorkers as number).then((result) => results.push(result)),
				run("return 2", undefined, maxWorkers as number).then((result) => results.push(result)),
			];
			await Promise.all(pending);
			const blocked = await run('// @options: {"timeout_ms": 50}\nreturn 3', undefined, maxWorkers as number);

			expect(results).toHaveLength(2);
			expect(results.every((result) => result.isError === undefined)).toBe(true);
			expect(terminations.size).toBe(2);
			expect(blocked.isError).toBe(true);
			expect(blocked.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("while waiting for a free codemode worker"),
			});
		},
	);

	it("ignores an invalid PI_CODEMODE_MAX_WORKERS", async () => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", "0");
		const results: Awaited<ReturnType<typeof run>>[] = [];
		const pending = Array.from({ length: 3 }, () => run("return 1").then((result) => results.push(result)));
		await vi.waitFor(() => expect(results).toHaveLength(2));
		await sleep(50);
		expect(results).toHaveLength(2);
		await releaseOne();
		await Promise.all(pending);
	});
});
