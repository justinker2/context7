#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchLibraries, fetchLibraryContext } from "./lib/api.js";
import { ClientContext } from "./lib/encryption.js";
import { formatSearchResults, extractClientInfoFromUserAgent } from "./lib/utils.js";
import { isJWT, validateJWT } from "./lib/jwt.js";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import {
  SERVER_VERSION,
  RESOURCE_URL,
  AUTH_SERVER_URL,
  OPENAI_APPS_CHALLENGE_TOKEN,
} from "./lib/constants.js";
import {
  loadStdioToken,
  recordCallAndDecide,
  promptForAuth,
  inlineAuthNudge,
} from "./lib/auth/index.js";

/** Default HTTP server port */
const DEFAULT_PORT = 3000;

// Parse CLI arguments using commander
const program = new Command()
  .version(SERVER_VERSION, "-v, --version", "output the current version")
  .option("--transport <stdio|http>", "transport type", "stdio")
  .option("--port <number>", "port for HTTP transport", DEFAULT_PORT.toString())
  .option("--api-key <key>", "API key for authentication (or set CONTEXT7_API_KEY env var)")
  .allowUnknownOption() // let MCP Inspector / other wrappers pass through extra flags
  .parse(process.argv);

const cliOptions = program.opts<{
  transport: string;
  port: string;
  apiKey?: string;
}>();

// Validate transport option
const allowedTransports = ["stdio", "http"];
if (!allowedTransports.includes(cliOptions.transport)) {
  console.error(
    `Invalid --transport value: '${cliOptions.transport}'. Must be one of: stdio, http.`
  );
  process.exit(1);
}

// Transport configuration
const TRANSPORT_TYPE = (cliOptions.transport || "stdio") as "stdio" | "http";

// Disallow incompatible flags based on transport
const passedPortFlag = process.argv.includes("--port");
const passedApiKeyFlag = process.argv.includes("--api-key");

if (TRANSPORT_TYPE === "http" && passedApiKeyFlag) {
  console.error(
    "The --api-key flag is not allowed when using --transport http. Use header-based auth at the HTTP layer instead."
  );
  process.exit(1);
}

if (TRANSPORT_TYPE === "stdio" && passedPortFlag) {
  console.error("The --port flag is not allowed when using --transport stdio.");
  process.exit(1);
}

// HTTP port configuration
const CLI_PORT = (() => {
  const parsed = parseInt(cliOptions.port, 10);
  return isNaN(parsed) ? undefined : parsed;
})();

const requestContext = new AsyncLocalStorage<ClientContext>();

// Global state for stdio mode only
let stdioApiKey: string | undefined;
let stdioClientInfo: { ide?: string; version?: string } | undefined;

type ToolResult = { content: { type: "text"; text: string }[] };

/**
 * Wraps a tool handler so that on each call we record an unauthenticated tool
 * use against the user's prompt-state and, when the threshold is reached,
 * fire an MCP elicitation asking them to sign in. Clients that don't support
 * elicitation get a passive tip appended to the tool's text result instead.
 */
function withAuthPrompt<Args>(
  server: McpServer,
  handler: (args: Args) => Promise<ToolResult>
): (args: Args) => Promise<ToolResult> {
  return async (args) => {
    const context = getClientContext();
    const result = await handler(args);
    const decision = recordCallAndDecide(context);
    if (!decision.shouldPrompt) return result;

    let shown = false;
    try {
      const outcome = await promptForAuth({ context, server: server.server });
      shown = outcome.shown;
    } catch (error) {
      console.error("[Context7] Auth prompt failed:", error);
    }

    if (!shown && result.content.length > 0) {
      const rateLimited = result.content.some(
        (c) => c.type === "text" && /quota exceeded|rate.?limit/i.test(c.text)
      );
      const nudge = inlineAuthNudge(context, { rateLimited });
      const last = result.content[result.content.length - 1];
      if (last.type === "text") {
        last.text = `${last.text}\n\n${nudge}`;
      }
    }
    return result;
  };
}

function getClientContext(): ClientContext {
  const ctx = requestContext.getStore();
  if (ctx) return ctx;
  // stdio mode: fall back to the credentials file shared with `ctx7 login`.
  return {
    apiKey: stdioApiKey ?? loadStdioToken(),
    clientInfo: stdioClientInfo,
    transport: "stdio",
  };
}

