import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AdapterEvent, AdapterRunContext, AdapterRunResult } from "../src/adapters/types.js";
import type {
  JsonValue,
  ObservedIdentity,
  ResolvedRoute,
  RouteDescriptor,
  WorkspaceEffect,
} from "../src/contract.js";

import { CLAUDE_SESSION_ENVIRONMENT_DENY_LIST, ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { parseVersion, satisfiesVersionRange } from "../src/adapters/discovery.js";
import { FakeProcessAdapter } from "../src/adapters/fake-process.js";
import { type CommandSpec, ContentAccumulator, ProcessAdapter } from "../src/adapters/process.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { createHarnessConnection, writeUserConnections } from "../src/connections.js";

const route = (adapter: string, executable: string): ResolvedRoute => ({
  routeId: `${adapter}:test`,
  executable,
  adapter,
  harnessVersion: "1.0.0",
  authenticationMode: "test",
  provider: "test",
  model: "test-model",
  via: adapter,
  capabilities: ["core.input.text"],
  qualification: [],
});

const request = (workingDirectory: string): AdapterRunContext["request"] => ({
  selector: { provider: "test", model: "test-model", requiredCapabilities: [] },
  input: [{ type: "text", text: "hello" }],
  workingDirectory,
  interactionStrategy: "deny",
  requestedPolicy: { minimumAssurance: "none" },
});

class TestProcessAdapter extends ProcessAdapter {
  readonly id = "test-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(_context: AdapterRunContext): CommandSpec {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}})); console.log(JSON.stringify({type:'result',status:'completed'}))",
      ],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: { add: (text: string) => void } },
  ): AdapterEvent {
    if (value.type === "result") {
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    const text =
      typeof value.message === "object" &&
      value.message !== null &&
      "content" in value.message &&
      Array.isArray(value.message.content) &&
      typeof value.message.content[0] === "object" &&
      value.message.content[0] !== null &&
      "text" in value.message.content[0] &&
      typeof value.message.content[0].text === "string"
        ? value.message.content[0].text
        : "";
    state.content.add(text);
    return { category: "output", content: [{ type: "text", text }], native: value };
  }
}

class StdinProcessAdapter extends ProcessAdapter {
  readonly id = "stdin-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(): CommandSpec {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => { console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:s}]},env:process.env.TEST_DENIED ?? null})); console.log(JSON.stringify({type:'result',status:'completed'})); })",
      ],
      stdin: "prompt from stdin",
      env: { TEST_DENIED: "must-not-leak" },
      envDenyList: ["TEST_DENIED"],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: { add: (text: string) => void } },
  ): AdapterEvent {
    if (value.type === "result") {
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    const message = value.message as { content?: ReadonlyArray<{ text?: unknown }> };
    const text = typeof message.content?.[0]?.text === "string" ? message.content[0].text : "";
    state.content.add(text);
    return { category: "output", content: [{ type: "text", text }], native: value };
  }
}

class EnvironmentEchoProcessAdapter extends ProcessAdapter {
  readonly id = "environment-echo-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(): CommandSpec {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'assistant',seen:Object.keys(process.env).filter(key => key.startsWith('HARNESS_RELAY_') || key.startsWith('AGENT_BRIDGE_')).sort(),control:process.env.CONTROL_MARKER ?? null})); console.log(JSON.stringify({type:'result',status:'completed'}))",
      ],
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: { add: (text: string) => void } },
  ): AdapterEvent {
    if (value.type === "result") {
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    const seen = Array.isArray(value.seen) ? value.seen.join(",") : "";
    state.content.add(seen);
    return { category: "output", content: [{ type: "text", text: seen }], native: value };
  }
}

class InteractiveProcessAdapter extends ProcessAdapter {
  readonly id = "interactive-process";

  async discover(): Promise<readonly RouteDescriptor[]> {
    return [];
  }

  protected command(): CommandSpec {
    const script = [
      "process.stdin.setEncoding('utf8');",
      "let input = '';",
      "process.stdin.on('data', chunk => { input += chunk; if (input.includes('control_response')) {",
      "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'approved'}]}})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'result',result:'approved'})+'\\n');",
      "process.exit(0); } });",
      "process.stdout.write(JSON.stringify({type:'control_request',request_id:'perm_1',request:{subtype:'can_use_tool',tool_name:'Write',message:'Allow Write?'}})+'\\n');",
    ].join(" ");
    return {
      executable: process.execPath,
      args: ["-e", script],
      stdin: "initial input\\n",
      keepStdinOpen: true,
    };
  }

