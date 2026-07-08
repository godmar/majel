// Follows MUI's official React Router integration
// (examples/material-ui-react-router-ts): stream with renderToPipeableStream
// so React Router's inline data scripts render (renderToString drops them and
// hydration never completes), buffer the stream, then inject Emotion's
// critical CSS into <head>.
import { Transform } from "node:stream";

import { CacheProvider } from "@emotion/react";
import createEmotionServer from "@emotion/server/create-instance";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";

import createEmotionCache from "./createCache";
import { ensureAdminAccounts } from "~/lib/auth.server";
import { startReconciler } from "~/lib/reconciler.server";

startReconciler();
declare global {
  var __adminsEnsured: Promise<void> | undefined;
}
globalThis.__adminsEnsured ??= ensureAdminAccounts().catch((err) =>
  console.error("failed to ensure admin accounts:", err),
);

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  const cache = createEmotionCache();
  const { extractCriticalToChunks, constructStyleTagsFromChunks } = createEmotionServer(cache);

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <CacheProvider value={cache}>
        <ServerRouter context={routerContext} url={request.url} />
      </CacheProvider>,
      {
        [readyOption]() {
          shellRendered = true;

          const chunks: Buffer[] = [];
          const transformStream = new Transform({
            transform(chunk, _encoding, callback) {
              chunks.push(chunk);
              callback();
            },
            flush(callback) {
              const html = Buffer.concat(chunks).toString();
              const styles = constructStyleTagsFromChunks(extractCriticalToChunks(html));
              this.push(styles ? html.replace("</head>", `${styles}</head>`) : html);
              callback();
            },
          });

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(createReadableStreamFromReadable(transformStream), {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );

          pipe(transformStream);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
