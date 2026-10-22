import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
import { mountOperations } from '../ops/index.js';
export function createStandaloneTools(options) {
  const tools = createApplicationTools({
    startChrome: startStandaloneChrome,
    sceneDataPacks: {
      sources: {
        assets: createAssetDirectorySource({
          // A panel names the app's address; see src/tools/globePanel.js.
          baseUrl: new URL(
            '/scene-assets/',
            globalThis.GEV_APP_BASE_URL ?? document.baseURI,
          ).href,
        }),
      },
    },
    ...options,
    voice: {
      supportedProviders: ['openai', 'gemini'],
      toolCatalog: loadToolCatalog,
      ...options?.voice,
    },
  });
  // Operations (road saturation, alert journal, report): self-contained and
  // non-fatal, so a storage or overlay failure never blocks the globe.
  mountOperations({
    viewer: options.scene.viewer,
    dataManager: options.data?.dataManager,
    placeSearch: options.placeSearch,
    signal: options.signal,
    defer: options.defer,
  }).catch((error) => console.warn('[WAGUESS ops]', error));
  return tools;
}