  protected normalizeNative(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined {
    if (value.type === "control_request") {
      return {
        category: "input_required",
        inputRequest: {
          requestId: "perm_1",
          kind: "permission",
          prompt: "Allow Write?",
          toolName: "Write",
        },
        native: value,
      };
    }
    if (value.type === "assistant") {
      state.content.add("approved");
      return { category: "output", content: [{ type: "text", text: "approved" }], native: value };
    }
    if (value.type === "result") {
      state.content.setFinal("approved");
      return { category: "lifecycle", data: { state: "native_result" }, native: value };
    }
    return undefined;
  }
}

class InspectableClaudeAdapter extends ClaudeAdapter {
  normalize(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined {
    return this.normalizeNative(value, state);
  }

  commandFor(context: AdapterRunContext): CommandSpec {
    return this.command(context);
  }
}

class FailingClaudeProcessAdapter extends ClaudeAdapter {
  protected command(): CommandSpec {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial answer'}]}})); console.log(JSON.stringify({type:'result',is_error:true,subtype:'error_max_turns',result:'native failure'}))",
      ],
    };
  }
}

class InspectableCodexAdapter extends CodexAdapter {
  normalize(
    value: Record<string, JsonValue>,
    state: { identity: ObservedIdentity; content: ContentAccumulator },
  ): AdapterEvent | undefined {
    return this.normalizeNative(value, state);
  }

  commandFor(context: AdapterRunContext): CommandSpec {
    return this.command(context);
  }
}

function nativeState(): {
  identity: ObservedIdentity;
  content: ContentAccumulator;
  pendingEffects: Map<string, WorkspaceEffect>;
} {
  return {
    identity: {
      provider: { evidence: "unverified" },
      model: { evidence: "unverified" },
      harnessVersion: { evidence: "unverified" },
      nativeSessionId: { evidence: "unverified" },
    },
    content: new ContentAccumulator(),
    pendingEffects: new Map(),
  };
}

test("route discovery reports qualified and authenticated command routes", async () => {
  const claude = new ClaudeAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "2.1.235 (Claude Code)",
      checkAuthentication: async () => true,
    },
  });
  const routes = await claude.discover();
  assert.equal(routes.length, 7);
  assert.ok(routes.every((candidate) => candidate.readiness === "ready"));
  assert.ok(routes.every((candidate) => candidate.executable === process.execPath));
  assert.ok(routes.every((candidate) => candidate.qualification.length === 1));
  const opusAlias = routes.find((candidate) => candidate.model === "opus");
  assert.equal(opusAlias?.canonicalModel, "claude-opus-4-8");
  assert.equal(opusAlias?.qualification[0]?.testedAt, "2026-09-05T22:04:14+02:00");
  assert.match(opusAlias?.qualification[0]?.claim ?? "", /test\/adapters\.test\.ts/);
  assert.match(
    opusAlias?.qualification[0]?.claim ?? "",
    /verifies route discovery, command argument construction/,
  );
  assert.doesNotMatch(opusAlias?.qualification[0]?.claim ?? "", /exercised native model/);
  const haiku = routes.find((candidate) => candidate.model === "claude-haiku-4-5-20251001");
  assert.equal(haiku?.canonicalModel, "claude-haiku-4-5-20251001");
});

test("Codex discovery exposes canonical model IDs and documented family aliases", async () => {
  const codex = new CodexAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "0.149.0 (Codex)",
      checkAuthentication: async () => true,
    },
  });
  const routes = await codex.discover();
  assert.equal(routes.length, 6);
  const alias = routes.find((candidate) => candidate.model === "gpt-5-codex");
  assert.equal(alias?.canonicalModel, "gpt-5.3-codex");
  assert.match(alias?.qualification[0]?.claim ?? "", /2473c44fc41befe82847287b13af53245c008a39/);
  assert.match(
    alias?.qualification[0]?.claim ?? "",
    /runtime model identity requires a separate opt-in/,
  );
});

