#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const rootPackageJsonPath = path.join(__dirname, "..", "package.json");
const requiredNodeMajor = 22;
const invokedCommandName = path.basename(process.argv[1] ?? "codex-auth", path.extname(process.argv[1] ?? ""));

function ensureSupportedNodeVersion() {
  const major = Number(process.versions?.node?.split(".")[0] ?? 0);
  if (Number.isInteger(major) && major >= requiredNodeMajor) {
    return;
  }

  console.error(
    `Node.js ${requiredNodeMajor}+ is required to run @loongphy/codex-auth. Current version: ${process.version}.`
  );
  process.exit(1);
}

ensureSupportedNodeVersion();

const packageMap = {
  "linux:x64": "@loongphy/codex-auth-linux-x64",
  "linux:arm64": "@loongphy/codex-auth-linux-arm64",
  "darwin:x64": "@loongphy/codex-auth-darwin-x64",
  "darwin:arm64": "@loongphy/codex-auth-darwin-arm64",
  "win32:x64": "@loongphy/codex-auth-win32-x64",
  "win32:arm64": "@loongphy/codex-auth-win32-arm64"
};

function userHome() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(userHome(), ".codex");
}

function managedGroupCodexHome(groupName) {
  if (groupName === "default") {
    return defaultCodexHome();
  }
  return path.join(userHome(), "codex-auth-advanced", "groups", groupName);
}

function isApiKeyAwareGroupList(argv) {
  return argv.length >= 3 && argv[0] === "group" && argv[2] === "list" && !argv.includes("--live");
}