/**
 * Extract client IP address from request headers.
 * Handles X-Forwarded-For header for proxied requests.
 */
function getClientIp(req: express.Request): string | undefined {
  const forwardedFor = req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"];

  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const ipList = ips.split(",").map((ip) => ip.trim());

    for (const ip of ipList) {
      const plainIp = ip.replace(/^::ffff:/, "");
      if (
        !plainIp.startsWith("10.") &&
        !plainIp.startsWith("192.168.") &&
        !/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(plainIp)
      ) {
        return plainIp;
      }
    }
    return ipList[0].replace(/^::ffff:/, "");
  }

  if (req.socket?.remoteAddress) {
    return req.socket.remoteAddress.replace(/^::ffff:/, "");
  }
  return undefined;
}

function createMcpServer() {
  const server = new McpServer(
    {
      name: "Context7",
      version: SERVER_VERSION,
      websiteUrl: "https://context7.com",
      description:
        "Context7 provides up-to-date documentation and code examples for libraries and frameworks.",
      icons: [
        {
          src: "https://context7.com/context7-icon-green.png",
          mimeType: "image/png",
        },
      ],
    },
    {
      instructions: `Use this server to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.`,
    }
  );

  server.registerTool(
    "resolve-library-id",
    {
      title: "Resolve Context7 Library ID",
      description: `Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.

You MUST call this function before 'Query Documentation' tool to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.

Each result includes:
- Library ID: Context7-compatible identifier (format: /org/project)
- Name: Library or package name
- Description: Short summary
- Code Snippets: Number of available code examples
- Source Reputation: Authority indicator (High, Medium, Low, or Unknown)
- Benchmark Score: Quality indicator (100 is the highest score)
- Versions: List of versions if available. Use one of those versions if the user provides a version in their query. The format of the version is /org/project/version.

For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case.

Selection Process:
1. Analyze the query to understand what library/package the user is looking for
2. Return the most relevant match based on:
- Name similarity to the query (exact matches prioritized)
- Description relevance to the query's intent
- Documentation coverage (prioritize libraries with higher Code Snippet counts)
- Source reputation (consider libraries with High or Medium reputation more authoritative)
- Benchmark Score: Quality indicator (100 is the highest score)

Response Format:
- Return the selected library ID in a clearly marked section
- Provide a brief explanation for why this library was chosen
- If multiple good matches exist, acknowledge this but proceed with the most relevant one
- If no good matches exist, clearly state this and suggest query refinements

For ambiguous queries, request clarification before proceeding with a best-guess match.

IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.`,
      inputSchema: {
        query: z
          .string()
          .describe(
            "The question or task you need help with. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."
          ),
        libraryName: z
          .string()
          .describe(
            "Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'."
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    withAuthPrompt(server, async ({ query, libraryName }) => {
      const searchResponse = await searchLibraries(query, libraryName, getClientContext());

      if (!searchResponse.results || searchResponse.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: searchResponse.error
                ? searchResponse.error
                : "No libraries found matching the provided name.",
            },
          ],
        };
      }

      const resultsText = formatSearchResults(searchResponse);

      const responseText = `Available Libraries:

${resultsText}`;

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
      };
    })
  );

  server.registerTool(
    "query-docs",
    {
      title: "Query Documentation",
      description: `Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.

You must call 'Resolve Context7 Library ID' tool first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.

Do not call this tool more than 3 times per question.`,
      inputSchema: {
        libraryId: z
          .string()
          .describe(
            "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
          ),
        query: z
          .string()
          .describe(
            "The question or task you need help with. Be specific and include relevant details. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad: 'auth' or 'hooks'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    withAuthPrompt(server, async ({ query, libraryId }) => {
      const response = await fetchLibraryContext({ query, libraryId }, getClientContext());

      return {
        content: [
          {
            type: "text",
            text: response.data,
          },
        ],
      };
    })
  );

  return server;
}

