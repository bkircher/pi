import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("AgentSession codemode worker settings", () => {
	let first: Harness | undefined;
	let second: Harness | undefined;

	afterEach(() => {
		first?.cleanup();
		second?.cleanup();
		first = undefined;
		second = undefined;
		vi.unstubAllEnvs();
	});

	it.each([
		{ env: undefined, blocked: true, output: expect.stringContaining("while waiting for a free codemode worker") },
		{ env: "2", blocked: false, output: "2" },
	])("shares the user limit across sessions with PI_CODEMODE_MAX_WORKERS=$env", async ({ env, blocked, output }) => {
		vi.stubEnv("PI_CODEMODE_MAX_WORKERS", env);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		first = await createHarness({
			settings: { codemode: { maxWorkers: 1 } },
			initialActiveToolNames: ["codemode", "hold"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool({
						name: "hold",
						label: "Hold",
						description: "Wait for release.",
						parameters: Type.Object({}),
						execute: async () => {
							entered.resolve();
							await release.promise;
							return { content: [{ type: "text", text: "released" }], details: undefined };
						},
					});
				},
			],
		});
		second = await createHarness({
			settings: { codemode: { maxWorkers: 1 } },
			initialActiveToolNames: ["codemode"],
			extensionFactories: [createCodemodeExtension()],
		});
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.hold({}); return 1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		second.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: '// @options: {"timeout_ms": 1000}\nreturn 2' })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const firstPrompt = first.session.prompt("Hold one worker.");
		try {
			await entered.promise;
			await second.session.prompt("Run another script.");

			const result = getToolResult(second, "codemode");
			expect(result.isError).toBe(blocked);
			expect(result.content).toContainEqual({ type: "text", text: output });
		} finally {
			release.resolve();
			await firstPrompt;
		}
		expect(getToolResult(first, "codemode").isError).toBe(false);
	});
});
