#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, EXECUTION_MODE, ensureSafeAuditDirectory, runSimulation, sanitizeTerminal, validateFixture, writeJsonlLog, type ReplayFixture, type SimulationResult } from "./simulation.js";
import { PaperStore } from "./paper-store.js";
import { createHttpRpcCaller, startDeskServer } from "./server.js";
import { startPaperEngine } from "./paper-runtime.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadFixture(path: string): Promise<ReplayFixture> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("Unable to read fixture file");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Fixture is not valid JSON");
  }
  validateFixture(raw);
  return raw;
}

function formatResult(result: SimulationResult, logPath: string): string {
  const lines = [
    "GPTHEIST — PAPER-TRADING REPLAY",
    "Safety: simulation only; no wallet, signing, private keys, or live execution.",
    ""
  ];
  for (const handoff of result.agents) {
    lines.push(`[${handoff.timestamp}] ${handoff.agent.padEnd(10)} ${handoff.outcome.padEnd(4)} :: ${handoff.role} — ${handoff.message}`);
  }
  lines.push("", `FINAL: ${result.decision} — ${result.status} (${result.mode}; executed=${String(result.paperTrade.executed)})`);
  lines.push(`Paper trade: ${result.paperTrade.side} ${result.paperTrade.positionPct.toFixed(2)}% ${result.paperTrade.market} @ ${result.paperTrade.referencePrice.toFixed(2)}`);
  lines.push(`Audit: ${sanitizeTerminal(logPath)}`);
  return `${lines.join("\n")}\n`;
}

async function runFixture(path: string): Promise<void> {
  const result = runSimulation(await loadFixture(path));
  const logPath = await writeJsonlLog(result, resolve(process.cwd(), "runs"));
  process.stdout.write(formatResult(result, logPath));
}

async function main(args: string[]): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "paper-reset") {
    if (args[1] !== "--confirm-paper-reset") throw new Error("Stop the Desk, then use paper-reset --confirm-paper-reset (PAPER data only; backup retained)");
    const store = await PaperStore.open(resolve(process.cwd(), "runs/paper"));
    let balance = 0;
    try { await store.reset(); balance = store.read().config.STARTING_BALANCE_USD; } finally { await store.close(); }
    process.stdout.write(`PAPER account reset to ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(balance)}. Prior PAPER state backed up. Research data unchanged.\n`);
    return;
  }
  if (command === "demo") {
    await runFixture(resolve(projectRoot, "fixtures/success.json"));
    return;
  }
  if (command === "replay") {
    const fixturePath = args[1];
    if (fixturePath === undefined) throw new Error("Usage: gptheist replay <fixture.json>");
    await runFixture(resolve(process.cwd(), fixturePath));
    return;
  }
  if (command === "agents") {
    process.stdout.write("GPTHEIST — TEN AGENTS, ONE DECISION\n\n");
    AGENTS.forEach((agent, index) => {
      process.stdout.write(`${index + 1}. ${agent.name} — ${agent.role}\n   ${agent.responsibility}\n`);
    });
    return;
  }
  if (command === "desk") {
    const option = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const host = option("--host") ?? "127.0.0.1";
    const portText = option("--port") ?? "4173";
    const port = Number(portText);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be an integer from 0 to 65535");
    const rpcUrl = process.env.RPC_URL;
    const discoveryIntervalMs = Number(process.env.PAPER_DISCOVERY_INTERVAL_MS ?? 4000);
    if (!Number.isFinite(discoveryIntervalMs) || discoveryIntervalMs < 1000) throw new Error("PAPER_DISCOVERY_INTERVAL_MS must be at least 1000");
      const rpc = createHttpRpcCaller(rpcUrl);
      const paperLog = (message: string): void => { process.stdout.write(sanitizeTerminal(message) + "\n"); };
      let paper: Awaited<ReturnType<typeof startPaperEngine>> | undefined;
      let paperError: string | undefined;
      try {
        paper = await startPaperEngine({ directory: resolve(process.cwd(), "runs/paper"), rpc,
          discoveryIntervalMs, log: paperLog });
      } catch (error) { paperError = error instanceof Error ? error.message : "Paper storage unavailable"; }
      let server: Awaited<ReturnType<typeof startDeskServer>>;
      try {
        server = await startDeskServer({ host, port, rpc, ...(paper ? { paper } : {}), ...(paperError ? { paperError } : {}), paperDiscoveryIntervalMs: discoveryIntervalMs });
      } catch (error) { await paper?.close(); throw error; }
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
        server.close(); server.closeIdleConnections(); void paper?.close();
      });
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    process.stdout.write(`GPTHEIST DESK — read-only Robinhood Chain watch\nhttp://${sanitizeTerminal(host)}:${boundPort}\nNo wallet. No signing. No live execution.\n`);
    await new Promise<void>(() => undefined);
    return;
  }
  if (command === "doctor") {
    const checks: Array<[string, () => Promise<boolean>]> = [
      ["Node.js >= 18", async () => Number(process.versions.node.split(".")[0]) >= 18],
      ["bundled demo fixture", async () => {
        await access(resolve(projectRoot, "fixtures/success.json"), constants.R_OK);
        return true;
      }],
      ["runs directory writable and safe", async () => {
        const runs = resolve(process.cwd(), "runs");
        await ensureSafeAuditDirectory(runs);
        await access(runs, constants.W_OK);
        return true;
      }],
      ["runtime dependencies allowlisted", async () => {
        const pkg = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
        const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
        return dependencies.length === 1 && dependencies[0] === "viem";
      }],
      ["execution boundary: paper-only", async () => EXECUTION_MODE === "paper-only"]
    ];
    let passed = 0;
    for (const [label, check] of checks) {
      try {
        if (await check()) {
          passed += 1;
          process.stdout.write(`PASS ${label}\n`);
        } else {
          process.stdout.write(`FAIL ${label}\n`);
        }
      } catch {
        process.stdout.write(`FAIL ${label}\n`);
      }
    }
    process.stdout.write(`Doctor: ${passed}/${checks.length} checks passed\n`);
    if (passed !== checks.length) process.exitCode = 1;
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write([
      "GPTHEIST — deterministic ten-agent market replay",
      "",
      "Usage:",
      "  gptheist demo",
      "  gptheist replay <fixture.json>",
      "  gptheist agents",
      "  gptheist desk [--host 127.0.0.1] [--port 4173]",
      "  gptheist doctor",
      "  gptheist paper-reset --confirm-paper-reset",
      "",
      "Desk: read-only Robinhood Chain launch feed; no wallet or execution.",
      "Replay: deterministic paper-only simulation.",
      ""
    ].join("\n"));
    return;
  }
  process.stderr.write(`Unknown command: ${sanitizeTerminal(command)}\n`);
  process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  const safeMessage = sanitizeTerminal(message).trim();
  process.stderr.write(`Error: ${safeMessage || "Unknown error"}\n`);
  process.exitCode = 1;
}
