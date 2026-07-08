import { CacheProvider } from "@emotion/react";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

import createEmotionCache from "./createCache";

// Must be the same cache configuration as entry.server: SSR bakes the
// cache-key-prefixed class names (mui-*) into the DOM, so a client cache
// with a different key would insert styles under names the DOM doesn't
// reference, leaving components mis-styled until their next re-render.
const cache = createEmotionCache();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <CacheProvider value={cache}>
        <HydratedRouter />
      </CacheProvider>
    </StrictMode>,
  );
});
