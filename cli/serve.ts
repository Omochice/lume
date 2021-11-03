import { ServerOptions } from "../core.ts";
import { brightGreen, dim, red } from "../deps/colors.ts";
import localIp from "../deps/local_ip.ts";
import { mimes, normalizePath, serveFile } from "../core/utils.ts";
import { printError, runWatch } from "./utils.ts";

/** Start a local HTTP server and live-reload the changes */
export default async function server(
  root: string,
  options?: ServerOptions,
) {
  const port = options?.port || 3000;
  const ipAddr = await localIp();
  let page404 = options?.page404 || "/404.html";

  if (page404.endsWith("/")) {
    page404 += "index.html";
  }

  console.log();
  console.log("  Server started at:");
  console.log(brightGreen(`  http://localhost:${port}/`), "(local)");

  if (!ipAddr) {
    console.log(red("Warning") + " Unable to detect your local IP address");
    console.log(
      "If you're on an Ubuntu machine, try installing net-tools with 'apt install net-tools'",
    );
  } else {
    console.log(brightGreen(`  http://${ipAddr}:${port}/`), "(network)");
  }

  console.log();

  if (options?.open) {
    const commands = {
      darwin: "open",
      linux: "xdg-open",
      windows: "explorer",
    };

    Deno.run({ cmd: [commands[Deno.build.os], `http://localhost:${port}/`] });
  }

  // Live reload server
  let currentSocket: WebSocket | undefined;

  runWatch({
    root,
    fn: (files: Set<string>) => {
      if (!currentSocket) {
        return;
      }
      const urls = Array.from(files).map((file) => normalizePath(file));
      console.log("Changes sent to the browser");
      return currentSocket.send(JSON.stringify(urls));
    },
  });

  // Static files server
  const server = Deno.listen({ port });

  for await (const conn of server) {
    handleConnection(conn);
  }

  async function handleConnection(conn: Deno.Conn) {
    const httpConn = Deno.serveHttp(conn);

    for await (const requestEvent of httpConn) {
      // Is a websocket
      if (requestEvent.request.headers.get("upgrade") === "websocket") {
        handleSocket(requestEvent);
        continue;
      }

      handleFile(requestEvent);
    }
  }

  async function handleFile(event: Deno.RequestEvent) {
    const { request } = event;
    const url = new URL(request.url);

    try {
      let [body, data] = await serveFile(url, {
        root,
        directoryIndex: true,
        page404,
        router: options?.router,
      });

      data.headers = new Headers(data.headers);

      // Insert live-reload script
      if (data.headers.get("content-type") === mimes.get(".html")) {
        if (body instanceof Uint8Array) {
          body = new TextDecoder().decode(body);
        }

        body = (body || "") +
          (typeof wsFile === "string"
            ? `<script type="module" id="lume-live-reload">${wsFile}</script>`
            : `<script type="module" src="${wsFile}" id="lume-live-reload"></script>`);
      }

      // Add headers to prevent cache
      data.headers.set("cache-control", "no-cache no-store must-revalidate");
      const response = new Response(body, data);
      await event.respondWith(response);
      logResponse(response.status, url);
    } catch (cause) {
      const response = new Response(`Error: ${cause.toString()}`, {
        status: 500,
      });
      await event.respondWith(response);
      logResponse(response.status, url, cause);
    }
  }

  function handleSocket(event: Deno.RequestEvent) {
    const { socket, response } = Deno.upgradeWebSocket(event.request);

    socket.onopen = () => {
      if (!currentSocket) {
        console.log("Live reload active");
      }
      currentSocket = socket;
    };
    socket.onclose = () => {
      if (socket === currentSocket) {
        currentSocket = undefined;
      }
    };
    socket.onerror = (e) => console.log("Socket errored", e);

    event.respondWith(response);
  }
}

let wsFile: URL | string = new URL("./ws.js", import.meta.url);

if (wsFile.protocol === "file:") {
  wsFile = await Deno.readTextFile(wsFile);
}

function logResponse(status: number, url: URL, cause?: Error) {
  if (status === 404 || status === 500) {
    console.log(`${red(status.toString())} ${url.pathname}`);
  } else if (status === 200) {
    console.log(`${brightGreen(status.toString())} ${url.pathname}`);
  } else {
    console.log(`${dim(status.toString())} ${url.pathname}`);
  }

  if (cause) {
    printError(cause);
  }
}
