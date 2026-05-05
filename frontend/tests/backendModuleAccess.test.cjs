const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const helperPath = pathToFileURL(path.resolve(
  __dirname,
  "../src/lib/backendModuleAccess.js"
)).href;

test("backend module access enables competitor and locks fraud when app state says starter competitor", async () => {
  const {
    isBackendModuleEnabled,
    resolveBackendEnabledModules,
  } = await import(helperPath);

  const appState = {
    storeReadiness: {
      billing: {
        plan: "STARTER",
        starterModule: "competitor",
        enabledModules: {
          fraud: false,
          competitor: true,
          pricing: false,
          profit: false,
          reports: false,
          settings: true,
        },
      },
    },
  };

  const enabledModules = resolveBackendEnabledModules(appState);

  assert.equal(isBackendModuleEnabled(appState, "competitor"), true);
  assert.equal(isBackendModuleEnabled(appState, "fraud"), false);
  assert.equal(enabledModules.competitor, true);
  assert.equal(enabledModules.fraud, false);
});

test("backend module access enables fraud and locks competitor when app state says starter fraud", async () => {
  const {
    isBackendModuleEnabled,
    resolveBackendEnabledModules,
  } = await import(helperPath);

  const appState = {
    storeReadiness: {
      billing: {
        plan: "STARTER",
        starterModule: "fraud",
        enabledModules: {
          fraud: true,
          competitor: false,
          pricing: false,
          profit: false,
          reports: false,
          settings: true,
        },
      },
    },
  };

  const enabledModules = resolveBackendEnabledModules(appState);

  assert.equal(isBackendModuleEnabled(appState, "fraud"), true);
  assert.equal(isBackendModuleEnabled(appState, "competitor"), false);
  assert.equal(enabledModules.fraud, true);
  assert.equal(enabledModules.competitor, false);
});