test("named Claude discovery probes only the selected native configuration and exact version", async () => {
  const nativeContext = await mkdtemp(join(tmpdir(), "harness-relay-claude-context-"));
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fixture-inherited-api-key";
  try {
    let versionEnvironment: NodeJS.ProcessEnv | undefined;
    let authenticationEnvironment: NodeJS.ProcessEnv | undefined;
    let authenticationArguments: readonly string[] | undefined;
    const adapter = new InspectableClaudeAdapter({
      executable: process.execPath,
      probe: {
        async readVersion(_executable, _args, environment) {
          versionEnvironment = environment;
          return "2.1.282 (Claude Code)";
        },
        async checkAuthentication(_executable, args, environment) {
          authenticationArguments = args;
          authenticationEnvironment = environment;
          return true;
        },
      },
    });
    const connection = {
      id: "analysis",
      harness: "claude",
      nativeContextRef: nativeContext,
      revision: "revision-1",
    };
    const routes = await adapter.discoverConnection(connection);
    assert.ok(routes.every((candidate) => candidate.readiness === "ready"));
    assert.equal(versionEnvironment?.CLAUDE_CONFIG_DIR, nativeContext);
    assert.equal(authenticationEnvironment?.CLAUDE_CONFIG_DIR, nativeContext);
    assert.equal(versionEnvironment?.ANTHROPIC_API_KEY, undefined);
    assert.equal(authenticationEnvironment?.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(authenticationArguments, ["--setting-sources", "user", "auth", "status"]);

    const context = {
      invocationId: "inv_named_claude",
      request: request(process.cwd()),
      route: route("claude", process.execPath),
      connection,
      signal: new AbortController().signal,
      async emit(_event: AdapterEvent) {},
    };
    const namedCommand = adapter.commandFor(context);
    assert.equal(namedCommand.env?.CLAUDE_CONFIG_DIR, nativeContext);
    assert.deepEqual(namedCommand.args.slice(0, 2), ["--setting-sources", "user"]);
    assert.ok(namedCommand.envDenyList?.includes("ANTHROPIC_API_KEY"));
    const defaultContext: AdapterRunContext = {
      invocationId: context.invocationId,
      request: context.request,
      route: context.route,
      signal: context.signal,
      async emit(event) {
        await context.emit(event);
      },
    };
    assert.deepEqual(
      adapter.commandFor(defaultContext).envDenyList,
      CLAUDE_SESSION_ENVIRONMENT_DENY_LIST,
    );
    assert.equal(adapter.commandFor(defaultContext).args.includes("--setting-sources"), false);

    let authenticationCalls = 0;
    const oldVersion = new InspectableClaudeAdapter({
      executable: process.execPath,
      probe: {
        readVersion: async () => "2.1.281 (Claude Code)",
        async checkAuthentication() {
          authenticationCalls += 1;
          return true;
        },
      },
    });
    const unqualified = await oldVersion.discoverConnection(connection);
    assert.ok(unqualified.every((candidate) => candidate.readiness === "unqualified"));
    assert.ok(unqualified.every((candidate) => candidate.diagnostics[0]?.includes("2.1.282")));
    assert.equal(authenticationCalls, 0);

    await writeFile(
      join(nativeContext, "settings.json"),
      JSON.stringify({ apiKeyHelper: "/opt/fixture/auth-helper" }),
      "utf8",
    );
    let helperAuthenticationCalls = 0;
    const configuredHelper = new InspectableClaudeAdapter({
      executable: process.execPath,
      probe: {
        readVersion: async () => "2.1.282 (Claude Code)",
        async checkAuthentication() {
          helperAuthenticationCalls += 1;
          return true;
        },
      },
    });
    const helperRoutes = await configuredHelper.discoverConnection(connection);
    assert.ok(helperRoutes.every((candidate) => candidate.readiness === "unavailable"));
    assert.ok(
      helperRoutes.every((candidate) =>
        candidate.diagnostics.some((item) => item.includes("apiKeyHelper")),
      ),
    );
    assert.equal(helperAuthenticationCalls, 0);
    await assert.rejects(
      adapter.runConnection(context),
      (error: unknown) => error instanceof Error && error.message.includes("apiKeyHelper"),
    );
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    await rm(nativeContext, { recursive: true, force: true });
  }
});

test("Codex named contexts use native login, reject profiles, and redact overlapping paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-codex-context-"));
  const alphaHome = join(root, "account-alpha");
  const betaHome = join(root, "account-beta");
  const gammaHome = join(root, "account-gamma");
  const alphaWorkspace = join(root, "workspace-alpha");
  const gammaWorkspace = join(root, "workspace-gamma");
  const originalApiKey = process.env.CODEX_API_KEY;
  const originalProfile = process.env.CODEX_PROFILE;
  process.env.CODEX_API_KEY = "fixture-inherited-api-key";
  delete process.env.CODEX_PROFILE;
  try {
    await mkdir(join(alphaHome, "bin"), { recursive: true });
    await mkdir(betaHome);
    await mkdir(gammaHome);
    await mkdir(alphaWorkspace);
    await mkdir(gammaWorkspace);
    await writeFile(join(alphaHome, "auth.json"), "fixture-account-alpha", "utf8");
    await writeFile(join(gammaHome, "auth.json"), "fixture-account-gamma", "utf8");
    const executable = join(alphaHome, "bin", "codex-fixture");
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('codex-cli 0.155.1'); process.exit(0); }",
      "const home = process.env.CODEX_HOME;",
      "if (args[0] === 'login' && args[1] === 'status') { process.exit(process.env.CODEX_API_KEY || (home && fs.existsSync(path.join(home, 'auth.json'))) ? 0 : 1); }",
      "if (args[0] === 'exec' && home && !args.some((value, index) => value === 'model_provider=\"openai\"' && args[index - 1] === '-c')) { process.stderr.write('missing explicit native provider'); process.exit(9); }",
      "if (args[0] === 'exec') { let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { if (input.includes('fixture-failure')) { process.stderr.write(home || 'missing-context'); process.exit(1); } const account = process.env.CODEX_API_KEY || (home ? fs.readFileSync(path.join(home, 'auth.json'), 'utf8') : 'missing-context'); console.log(JSON.stringify({type:'item.completed', model:home, item:{type:'agent_message', text:account + '|' + home}})); console.log(JSON.stringify({type:'turn.completed', status:'completed'})); }); }",
    ].join("\n");
    await writeFile(executable, script, "utf8");
    await chmod(executable, 0o700);

    const adapter = new CodexAdapter({ executable });
    const connectionsPath = join(root, "connections.json");
    const catalogPath = join(root, "catalog.json");
    const alpha = createHarnessConnection({
      id: "alpha",
      harness: "codex",
      nativeContextRef: alphaHome,
      purpose: "analysis",
    });
    const beta = createHarnessConnection({
      id: "beta",
      harness: "codex",
      nativeContextRef: betaHome,
    });
    const gamma = createHarnessConnection({
      id: "gamma",
      harness: "codex",
      nativeContextRef: gammaHome,
      purpose: "review",
    });
    await writeUserConnections([alpha, beta, gamma], connectionsPath);

    const defaultRoutes = await adapter.discover();
    assert.ok(defaultRoutes.every((candidate) => candidate.readiness === "ready"));
    const registry = new AdapterRegistry([adapter], { connectionsPath, catalogPath });
    const betaRoutes = await registry.discover({ connectionId: "beta" });
    assert.ok(betaRoutes.every((candidate) => candidate.readiness === "unavailable"));
    assert.ok(betaRoutes.every((candidate) => !JSON.stringify(candidate).includes(betaHome)));
    assert.ok(betaRoutes.every((candidate) => !JSON.stringify(candidate).includes(alphaHome)));
    assert.ok(betaRoutes.every((candidate) => !JSON.stringify(candidate).includes(gammaHome)));

    const invocationRequest = {
      ...request(alphaWorkspace),
      selector: {
        provider: "openai",
        model: "gpt-5.5",
        via: "codex",
        connectionId: "alpha",
        requiredCapabilities: ["core.input.text"],
      },
    };
    const resolved = await registry.resolve(invocationRequest);
    assert.equal(resolved.descriptor.readiness, "ready");
    assert.ok(!JSON.stringify(resolved.descriptor).includes(alphaHome));
    assert.ok(!JSON.stringify(resolved.route).includes(alphaHome));
    assert.equal(resolved.connectionContext?.executable, executable);

    const gammaRequest = {
      ...request(gammaWorkspace),
      selector: {
        provider: "openai",
        model: "gpt-5.5",
        via: "codex",
        connectionId: "gamma",
        requiredCapabilities: ["core.input.text"],
      },
    };
    const gammaResolved = await registry.resolve(gammaRequest);
    assert.equal(gammaResolved.descriptor.readiness, "ready");
    assert.equal(gammaResolved.connectionContext?.id, "gamma");
    assert.equal(gammaResolved.connectionContext?.revision, gamma.revision);
    assert.equal(resolved.connectionContext?.id, "alpha");
    assert.equal(resolved.connectionContext?.revision, alpha.revision);

    const alphaEvents: AdapterEvent[] = [];
    const alphaRunContext = {
      invocationId: "inv_named_codex",
      request: invocationRequest,
      route: resolved.route,
      connection: resolved.connectionContext,
      signal: new AbortController().signal,
      async emit(event: AdapterEvent) {
        alphaEvents.push(event);
      },
    };
    const gammaEvents: AdapterEvent[] = [];
    const gammaRunContext = {
      invocationId: "inv_named_codex_gamma",
      request: gammaRequest,
      route: gammaResolved.route,
      connection: gammaResolved.connectionContext,
      signal: new AbortController().signal,
      async emit(event: AdapterEvent) {
        gammaEvents.push(event);
      },
    };
    const [alphaResult, gammaResult] = await Promise.all([
      adapter.runConnection(alphaRunContext),
      adapter.runConnection(gammaRunContext),
    ]);
    for (const [result, events, expected, forbidden] of [
      [alphaResult, alphaEvents, "fixture-account-alpha", "fixture-account-gamma"],
      [gammaResult, gammaEvents, "fixture-account-gamma", "fixture-account-alpha"],
    ] as const) {
      const answer = result.content[0];
      assert.equal(answer?.type, "text");
      if (answer?.type !== "text") {
        assert.fail("Codex fixture did not return text.");
      }
      assert.ok(answer.text.includes(expected));
      assert.ok(!answer.text.includes(forbidden));
      assert.match(answer.text, /\[redacted native context\]/);
      assert.equal(result.observedIdentity.model.evidence, "reported");
      assert.ok(!JSON.stringify([result, events]).includes(alphaHome));
      assert.ok(!JSON.stringify([result, events]).includes(gammaHome));
      assert.ok(JSON.stringify([result, events]).includes("[redacted native context]"));
    }

    await assert.rejects(
      adapter.runConnection({
        ...alphaRunContext,
        request: {
          ...invocationRequest,
          input: [{ type: "text", text: "fixture-failure" }],
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[redacted native context]") &&
        !error.message.includes(alphaHome),
    );

    await writeFile(join(betaHome, "config.toml"), '"model_provider" = "azure"\n', "utf8");
    const quotedProviderRoutes = await registry.discover({ connectionId: "beta" });
    assert.ok(quotedProviderRoutes.every((candidate) => candidate.readiness === "unavailable"));
    assert.ok(
      quotedProviderRoutes.every((candidate) =>
        candidate.diagnostics.some((item) => item.includes("model_provider")),
      ),
    );
    assert.ok(
      quotedProviderRoutes.every((candidate) => !JSON.stringify(candidate).includes(betaHome)),
    );

    await writeFile(
      join(betaHome, "config.toml"),
      '[model_providers.openai]\nbase_url = "https://fixture.invalid/v1"\n',
      "utf8",
    );
    const providerTableRoutes = await registry.discover({ connectionId: "beta" });
    assert.ok(providerTableRoutes.every((candidate) => candidate.readiness === "unavailable"));
    assert.ok(
      providerTableRoutes.every((candidate) =>
        candidate.diagnostics.some((item) => item.includes("model_providers")),
      ),
    );

    await writeFile(join(betaHome, "config.toml"), 'profile = "work"\n', "utf8");
    const profileRoutes = await registry.discover({ connectionId: "beta" });
    assert.ok(profileRoutes.every((candidate) => candidate.readiness === "unavailable"));
    assert.ok(
      profileRoutes.every((candidate) =>
        candidate.diagnostics.some((item) => item.includes("profile")),
      ),
    );
    assert.ok(profileRoutes.every((candidate) => !JSON.stringify(candidate).includes(betaHome)));

    await writeFile(join(gammaWorkspace, "config.toml"), '"model_provider" = "azure"\n', "utf8");
    await assert.rejects(
      adapter.runConnection(gammaRunContext),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("model_provider") &&
        !error.message.includes(gammaHome),
    );
    await rm(join(gammaWorkspace, "config.toml"));

    await mkdir(join(gammaWorkspace, ".codex"));
    await writeFile(
      join(gammaWorkspace, ".codex", "config.toml"),
      '[model_providers.openai]\nbase_url = "https://fixture.invalid/v1"\n',
      "utf8",
    );
    await assert.rejects(
      adapter.runConnection(gammaRunContext),
      (error: unknown) => error instanceof Error && error.message.includes("model_providers"),
    );
    await rm(join(gammaWorkspace, ".codex"), { recursive: true, force: true });

    const realWorkspace = join(root, "workspace-real");
    const realWorkspaceChild = join(realWorkspace, "child");
    const symlinkWorkspace = join(root, "workspace-alias");
    await mkdir(join(realWorkspace, ".codex"), { recursive: true });
    await mkdir(realWorkspaceChild, { recursive: true });
    await symlink(realWorkspaceChild, symlinkWorkspace, "dir");
    await writeFile(
      join(realWorkspace, ".codex", "config.toml"),
      '[model_providers.openai]\nbase_url = "https://fixture.invalid/v1"\n',
      "utf8",
    );
    await assert.rejects(
      adapter.runConnection({
        ...gammaRunContext,
        request: { ...gammaRequest, workingDirectory: symlinkWorkspace },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("model_providers"),
    );
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = originalApiKey;
    }
    if (originalProfile === undefined) {
      delete process.env.CODEX_PROFILE;
    } else {
      process.env.CODEX_PROFILE = originalProfile;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("route discovery fails closed for an unqualified harness version", async () => {
  const codex = new CodexAdapter({
    executable: process.execPath,
    probe: {
      readVersion: async () => "1.0.0",
      checkAuthentication: async () => true,
    },
  });
  const routes = await codex.discover();
  assert.ok(routes.every((candidate) => candidate.readiness === "unqualified"));
});

test("process adapter normalizes JSONL output and preserves the absolute executable", async () => {
  const adapter = new TestProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_test",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    async emit(event) {
      events.push(event);
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.ok(events.some((event) => event.category === "output"));
});

test("process adapter keeps the output of a harness that exits before the first event is persisted", async () => {
  const adapter = new TestProcessAdapter();
  const result = await adapter.run({
    invocationId: "inv_fast_exit",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    async emit(event) {
      if (event.data?.phase === "process_started") {
        // A slow store write: the harness has long exited by the time it resolves.
        await delay(300);
      }
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
});

test("process adapter sends prompt on stdin and filters denied environment variables", async () => {
  const adapter = new StdinProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_stdin",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    async emit(event) {
      events.push(event);
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "prompt from stdin" }]);
  const started = events[0];
  assert.equal(started?.data?.phase, "process_started");
  assert.equal(started?.native, undefined);
  assert.deepEqual(started?.data?.deniedEnvironment, ["TEST_DENIED"]);
  const output = events.find((event) => event.category === "output");
  assert.equal(output?.native?.env, null);
});

test("process adapter keeps bridge-internal variables, including stale ones, out of the harness", async () => {
  const adapter = new EnvironmentEchoProcessAdapter();
  const events: AdapterEvent[] = [];
  // AGENT_BRIDGE_* is the pre-rename prefix. A shell or CI job that has not
  // finished the ADR-0021 migration still exports it, and it must not reach a
  // harness process either.
  process.env.HARNESS_RELAY_DIAGNOSTIC_MODE = "true";
  process.env.AGENT_BRIDGE_DIAGNOSTIC_MODE = "true";
  process.env.CONTROL_MARKER = "inherited";
  try {
    await adapter.run({
      invocationId: "inv_environment",
      request: request(process.cwd()),
      route: route(adapter.id, process.execPath),
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
    });
  } finally {
    delete process.env.HARNESS_RELAY_DIAGNOSTIC_MODE;
    delete process.env.AGENT_BRIDGE_DIAGNOSTIC_MODE;
    delete process.env.CONTROL_MARKER;
  }
  const output = events.find((event) => event.category === "output");
  assert.deepEqual(output?.native?.seen, []);
  // The rest of the environment is still inherited, so the empty list above
  // means "filtered", not "no environment was passed".
  assert.equal(output?.native?.control, "inherited");
});

test("process adapter completes a bidirectional permission exchange", async () => {
  const adapter = new InteractiveProcessAdapter();
  const events: AdapterEvent[] = [];
  const result = await adapter.run({
    invocationId: "inv_interactive",
    request: request(process.cwd()),
    route: route(adapter.id, process.execPath),
    signal: new AbortController().signal,
    async emit(event) {
      events.push(event);
    },
    async awaitInput(requestId) {
      assert.equal(requestId, "perm_1");
      return { decision: "allow" };
    },
  });
  assert.deepEqual(result.content, [{ type: "text", text: "approved" }]);
  assert.equal(
    events.some((event) => event.category === "input_required"),
    true,
  );
});

test("Claude keeps the final result once and captures reported usage", () => {
  const adapter = new InspectableClaudeAdapter();
  const state = nativeState();
  const assistant = adapter.normalize(
    { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } },
    state,
  );
  const result = adapter.normalize(
    {
      type: "result",
      result: "pong",
      usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: 0.01,
    },
    state,
  );
  assert.equal(assistant?.category, "output");
  assert.equal(result?.category, "usage");
  assert.deepEqual(state.content.parts, [{ type: "text", text: "pong" }]);
  assert.equal(result?.usage?.inputTokens, 3);
});

test("Claude preserves assistant content when the native result fails", async () => {
  const adapter = new FailingClaudeProcessAdapter();
  let partial: Partial<AdapterRunResult> = {};
  await assert.rejects(
    adapter.run({
      invocationId: "inv_claude_failed_result",
      request: request(process.cwd()),
      route: {
        ...route("claude", process.execPath),
        provider: "anthropic",
        model: "opus",
      },
      signal: new AbortController().signal,
      async emit() {},
      reportPartial(result) {
        partial = result;
      },
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "harness_failed",
  );
  assert.deepEqual(partial.content, [{ type: "text", text: "partial answer" }]);
});

test("Claude confirms file effects only from successful tool results", () => {
  const adapter = new InspectableClaudeAdapter();
  const state = nativeState();
  assert.equal(
    adapter.normalize(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "write_1", name: "Write", input: { file_path: "probe.txt" } },
          ],
        },
      },
      state,
    ),
    undefined,
  );
  assert.equal(
    adapter.normalize(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "write_1", is_error: true, content: "Denied" },
          ],
        },
      },
      state,
    ),
    undefined,
  );

  assert.equal(
    adapter.normalize(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "write_2", name: "Write", input: { file_path: "probe.txt" } },
          ],
        },
      },
      state,
    ),
    undefined,
  );
  assert.deepEqual(
    adapter.normalize(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "write_2" }] } },
      state,
    ),
    {
      category: "effect",
      effects: [{ path: "probe.txt", kind: "modified", evidence: "harness-reported" }],
    },
  );
});

