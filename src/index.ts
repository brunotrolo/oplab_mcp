import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";

// ---------------------------------------------------------------------------
// OpLab API client
// ---------------------------------------------------------------------------

const OPLAB_BASE_URL = "https://api.oplab.com.br/v3";

function createOplabClient(): AxiosInstance {
  const token = process.env.OPLAB_ACCESS_TOKEN;
  if (!token) {
    throw new Error("OPLAB_ACCESS_TOKEN environment variable is required");
  }
  return axios.create({
    baseURL: OPLAB_BASE_URL,
    headers: {
      "Access-Token": token,
      "Content-Type": "application/json",
    },
    timeout: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_symbol",
    description:
      "Retorna dados de mercado em tempo real de um ativo (ação ou opção) da B3. " +
      "Para ações, retorna preço, volume, variação e dados OHLC. " +
      "Para opções, retorna também prêmio, strike, vencimento, gregas (delta, gamma, theta, vega) e volatilidade implícita.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description:
            "Ticker do ativo, ex: PETR4, VALE3, PETRH245 (opção). Case-insensitive.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_options_chain",
    description:
      "Lista todas as opções disponíveis para um ativo subjacente (ação), " +
      "incluindo calls e puts com seus prêmios, strikes e vencimentos.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Ticker da ação subjacente, ex: PETR4, VALE3.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_portfolio_symbols",
    description:
      "Retorna a lista de ativos monitorados na conta OpLab do usuário autenticado.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const GetSymbolInput = z.object({ symbol: z.string().min(1) });
const GetOptionsChainInput = z.object({ symbol: z.string().min(1) });
const EmptyInput = z.object({});

async function handleGetSymbol(
  client: AxiosInstance,
  args: unknown
): Promise<string> {
  const { symbol } = GetSymbolInput.parse(args);
  const { data } = await client.get(`/market/symbols/${symbol.toUpperCase()}`);
  return JSON.stringify(data, null, 2);
}

async function handleGetOptionsChain(
  client: AxiosInstance,
  args: unknown
): Promise<string> {
  const { symbol } = GetOptionsChainInput.parse(args);
  const { data } = await client.get(
    `/market/options/${symbol.toUpperCase()}`
  );
  return JSON.stringify(data, null, 2);
}

async function handleGetPortfolioSymbols(
  client: AxiosInstance,
  _args: unknown
): Promise<string> {
  EmptyInput.parse(_args);
  const { data } = await client.get("/portfolio/symbols");
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createMcpServer(client: AxiosInstance): Server {
  const server = new Server(
    { name: "oplab-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case "get_symbol":
          result = await handleGetSymbol(client, args);
          break;
        case "get_options_chain":
          result = await handleGetOptionsChain(client, args);
          break;
        case "get_portfolio_symbols":
          result = await handleGetPortfolioSymbols(client, args);
          break;
        default:
          return {
            content: [{ type: "text", text: `Ferramenta desconhecida: ${name}` }],
            isError: true,
          };
      }

      return { content: [{ type: "text", text: result }] };
    } catch (error) {
      const message =
        axios.isAxiosError(error)
          ? `Erro na API OpLab [${error.response?.status}]: ${JSON.stringify(error.response?.data)}`
          : String(error);

      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Keep active SSE transports indexed by sessionId
const transports = new Map<string, SSEServerTransport>();

let oplabClient: AxiosInstance;
try {
  oplabClient = createOplabClient();
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Health check — required by Cloud Run
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// SSE endpoint: each GET opens a new MCP session
app.get("/sse", async (req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer(oplabClient);

  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    transports.delete(transport.sessionId);
  });

  await mcpServer.connect(transport);
});

// Messages endpoint: Claude posts tool calls here
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Sessão não encontrada" });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "8080", 10);

app.listen(PORT, () => {
  console.log(`OpLab MCP Server rodando na porta ${PORT}`);
  console.log(`  SSE  → GET  http://localhost:${PORT}/sse`);
  console.log(`  Msgs → POST http://localhost:${PORT}/messages?sessionId=<id>`);
});
