import createCache from "@emotion/cache";

// From MUI's official React Router example: server-side Emotion cache whose
// styles are wrapped in `@layer mui` so app styles can override them.
export default function createEmotionCache(options?: Parameters<typeof createCache>[0]) {
  const emotionCache = createCache({ key: "mui", ...options });
  const prevInsert = emotionCache.insert;
  emotionCache.insert = (...args) => {
    if (!args[1].styles.match(/^@layer\s+[^{]*$/)) {
      args[1].styles = `@layer mui {${args[1].styles}}`;
    }
    return prevInsert(...args);
  };

  return emotionCache;
}