function isApiKeyAwareManagedList(argv) {
  return argv.length >= 1 && argv[0] === "list" && !argv.includes("--live");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function accountFileKey(accountKey) {
  if (/^[A-Za-z0-9_.-]+$/.test(accountKey) && accountKey !== "." && accountKey !== "..") {
    return accountKey;
  }
  return Buffer.from(accountKey, "utf8").toString("base64url");
}

function accountAuthPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.auth.json`);
}

function accountConfigPath(codexHome, accountKey) {
  return path.join(codexHome, "accounts", `${accountFileKey(accountKey)}.config.toml`);
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(1, -1);
  }
}

function readBaseUrl(configPath) {
  try {
    const data = fs.readFileSync(configPath, "utf8");
    for (const rawLine of data.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("base_url")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const value = parseTomlString(line.slice(eq + 1));
      if (value) return value;
    }
  } catch {
    return null;
  }
  return null;
}

function modelsEndpointFromBaseUrl(baseUrl) {
  const cleaned = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!cleaned) return "https://api.openai.com/v1/models";
  if (cleaned.endsWith("/models")) return cleaned;
  if (cleaned.endsWith("/v1")) return `${cleaned}/models`;
  return `${cleaned}/v1/models`;
}

function apiBaseFromModelsEndpoint(endpoint) {
  return String(endpoint).replace(/\/models\/?$/, "");
}

function costsEndpointFromModelsEndpoint(endpoint, startTime, endTime) {
  const apiBase = apiBaseFromModelsEndpoint(endpoint);
  const params = new URLSearchParams({
    start_time: String(startTime),
    end_time: String(endTime),
    bucket_width: "1d",
    limit: "31"
  });
  return `${apiBase}/organization/costs?${params.toString()}`;
}

function usageEndpointFromModelsEndpoint(endpoint, date) {
  return `${apiBaseFromModelsEndpoint(endpoint)}/usage?date=${encodeURIComponent(date)}`;
}

function loadApiKeyAccountsForGroup(groupName) {
  return loadApiKeyAccountsFromCodexHome(groupName, managedGroupCodexHome(groupName));
}

function loadManagedGroups() {
  const groups = [{ name: "default", codexHome: defaultCodexHome() }];
  const config = readJsonFile(path.join(userHome(), "codex-auth-advanced", "config.json"));
  if (config && Array.isArray(config.groups)) {
    for (const group of config.groups) {
      if (!group || typeof group.name !== "string" || typeof group.codex_home !== "string") continue;
      groups.push({ name: group.name, codexHome: group.codex_home });
    }
  }
  return groups;
}

function loadApiKeyAccountsForManagedList() {
  return loadManagedGroups().flatMap((group) => loadApiKeyAccountsFromCodexHome(group.name, group.codexHome));
}

function loadApiKeyAccountsFromCodexHome(groupName, codexHome) {
  const registry = readJsonFile(path.join(codexHome, "accounts", "registry.json"));
  if (!registry || !Array.isArray(registry.accounts)) return [];

  return registry.accounts
    .filter((account) => account && account.auth_mode === "apikey" && typeof account.account_key === "string")
    .map((account) => {
      const authJson = readJsonFile(accountAuthPath(codexHome, account.account_key));
      const apiKey = typeof authJson?.OPENAI_API_KEY === "string" ? authJson.OPENAI_API_KEY : "";
      const baseUrl = readBaseUrl(accountConfigPath(codexHome, account.account_key));
      return {
        groupName,
        account,
        apiKey,
        endpoint: modelsEndpointFromBaseUrl(baseUrl)
      };
    })
    .filter((entry) => entry.apiKey.length > 0);
}

async function checkApiKeyAccount(entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(entry.endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": invokedCommandName
      },
      signal: controller.signal
    });
    const costs = response.status === 200 ? await fetchApiKeyCosts(entry) : { daily: null, weekly: null };
    return {
      entry,
      ok: response.status === 200,
      label: response.status === 200 ? "-" : String(response.status),
      daily: costs.daily,
      weekly: costs.weekly
    };
  } catch (error) {
    const name = error?.name === "AbortError" ? "TimedOut" : "RequestFailed";
    return { entry, ok: false, label: name, daily: null, weekly: null };
  } finally {
    clearTimeout(timeout);
  }
}

function utcStartOfTodaySeconds() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

function parseCostsTotal(body) {
  if (!body || !Array.isArray(body.data)) return null;
  let total = 0;
  let found = false;
  for (const bucket of body.data) {
    const results = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const result of results) {
      const value = Number(result?.amount?.value);
      if (!Number.isFinite(value)) continue;
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

async function fetchCostTotal(entry, startTime, endTime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(costsEndpointFromModelsEndpoint(entry.endpoint, startTime, endTime), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": invokedCommandName
      },
      signal: controller.signal
    });
    if (response.status !== 200) return null;
    return parseCostsTotal(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isoDateFromSeconds(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function parseProviderUsage(body) {
  const subscription = body?.subscription;
  const daily = Number(subscription?.daily_usage_usd);
  const monthly = Number(subscription?.monthly_usage_usd);
  const fallback = Number(body?.total_cost ?? body?.cost ?? body?.usage_usd);
  return Number.isFinite(daily)
    ? daily
    : Number.isFinite(monthly)
      ? monthly
      : Number.isFinite(fallback)
        ? fallback
        : null;
}

async function fetchProviderUsage(entry, date) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(usageEndpointFromModelsEndpoint(entry.endpoint, date), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${entry.apiKey}`,
        "User-Agent": invokedCommandName
      },
      signal: controller.signal
    });
    if (response.status !== 200) return null;
    return parseProviderUsage(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchApiKeyCosts(entry) {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = utcStartOfTodaySeconds();
  const weekStart = now - 7 * 24 * 60 * 60;
  const [daily, weekly] = await Promise.all([
    fetchCostTotal(entry, dayStart, now),
    fetchCostTotal(entry, weekStart, now)
  ]);
  if (daily != null || weekly != null) return { daily, weekly };

  const providerDaily = await fetchProviderUsage(entry, isoDateFromSeconds(now));
  return { daily: providerDaily, weekly: providerDaily };
}

function moneyUsed(value) {
  if (!Number.isFinite(value)) return "-";
  return `$${value.toFixed(2)} used`;
}

function accountDisplayNeedles(account) {
  return [account.alias, account.account_name, account.email].filter(
    (value) => typeof value === "string" && value.length > 0
  );
}

function patchApiKeyMissingAuthOutput(output, checks) {
  if (!output || !checks.length) return output;
  return renderListTableWithDailyColumn(output, checks) ?? output;
}

function matchingApiCheck(row, checks) {
  return checks.find((check) =>
    accountDisplayNeedles(check.entry.account).some((needle) => row.account.includes(needle))
  );
}

function splitTableLine(line) {
  const parts = line.trimEnd().split(/\s{2,}/);
  if (parts[0] === "") parts.shift();
  return parts;
}

function parseAccountRow(line, grouped) {
  const parts = splitTableLine(line);
  const minParts = grouped ? 6 : 5;
  if (parts.length < minParts) return null;

  const prefix = parts[0].trim();
  const prefixMatch = grouped
    ? prefix.match(/^([* ]?)\s*(\d+)\s+(\S+)$/)
    : prefix.match(/^([* ]?)\s*(\d+)\s+(.+)$/);
  if (!prefixMatch) return null;

  if (grouped) {
    return {
      marker: prefixMatch[1] === "*" ? "*" : " ",
      index: prefixMatch[2],
      group: prefixMatch[3],
      account: parts[1],
      plan: parts[2],
      fiveHour: parts[3],
      daily: "-",
      weekly: parts[4],
      last: parts.slice(5).join("  ")
    };
  }

  return {
    marker: prefixMatch[1] === "*" ? "*" : " ",
    index: prefixMatch[2],
    group: null,
    account: prefixMatch[3],
    plan: parts[1],
    fiveHour: parts[2],
    daily: "-",
    weekly: parts[3],
    last: parts.slice(4).join("  ")
  };
}

function pad(value, width) {
  return String(value ?? "").padEnd(width, " ");
}

function renderGroupSeparator(name, width) {
  const prefix = `-- ${name} `;
  return `${prefix}${"-".repeat(Math.max(0, width - prefix.length))}`;
}

function renderListTableWithDailyColumn(output, checks) {
  const inputLines = output.split("\n");
  const headerLine = inputLines.find((line) => line.includes("ACCOUNT") && line.includes("PLAN") && line.includes("WEEKLY"));
  if (!headerLine) return null;
  const grouped = headerLine.includes("GROUP");
  const items = [];

  for (const line of inputLines) {
    if (!line.trim()) continue;
    if (line.includes("ACCOUNT") && line.includes("PLAN")) continue;
    if (/^-+$/.test(line.trim())) continue;
    if (line.startsWith("-- ")) {
      const name = line.slice(3).trim().split(/\s+/)[0];
      items.push({ type: "group", name });
      continue;
    }
    const row = parseAccountRow(line, grouped);
    if (!row) continue;
    const check = matchingApiCheck(row, checks);
    if (check) {
      row.plan = "API";
      row.fiveHour = check.label;
      row.daily = check.ok ? moneyUsed(check.daily) : "-";
      row.weekly = check.ok ? moneyUsed(check.weekly) : check.label;
      row.last = check.ok ? "Now" : row.last;
    }
    items.push({ type: "row", row });
  }

  const rows = items.filter((item) => item.type === "row").map((item) => item.row);
  if (!rows.length) return null;
  const widths = {
    index: Math.max(2, ...rows.map((row) => row.index.length)),
    group: grouped ? Math.max("GROUP".length, ...rows.map((row) => row.group.length)) : 0,
    account: Math.max("ACCOUNT".length, ...rows.map((row) => row.account.length)),
    plan: Math.max("PLAN".length, ...rows.map((row) => row.plan.length)),
    fiveHour: Math.max("5H LEFT".length, ...rows.map((row) => row.fiveHour.length)),
    daily: Math.max("DAILY".length, ...rows.map((row) => row.daily.length)),
    weekly: Math.max("WEEKLY LEFT".length, ...rows.map((row) => row.weekly.length)),
    last: Math.max("LAST ACTIVITY".length, ...rows.map((row) => row.last.length))
  };

  const prefixWidth = 2 + widths.index + 1;
  const out = [];
  if (grouped) {
    out.push(`${" ".repeat(prefixWidth)}${pad("GROUP", widths.group)}  ${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`);
  } else {
    out.push(`${" ".repeat(prefixWidth)}${pad("ACCOUNT", widths.account)}  ${pad("PLAN", widths.plan)}  ${pad("5H LEFT", widths.fiveHour)}  ${pad("DAILY", widths.daily)}  ${pad("WEEKLY LEFT", widths.weekly)}  ${pad("LAST ACTIVITY", widths.last)}`);
  }
  const totalWidth = out[0].length;
  out.push("-".repeat(totalWidth));

  for (const item of items) {
    if (item.type === "group") {
      out.push(renderGroupSeparator(item.name, totalWidth));
      continue;
    }
    const row = item.row;
    if (grouped) {
      out.push(`${row.marker} ${row.index.padStart(widths.index, "0")} ${pad(row.group, widths.group)}  ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}`);
    } else {
      out.push(`${row.marker} ${row.index.padStart(widths.index, "0")} ${pad(row.account, widths.account)}  ${pad(row.plan, widths.plan)}  ${pad(row.fiveHour, widths.fiveHour)}  ${pad(row.daily, widths.daily)}  ${pad(row.weekly, widths.weekly)}  ${pad(row.last, widths.last)}`);
    }
  }

  return `${out.join("\n")}\n`;
}

async function maybeRunApiKeyAwareList(binaryPath, argv) {
  const isGroupList = isApiKeyAwareGroupList(argv);
  const isManagedList = isApiKeyAwareManagedList(argv);
  if (!isGroupList && !isManagedList) return false;

  const apiKeyAccounts = isGroupList ? loadApiKeyAccountsForGroup(argv[1]) : loadApiKeyAccountsForManagedList();
  if (apiKeyAccounts.length === 0) return false;

  const checks = await Promise.all(apiKeyAccounts.map(checkApiKeyAccount));
  const child = spawnSync(binaryPath, argv, {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_AUTH_NODE_EXECUTABLE: process.execPath
    }
  });

  if (child.stdout) {
    process.stdout.write(patchApiKeyMissingAuthOutput(child.stdout, checks));
  }
  if (child.stderr) {
    process.stderr.write(child.stderr);
  }
  exitFromChild(child);
  return true;
}

