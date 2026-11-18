// agent-scout: find coding-agent CLIs, list the models each can run, and
// follow new models as they are released. Extracted from Helm.

export { scan, listModels, newModels, normalizeCatalog, MODEL_CLIS } from './scan.js';
export { findClis, findAccounts, discoverAliasAccounts, wrappedEngine, shellSymbols, looksSecret, selectClis } from './discover.js';
export { ENGINES, CLI_IDS, resolveCliId, engineForCommand, cliHome } from './engines.js';
export { checkSignedIn, probeSignIn, SIGNIN_CLIS } from './signin.js';
export {
  modelCatalog, peekModels, primeModels, modelsSettled, mergeLiveModelCatalog, optionArgs,
  parseCodexModelList, mergeCodexPublishedModels, parseModelsDevProvider, parseAnthropicModelsPage,
  anthropicCurrentModels, parseOpencodeModelCache, setAsideSignedOut, parsePiModelList, parseDevinModelList,
  agyModelsFromOutput, claudeAlias, newestFirst,
} from './models.js';
export {
  FOLLOWED, accountKey, modelLine, newerVersion, followModels, setModelPrefs, isSuccessor,
  followState, observeModels, syncNewModels, modelPrefs, saveModelPrefs, modelWatch, dismissModelNews, followNewModels,
} from './follow.js';
export { checkUpdates } from './updates.js';
export { findBinary, classifyInstall, parseVersion, isNewer, missingModels, readVersion, UPDATERS } from './binaries.js';
export { antigravityInstall, antigravityToolsDir, ANTIGRAVITY_RELEASE } from './antigravity.js';
export { stateDir } from './paths.js';
