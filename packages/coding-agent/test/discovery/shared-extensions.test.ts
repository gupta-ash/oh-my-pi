import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionModule, extensionModuleCapability } from "@oh-my-pi/pi-coding-agent/capability/extension-module";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getCapability, initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

const ENV_KEYS = ["HOME", "USERPROFILE", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"] as const;

function extensionSource(name: string): string {
	return `export default pi => {
		pi.registerTool({
			name: ${JSON.stringify(name)}, label: "Fixture", description: "Discovery fixture",
			parameters: pi.typebox.Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
	};`;
}

describe("profile-independent shared extension modules", () => {
	let root: string;
	let home: string;
	let project: string;
	let sharedPath: string;
	let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(async () => {
		__closeExtensionParseCacheForTests();
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) as typeof savedEnv;
		for (const key of ENV_KEYS) delete process.env[key];
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-extensions-"));
		home = path.join(root, "home");
		project = path.join(root, "project");
		sharedPath = path.join(home, ".omp", "shared", "extensions", "shared-tool", "index.ts");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		__resetDirsFromEnvForTests();
		resetSettingsForTest();
		clearFsCache();
		clearClaudePluginRootsCache();
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await Bun.write(sharedPath, extensionSource("shared_tool"));
		await Bun.write(path.join(home, ".omp", "agent", "extensions", "default.ts"), extensionSource("default_tool"));
		await Bun.write(
			path.join(home, ".omp", "profiles", "private", "agent", "extensions", "private.ts"),
			extensionSource("private_tool"),
		);
		await Bun.write(path.join(project, ".omp", "extensions", "project.ts"), extensionSource("project_tool"));
		initializeWithSettings(await Settings.init({ inMemory: true, cwd: project }));
	});

	afterEach(async () => {
		__closeExtensionParseCacheForTests();
		resetSettingsForTest();
		clearFsCache();
		clearClaudePluginRootsCache();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	for (const profile of ["default", "private", "future-profile", "agent-override"]) {
		test(`loads shared tools once with isolated ${profile} extensions`, async () => {
			if (profile === "agent-override") {
				process.env.PI_CODING_AGENT_DIR = path.join(root, "custom-agent");
				await Bun.write(
					path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "override.ts"),
					extensionSource("override_tool"),
				);
			} else {
				process.env.OMP_PROFILE = profile;
			}
			__resetDirsFromEnvForTests();
			const result = await discoverAndLoadExtensions([], project);
			expect(result.errors).toEqual([]);
			expect(result.extensions.filter(extension => extension.path === sharedPath)).toHaveLength(1);
			const privateTools =
				profile === "default"
					? ["default_tool"]
					: profile === "private"
						? ["private_tool"]
						: profile === "agent-override"
							? ["override_tool"]
							: [];
			expect(result.extensions.flatMap(extension => [...extension.tools.keys()]).sort()).toEqual(
				["project_tool", "shared_tool", ...privateTools].sort(),
			);
		});
	}

	test("deduplicates an explicitly configured shared entry", async () => {
		const result = await discoverAndLoadExtensions([sharedPath], project);
		expect(result.errors).toEqual([]);
		expect(result.extensions.filter(extension => extension.path === sharedPath)).toHaveLength(1);
	});

	test("shared modules retain disabled and explicit-only discovery semantics", async () => {
		const disabled = await discoverAndLoadExtensions([], project, undefined, ["extension-module:shared-tool"]);
		expect(disabled.errors).toEqual([]);
		expect(disabled.extensions.some(extension => extension.path === sharedPath)).toBe(false);
		const explicitOnly = await discoverAndLoadExtensions([], project, undefined, undefined, { ambient: false });
		expect(explicitOnly.errors).toEqual([]);
		expect(explicitOnly.extensions).toEqual([]);
	});

	test("uses discovery home rather than the active agent directory for the shared root", async () => {
		const discoveryHome = path.join(root, "discovery-home");
		const discoveryPath = path.join(discoveryHome, ".omp", "shared", "extensions", "context.ts");
		await Bun.write(discoveryPath, extensionSource("context_tool"));
		const provider = getCapability<ExtensionModule>(extensionModuleCapability.id)?.providers.find(
			candidate => candidate.id === "native",
		);
		expect(provider).toBeDefined();
		if (!provider) throw new Error("Native extension provider is not registered");
		const result = await provider.load({
			cwd: project,
			home: discoveryHome,
			agentDir: path.join(root, "absent-agent"),
			repoRoot: project,
		});
		expect(result.items.map(item => item.path).sort()).toEqual(
			[discoveryPath, path.join(project, ".omp", "extensions", "project.ts")].sort(),
		);
		expect(result.items.find(item => item.path === discoveryPath)).toMatchObject({
			level: "user",
			_source: { provider: "native", level: "user", path: discoveryPath },
		});
	});
});