function readRootPackage() {
  try {
    return JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function maybePrintPreviewVersion(argv) {
  if (argv.length !== 1) return false;
  if (argv[0] !== "--version" && argv[0] !== "-V") return false;

  const rootPackage = readRootPackage();
  if (!rootPackage) return false;

  const previewLabel = rootPackage.codexAuthPreviewLabel;
  if (typeof previewLabel !== "string" || previewLabel.length === 0) return false;
  if (typeof rootPackage.version !== "string" || rootPackage.version.length === 0) return false;

  process.stdout.write(`${invokedCommandName} ${rootPackage.version} (preview ${previewLabel})\n`);
  return true;
}

if (maybePrintPreviewVersion(process.argv.slice(2))) {
  process.exit(0);
}

function resolveBinary() {
  const key = `${process.platform}:${process.arch}`;
  const packageName = packageMap[key];
  if (!packageName) {
    console.error(`Unsupported platform: ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  try {
    const packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
    const binaryName = process.platform === "win32" ? "codex-auth.exe" : "codex-auth";
    const binaryPath = path.join(packageRoot, "bin", binaryName);
    if (!fs.existsSync(binaryPath)) {
      console.error(`Missing binary inside ${packageName}: ${binaryPath}`);
      process.exit(1);
    }
    return binaryPath;
  } catch (error) {
    console.error(
      `Missing platform package ${packageName}. Reinstall @loongphy/codex-auth on ${process.platform}/${process.arch}.`
    );
    if (error && error.message) {
      console.error(error.message);
    }
    process.exit(1);
  }
}

const binaryPath = resolveBinary();
const argv = process.argv.slice(2);

function exitFromChild(child) {
  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }

  if (child.signal) {
    process.kill(process.pid, child.signal);
  } else {
    process.exit(child.status ?? 1);
  }
}

if (!(await maybeRunApiKeyAwareList(binaryPath, argv))) {
  const child = spawnSync(binaryPath, argv, {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_AUTH_NODE_EXECUTABLE: process.execPath
    }
  });

  exitFromChild(child);
}