async function main() {
  const transportType = TRANSPORT_TYPE;

  if (transportType === "http") {
    const initialPort = CLI_PORT ?? DEFAULT_PORT;

    const app = express();
    app.use(express.json());

    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,DELETE");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, MCP-Session-Id, MCP-Protocol-Version, X-Context7-API-Key, Context7-API-Key, X-API-Key, Authorization"
      );
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

      if (req.method === "OPTIONS") {
        res.sendStatus(200);
        return;
      }
      next();
    });

    const extractHeaderValue = (value: string | string[] | undefined): string | undefined => {
      if (!value) return undefined;
      return typeof value === "string" ? value : value[0];
    };

    const extractBearerToken = (authHeader: string | string[] | undefined): string | undefined => {
      const header = extractHeaderValue(authHeader);
      if (!header) return undefined;

      if (header.startsWith("Bearer ")) {
        return header.substring(7).trim();
      }

      return header;
    };

    const extractApiKey = (req: express.Request): string | undefined => {
      return (
        extractBearerToken(req.headers.authorization) ||
        extractHeaderValue(req.headers["context7-api-key"]) ||
        extractHeaderValue(req.headers["x-api-key"]) ||
        extractHeaderValue(req.headers["context7_api_key"]) ||
        extractHeaderValue(req.headers["x_api_key"])
      );
    };

    // Stateful session registry. Required for server-initiated requests
    // (elicitation): the SDK silently drops server-to-client traffic when no
    // session-bound standalone SSE stream is open.
    interface Session {
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof createMcpServer>;
      context: ClientContext;
    }
    const sessions = new Map<string, Session>();

    const sendJsonError = (
      res: express.Response,
      status: number,
      code: number,
      message: string
    ) => {
      res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
    };

    const handleMcpRequest = async (
      req: express.Request,
      res: express.Response,
      requireAuth: boolean
    ) => {
      try {
        const apiKey = extractApiKey(req);
        const resourceUrl = RESOURCE_URL;
        const baseUrl = new URL(resourceUrl).origin;

        // OAuth discovery info header, used by MCP clients to discover the authorization server
        res.set(
          "WWW-Authenticate",
          `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
        );

        if (requireAuth) {
          if (!apiKey) {
            return sendJsonError(
              res,
              401,
              -32001,
              "Authentication required. Please authenticate to use this MCP server."
            );
          }
          if (isJWT(apiKey)) {
            const validationResult = await validateJWT(apiKey);
            if (!validationResult.valid) {
              return sendJsonError(
                res,
                401,
                -32001,
                validationResult.error || "Invalid token. Please re-authenticate."
              );
            }
          }
        }

        const sessionId = extractHeaderValue(req.headers["mcp-session-id"]);
        const body = req.body as { method?: string } | undefined;
        // Pick up tokens written by an earlier OAuth-via-elicitation flow
        // when the server runs on the same machine as the user. No-op for
        // remote deployments where the credentials file isn't accessible.
        const effectiveApiKey = apiKey ?? loadStdioToken();

        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          // Prefer the canonical name from the MCP initialize handshake
          // (e.g. "codex", "claude-code") over whatever the User-Agent says,
          // since we use it to find the matching MCP client config to update
          // after OAuth.
          const sdkClientInfo = session.server.server.getClientVersion();
          const perRequestContext: ClientContext = {
            ...session.context,
            apiKey: effectiveApiKey ?? session.context.apiKey,
            clientIp: getClientIp(req) ?? session.context.clientIp,
            clientInfo: sdkClientInfo
              ? { ide: sdkClientInfo.name, version: sdkClientInfo.version }
              : session.context.clientInfo,
          };
          await requestContext.run(perRequestContext, async () => {
            await session.transport.handleRequest(req, res, req.body);
          });
          return;
        }

        if (req.method !== "POST" || !body || !isInitializeRequest(body)) {
          return sendJsonError(
            res,
            400,
            -32000,
            "Bad Request: missing or invalid Mcp-Session-Id header"
          );
        }

        const protoHeader = extractHeaderValue(req.headers["x-forwarded-proto"]);
        const proto = protoHeader || (req.secure ? "https" : "http");
        const hostHeader = extractHeaderValue(req.headers["host"]) || "localhost";
        if (process.env.CONTEXT7_AUTH_PROMPT_DEBUG === "1") {
          console.error(
            `[Context7:http] init headers user-agent=${extractHeaderValue(req.headers["user-agent"]) ?? "?"} mcp-protocol-version=${extractHeaderValue(req.headers["mcp-protocol-version"]) ?? "?"}`
          );
        }
        const context: ClientContext = {
          clientIp: getClientIp(req),
          apiKey: effectiveApiKey,
          clientInfo: extractClientInfoFromUserAgent(req.headers["user-agent"]),
          transport: "http",
          serverOrigin: `${proto}://${hostHeader}`,
        };

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: false,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server, context });
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
          },
        });

        const server = createMcpServer();
        // Don't call server.close() here: McpServer.close() closes the
        // transport, which would fire this handler again and recurse.
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        await requestContext.run(context, async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        });
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          sendJsonError(res, 500, -32603, "Internal server error");
        }
      }
    };

    // Anonymous access endpoint - no authentication required
    app.all("/mcp", async (req, res) => {
      await handleMcpRequest(req, res, false);
    });

    // OAuth-protected endpoint - requires authentication
    app.all("/mcp/oauth", async (req, res) => {
      await handleMcpRequest(req, res, true);
    });

    app.get("/ping", (_req: express.Request, res: express.Response) => {
      res.json({ status: "ok", message: "pong" });
    });

    // OAuth 2.0 Protected Resource Metadata (RFC 9728)
    // Used by MCP clients to discover the authorization server
    app.get(
      "/.well-known/oauth-protected-resource",
      (_req: express.Request, res: express.Response) => {
        res.json({
          resource: RESOURCE_URL,
          authorization_servers: [AUTH_SERVER_URL],
          scopes_supported: ["profile", "email"],
          bearer_methods_supported: ["header"],
        });
      }
    );

    app.get(
      "/.well-known/oauth-authorization-server",
      async (_req: express.Request, res: express.Response) => {
        const authServerUrl = AUTH_SERVER_URL;

        try {
          const response = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`);
          if (!response.ok) {
            console.error("[OAuth] Upstream error:", response.status);
            return res.status(response.status).json({
              error: "upstream_error",
              message: "Failed to fetch authorization server metadata",
            });
          }
          const metadata = await response.json();
          res.json(metadata);
        } catch (error) {
          console.error("[OAuth] Error fetching OAuth metadata:", error);
          res.status(502).json({
            error: "proxy_error",
            message: "Failed to proxy authorization server metadata",
          });
        }
      }
    );

    // OpenAI Apps SDK domain verification challenge
    app.get(
      "/.well-known/openai-apps-challenge",
      (_req: express.Request, res: express.Response) => {
        if (!OPENAI_APPS_CHALLENGE_TOKEN) {
          return res.status(404).json({
            error: "not_found",
            message: "Endpoint not found.",
          });
        }
        res.type("text/plain").send(OPENAI_APPS_CHALLENGE_TOKEN);
      }
    );

    // Catch-all 404 handler - must be after all other routes
    app.use((_req: express.Request, res: express.Response) => {
      res.status(404).json({
        error: "not_found",
        message: "Endpoint not found. Use /mcp for MCP protocol communication.",
      });
    });

    const startServer = (port: number, maxAttempts = 10) => {
      const httpServer = app.listen(port);

      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < initialPort + maxAttempts) {
          console.warn(`Port ${port} is in use, trying port ${port + 1}...`);
          startServer(port + 1, maxAttempts);
        } else {
          console.error(`Failed to start server: ${err.message}`);
          process.exit(1);
        }
      });

      httpServer.once("listening", () => {
        console.error(
          `Context7 Documentation MCP Server v${SERVER_VERSION} running on HTTP at http://localhost:${port}/mcp`
        );
      });
    };

    startServer(initialPort);
  } else {
    stdioApiKey = cliOptions.apiKey || process.env.CONTEXT7_API_KEY;

    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
    process.on("SIGHUP", () => process.exit(0));

    const transport = new StdioServerTransport();
    const server = createMcpServer();

    // Capture client info from MCP initialize handshake (stdio only — HTTP
    // mode plumbs client info through requestContext per request).
    server.server.oninitialized = () => {
      const clientVersion = server.server.getClientVersion();
      if (clientVersion) {
        stdioClientInfo = {
          ide: clientVersion.name,
          version: clientVersion.version,
        };
      }
    };

    await server.connect(transport);

    console.error(`Context7 Documentation MCP Server v${SERVER_VERSION} running on stdio`);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
