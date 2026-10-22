import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";

function createSettings(global: Record<string, unknown>, project: Record<string, unknown> = {}) {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	storage.withLock("project", () => JSON.stringify(project));
	return { storage, manager: SettingsManager.fromStorage(storage) };
}

describe("codemode.maxWorkers settings", () => {
	it.each([
		{ global: {}, expected: { mode: "only", inlineBudget: 100 } },
		{
			global: { codemode: { maxWorkers: 3, mode: "on", inlineBudget: 200 } },
			expected: { maxWorkers: 3, mode: "only", inlineBudget: 100 },
		},
	])("ignores the project worker limit while merging other codemode settings: $global", ({ global, expected }) => {
		const project = { codemode: { maxWorkers: 9, mode: "only", inlineBudget: 100 } };
		const { manager } = createSettings(global, project);

		const settings = manager.getSettings();

		expect(settings.codemode).toEqual(expected);
		expect(manager.getGlobalSettings()).toEqual(global);
		expect(manager.getProjectSettings()).toEqual(project);
	});

	it.each([null, false, 4, "invalid", []])("keeps the user limit when project codemode is %j", (codemode) => {
		const { manager } = createSettings({ codemode: { maxWorkers: 3 } }, { codemode });

		const settings = manager.getSettings();

		expect(settings.codemode).toEqual({ maxWorkers: 3 });
	});

	it("reads the user limit from in-memory settings", () => {
		const manager = SettingsManager.inMemory({ codemode: { maxWorkers: 4 } });

		const settings = manager.getSettings();

		expect(settings.codemode?.maxWorkers).toBe(4);
	});

	it("does not let session overrides change the user-only limit", () => {
		const manager = SettingsManager.inMemory({ codemode: { maxWorkers: 3 } });

		manager.applyOverrides({ codemode: { maxWorkers: 9, mode: "only" } });

		expect(manager.getSettings().codemode).toEqual({ maxWorkers: 3, mode: "only" });
	});

	it("returns a copy without changing stored settings", () => {
		const manager = SettingsManager.inMemory({ codemode: { maxWorkers: 3 } });

		const settings = manager.getSettings();
		settings.codemode!.maxWorkers = 9;

		expect(manager.getSettings().codemode?.maxWorkers).toBe(3);
		expect(manager.getGlobalSettings().codemode?.maxWorkers).toBe(3);
	});

	it("uses a changed user limit after reload", async () => {
		const { manager, storage } = createSettings(
			{ codemode: { maxWorkers: 3 } },
			{ codemode: { maxWorkers: 9, mode: "only" } },
		);
		storage.withLock("global", () => JSON.stringify({ codemode: { maxWorkers: 4 } }));

		await manager.reload();

		expect(manager.getSettings().codemode).toEqual({ maxWorkers: 4, mode: "only" });
	});

	it("does not use the project limit after the user limit is removed", async () => {
		const { manager, storage } = createSettings(
			{ codemode: { maxWorkers: 3 } },
			{ codemode: { maxWorkers: 9, mode: "only" } },
		);
		storage.withLock("global", () => "{}");

		await manager.reload();

		expect(manager.getSettings().codemode).toEqual({ mode: "only" });
	});

	it("ignores the project limit after project trust changes", () => {
		const { manager } = createSettings({ codemode: { maxWorkers: 3 } }, { codemode: { maxWorkers: 9 } });
		manager.setProjectTrusted(false);

		manager.setProjectTrusted(true);

		expect(manager.getSettings().codemode?.maxWorkers).toBe(3);
	});
});

describe("codemode.maxWorkers schema", () => {
	const validator = Compile(SettingsSchema);

	it.each([1, 2, 3, 9007199254740991])("accepts %s", (maxWorkers) => {
		const settings = { codemode: { maxWorkers } };

		const valid = validator.Check(settings);

		expect(valid).toBe(true);
	});

	it.each([0, -1, 1.5, 9007199254740992, "3", null, false, [], {}])("rejects %j", (maxWorkers) => {
		const settings = { codemode: { maxWorkers } };

		const valid = validator.Check(settings);

		expect(valid).toBe(false);
	});

	it("publishes the default of two workers", () => {
		expect(SettingsSchema.properties.codemode.properties.maxWorkers).toMatchObject({ default: 2 });
	});
});