test("Claude maps native permission requests to an input request", () => {
  const adapter = new InspectableClaudeAdapter();
  const event = adapter.normalize(
    {
      type: "control_request",
      request_id: "req_123",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        message: "Run the command?",
        input: { command: "pwd" },
      },
    },
    nativeState(),
  );
  assert.equal(event?.category, "input_required");
  assert.deepEqual(event?.inputRequest, {
    requestId: "req_123",
    kind: "permission",
    prompt: "Run the command?",
    toolName: "Bash",
    input: { command: "pwd" },
  });
});

test("Claude orchestrator mode delegates permission prompts and closes stdin after the result", () => {
  const adapter = new InspectableClaudeAdapter({ executable: process.execPath });
  const context: AdapterRunContext = {
    invocationId: "inv_claude_orchestrator",
    request: {
      ...request(process.cwd()),
      interactionStrategy: "orchestrator",
      requestedPolicy: { minimumAssurance: "none", filesystem: "workspace-write" },
    },
    route: { ...route("claude", process.execPath), provider: "anthropic", model: "opus" },
    signal: new AbortController().signal,
    async emit() {},
  };
  const command = adapter.commandFor(context);
  assert.deepEqual(command.args.slice(-4), [
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
  ]);
  assert.equal(command.args[command.args.indexOf("--permission-mode") + 1], "default");
  assert.equal(command.args.includes("--input-format"), true);
  assert.equal(command.keepStdinOpen, true);
  assert.deepEqual(command.envDenyList, CLAUDE_SESSION_ENVIRONMENT_DENY_LIST);
});

