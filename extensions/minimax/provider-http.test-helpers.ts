import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

export const getMinimaxProviderHttpMocks = getProviderHttpMocks;
export const installMinimaxProviderHttpMockCleanup = installProviderHttpMockCleanup;

export function loadMinimaxMusicGenerationProviderModule() {
  return import("./music-generation-provider.js");
}

export function loadMinimaxVideoGenerationProviderModule() {
  return import("./video-generation-provider.js");
}
