import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi-mono/issues/6591

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	order: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {
		rpcIo.order.push("flush");
	}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {
		rpcIo.order.push("backpressure");
	}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.order.push("response");
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness, dispose?: () => Promise<void>): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(
			dispose ??
				(async () => {
					rpcIo.order.push("dispose");
				}),
		),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC shutdown (#6591)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		rpcIo.outputLines = [];
		rpcIo.order = [];
		rpcIo.lineHandler = undefined;
	});

	test("acknowledges shutdown before disposing, flushing, and exiting successfully", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
			rpcIo.order.push(`exit:${code}`);
			return undefined as never;
		});

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "req-1", type: "shutdown" }));
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));

			expect(parseOutputLines()).toEqual([{ id: "req-1", type: "response", command: "shutdown", success: true }]);
			expect(rpcIo.order).toEqual(["response", "backpressure", "dispose", "flush", "exit:0"]);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("exits without a second response when disposal fails after accepting shutdown", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		const dispose = vi.fn(async () => {
			rpcIo.order.push("dispose");
			throw new Error("dispose failed");
		});
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
			rpcIo.order.push(`exit:${code}`);
			return undefined as never;
		});

		try {
			void runRpcMode(createRuntimeHost(harness, dispose));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "req-1", type: "shutdown" }));
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));

			expect(parseOutputLines()).toEqual([{ id: "req-1", type: "response", command: "shutdown", success: true }]);
			expect(rpcIo.order).toEqual(["response", "backpressure", "dispose", "flush", "exit:0"]);
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("waits for one graceful disposal when shutdown commands are pipelined", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		let finishDispose!: () => void;
		const disposeBlocked = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const dispose = vi.fn(async () => {
			await disposeBlocked;
		});
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const processExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		try {
			void runRpcMode(createRuntimeHost(harness, dispose));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "req-1", type: "shutdown" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "req-2", type: "shutdown" }));
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

			expect(parseOutputLines()).toEqual([
				{ id: "req-1", type: "response", command: "shutdown", success: true },
				{ id: "req-2", type: "response", command: "shutdown", success: true },
			]);
			expect(processExit).not.toHaveBeenCalled();

			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledTimes(1));
			expect(processExit).toHaveBeenCalledWith(0);
		} finally {
			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("rejects commands received after shutdown is accepted", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		let finishDispose!: () => void;
		const disposeBlocked = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const dispose = vi.fn(async () => {
			await disposeBlocked;
		});
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const processExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		try {
			void runRpcMode(createRuntimeHost(harness, dispose));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "req-1", type: "shutdown" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "req-2", type: "get_state" }));
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

			expect(parseOutputLines()).toEqual([
				{ id: "req-1", type: "response", command: "shutdown", success: true },
				{
					id: "req-2",
					type: "response",
					command: "get_state",
					success: false,
					error: "Shutdown in progress",
				},
			]);
			expect(processExit).not.toHaveBeenCalled();

			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
		} finally {
			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("lets an accepted shutdown finish when stdin ends", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();
		let finishDispose!: () => void;
		const disposeBlocked = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		const dispose = vi.fn(async () => {
			await disposeBlocked;
		});
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		const processExit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		try {
			void runRpcMode(createRuntimeHost(harness, dispose));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			const inputEndHandler = (process.stdin.listeners("end") as NodeListener[]).find(
				(listener) => !listenerSnapshot.stdinEnd.includes(listener),
			);
			expect(inputEndHandler).toBeDefined();

			rpcIo.lineHandler?.(JSON.stringify({ id: "req-1", type: "shutdown" }));
			inputEndHandler?.();
			await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

			expect(parseOutputLines()).toEqual([{ id: "req-1", type: "response", command: "shutdown", success: true }]);
			expect(processExit).not.toHaveBeenCalled();

			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
		} finally {
			finishDispose();
			await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