test("Claude and Codex pass native aliases through to the harness", () => {
  const claude = new InspectableClaudeAdapter({ executable: process.execPath });
  const claudeCommand = claude.commandFor({
    invocationId: "inv_claude_alias",
    request: request(process.cwd()),
    route: {
      ...route("claude", process.execPath),
      model: "opus",
      canonicalModel: "claude-opus-4-8",
    },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.equal(claudeCommand.args[claudeCommand.args.indexOf("--model") + 1], "opus");

  const codex = new InspectableCodexAdapter();
  const codexAliasCommand = codex.commandFor({
    invocationId: "inv_codex_alias",
    request: request(process.cwd()),
    route: {
      ...route("codex", process.execPath),
      model: "gpt-5-codex",
      canonicalModel: "gpt-5.3-codex",
    },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.equal(
    codexAliasCommand.args[codexAliasCommand.args.indexOf("--model") + 1],
    "gpt-5-codex",
  );

  const codexCatalogCommand = codex.commandFor({
    invocationId: "inv_codex_catalog_model",
    request: request(process.cwd()),
    route: {
      ...route("codex", process.execPath),
      model: "local",
      canonicalModel: "gpt-5.3-codex",
      nativeModel: "gpt-5.3-codex",
    },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.equal(
    codexCatalogCommand.args[codexCatalogCommand.args.indexOf("--model") + 1],
    "gpt-5.3-codex",
  );

  const claudeCatalogCommand = claude.commandFor({
    invocationId: "inv_claude_catalog_model",
    request: request(process.cwd()),
    route: {
      ...route("claude", process.execPath),
      model: "local",
      canonicalModel: "claude-opus-4-8",
      nativeModel: "claude-opus-4-8",
    },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.equal(
    claudeCatalogCommand.args[claudeCatalogCommand.args.indexOf("--model") + 1],
    "claude-opus-4-8",
  );
});

test("Codex excludes reasoning from answer content and reports file effects", () => {
  const adapter = new InspectableCodexAdapter();
  const state = nativeState();
  const reasoning = adapter.normalize(
    { type: "item.completed", item: { type: "reasoning", text: "private thought" } },
    state,
  );
  const effect = adapter.normalize(
    { type: "item.completed", item: { type: "file_change", path: "src/app.ts", kind: "modify" } },
    state,
  );
  const answer = adapter.normalize(
    { type: "item.completed", item: { type: "agent_message", text: "answer" } },
    state,
  );
  assert.equal(reasoning?.category, "activity");
  assert.equal(reasoning?.data?.phase, "reasoning");
  assert.equal(effect?.effects?.[0]?.evidence, "harness-reported");
  assert.deepEqual(state.content.parts, [{ type: "text", text: "answer" }]);
  assert.equal(answer?.content?.[0]?.type, "text");
});

test("Codex marks failed terminal events as harness failures", () => {
  const adapter = new InspectableCodexAdapter();
  const failed = adapter.normalize(
    { type: "turn.failed", error: { code: "rate_limit", message: "Try again later." } },
    nativeState(),
  );
  assert.equal(failed?.category, "diagnostic");
  assert.deepEqual(failed?.failure, { code: "rate_limit", message: "Try again later." });

  const error = adapter.normalize(
    { type: "error", code: "invalid_request", message: "Bad request." },
    nativeState(),
  );
  assert.deepEqual(error?.failure, { code: "invalid_request", message: "Bad request." });

  const adapterState = nativeState();
  const itemError = adapter.normalize(
    { type: "item.completed", item: { type: "error", message: "A tool failed." } },
    adapterState,
  );
  assert.equal(itemError?.category, "diagnostic");
  assert.equal(itemError?.failure, undefined);
  const completed = adapter.normalize({ type: "turn.completed" }, adapterState);
  assert.equal(completed?.data?.state, "native_result");
});

test("ProcessAdapter rejects a clean exit without a native completion marker", async () => {
  const events: AdapterEvent[] = [];
  class IncompleteAdapter extends TestProcessAdapter {
    protected command(_context: AdapterRunContext): CommandSpec {
      return {
        executable: process.execPath,
        args: ["-e", "console.log(JSON.stringify({type:'assistant',text:'partial'}))"],
      };
    }
  }
  await assert.rejects(
    new IncompleteAdapter().run({
      invocationId: "inv_incomplete",
      request: request(process.cwd()),
      route: route("test-process", process.execPath),
      signal: new AbortController().signal,
      async emit(event) {
        events.push(event);
      },
      terminationGraceMs: 25,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "harness_failed" &&
      "details" in error &&
      (error.details as { reason?: string }).reason === "missing_native_result",
  );
  assert.ok(events.some((event) => event.category === "output"));
});

test("ProcessAdapter force-kills descendants after the leader exits on a failed stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-relay-descendant-"));
  try {
    const adapter = new FakeProcessAdapter();
    await assert.rejects(
      adapter.run({
        invocationId: "inv_descendant",
        request: {
          ...request(root),
          selector: {
            provider: "harness-relay",
            model: "leader-exit-descendant",
            requiredCapabilities: [],
          },
        },
        route: {
          ...route("fake-process", process.execPath),
          model: "leader-exit-descendant",
        },
        signal: new AbortController().signal,
        terminationGraceMs: 25,
        async emit() {},
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "harness_failed",
    );
    const pid = Number(await readFile(join(root, "fake-descendant.pid"), "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        return;
      }
      await delay(5);
    }
    assert.fail(`Descendant process ${pid} remained alive after adapter teardown.`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("version qualification accepts ranges instead of only a major number", () => {
  const qualified = parseVersion("codex-cli 0.149.1");
  const old = parseVersion("codex-cli 0.148.9");
  assert.ok(qualified !== undefined && satisfiesVersionRange(qualified, ">=0.149.0 <1.0.0"));
  assert.ok(old !== undefined && !satisfiesVersionRange(old, ">=0.149.0 <1.0.0"));
});

test("policy resolution rejects unsupported fields and records exact controls", () => {
  const claude = new ClaudeAdapter({ executable: process.execPath });
  const claudeRoute: RouteDescriptor = {
    routeId: "claude:test",
    provider: "anthropic",
    model: "haiku",
    efforts: ["low", "medium", "high", "max"],
    via: "claude-code",
    adapter: "claude",
    harnessVersion: "2.1.235",
    authenticationMode: "test",
    capabilities: [],
    interactionStrategies: ["deny"],
    assurance: "native",
    runtimeIdentityEvidence: "unverified",
    readiness: "ready",
    qualification: [],
    diagnostics: [],
  };
  const unsupported = claude.resolvePolicy(
    { ...request(process.cwd()), requestedPolicy: { minimumAssurance: "none", network: "deny" } },
    claudeRoute,
  );
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.unsupported.includes("requestedPolicy.network"));

  const claudeInherit = claude.resolvePolicy(
    {
      ...request(process.cwd()),
      requestedPolicy: { minimumAssurance: "none", filesystem: "inherit" },
    },
    claudeRoute,
  );
  assert.equal(claudeInherit.supported, true);

  const claudeOrchestrator = claude.resolvePolicy(
    { ...request(process.cwd()), interactionStrategy: "orchestrator" },
    claudeRoute,
  );
  assert.deepEqual(claudeOrchestrator.effectiveNativePolicy.controls, [
    { flag: "--permission-mode", value: "default" },
    { flag: "--input-format", value: "stream-json" },
    { flag: "--permission-prompt-tool", value: "stdio" },
  ]);

  const codex = new InspectableCodexAdapter();
  const codexInherit = codex.resolvePolicy(
    {
      ...request(process.cwd()),
      requestedPolicy: { minimumAssurance: "none", filesystem: "inherit", network: "inherit" },
    },
    {
      ...claudeRoute,
      routeId: "codex:test",
      provider: "openai",
      model: "gpt-5.5",
      via: "codex",
      adapter: "codex",
    },
  );
  assert.equal(codexInherit.supported, true);

  const codexRequest = {
    ...request(process.cwd()),
    selector: { ...request(process.cwd()).selector, effort: "max" },
  };
  const command = codex.commandFor({
    invocationId: "inv_policy",
    request: codexRequest,
    route: { ...route("codex", process.execPath), effort: "max" },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.ok(command.args.includes("model_reasoning_effort=xhigh"));
  assert.equal(command.stdin, "hello");

  const networkAllowed = codex.commandFor({
    invocationId: "inv_network_allow",
    request: {
      ...request(process.cwd()),
      requestedPolicy: {
        minimumAssurance: "none",
        filesystem: "workspace-write",
        network: "allow",
      },
    },
    route: { ...route("codex", process.execPath) },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.ok(networkAllowed.args.includes("sandbox_workspace_write.network_access=true"));

  const networkDenied = codex.commandFor({
    invocationId: "inv_network_deny",
    request: {
      ...request(process.cwd()),
      requestedPolicy: { minimumAssurance: "none", filesystem: "workspace-write", network: "deny" },
    },
    route: { ...route("codex", process.execPath) },
    signal: new AbortController().signal,
    async emit() {},
  });
  assert.ok(networkDenied.args.includes("sandbox_workspace_write.network_access=false"));

  const readOnlyNetworkAllowed = codex.resolvePolicy(
    {
      ...request(process.cwd()),
      requestedPolicy: { minimumAssurance: "none", filesystem: "read-only", network: "allow" },
    },
    {
      ...claudeRoute,
      routeId: "codex:test-read-only",
      provider: "openai",
      model: "gpt-5.5",
      via: "codex",
      adapter: "codex",
    },
  );
  assert.equal(readOnlyNetworkAllowed.supported, false);
});
