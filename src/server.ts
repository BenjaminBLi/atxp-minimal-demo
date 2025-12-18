/* eslint-disable no-console */
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BigNumber } from 'bignumber.js';
import { requirePayment, ChainPaymentDestination, ATXPPaymentServer } from '@atxp/server';
import { atxpExpress } from '@atxp/express';
import { ConsoleLogger, PAYMENT_REQUIRED_ERROR_CODE } from '@atxp/common';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';


// Map to store server instances by session ID
const serversBySession = new Map<string, McpServer>();
// Map to store transport instances by session ID
const transportsBySession = new Map<string, StreamableHTTPServerTransport>();

const getServer = () => {
  const server = new McpServer({ name: 'atxp-min-demo', version: '1.0.0' });

  server.tool("add", "Add two numbers together.", {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }, async ({ a, b }, extra) => {
    const price = BigNumber(0.01);
    
    try {
      await requirePayment({price});
    } catch (error: any) {
      if (error?.code !== PAYMENT_REQUIRED_ERROR_CODE && error?.code !== -30402) throw error;
      
      const { paymentRequestUrl, paymentRequestId, chargeAmount = price } = error?.data || {};
      if (!paymentRequestUrl || !paymentRequestId) throw error;

      const sessionId = (extra as any)?.sessionId;
      const serverInstance = serversBySession.get(sessionId);
      if (!serverInstance) throw error;

      try {
        const result = await serverInstance.server.elicitInput({
          mode: 'url',
          elicitationId: randomUUID(),
          url: paymentRequestUrl,
          message: `Payment of $${chargeAmount.toString()} is required. Please approve to continue.`
        } as any);

        if (result.action === 'accept') {
          try {
            await requirePayment({price});
          } catch {
            return {
              content: [{ type: "text", text: `Payment not completed. Please complete at ${paymentRequestUrl}` }],
              isError: true,
            };
          }
        } else {
          return {
            content: [{ type: "text", text: "Payment declined. Tool cannot execute without payment." }],
            isError: true,
          };
        }
      } catch {
        throw error;
      }
    }
    
    return { content: [{ type: "text", text: `${a + b}` }] };
  });

  return server;
}

const app = express();
// Parse JSON for POST requests
app.use(express.json());

const logger = new ConsoleLogger();
const paymentServer = new ATXPPaymentServer('https://auth.atxp.ai', logger);

// Transform API format: source/destinations -> sourceAccountId/destinationAccountId
const transformRequest = (req: any) => {
  const transformed = {
    ...req,
    sourceAccountId: req.source,
    destinationAccountId: req.destinations?.[0]?.address || req.destination,
  };
  if (transformed.sourceAccountId) delete transformed.source;
  return transformed;
};

const originalCharge = paymentServer.charge.bind(paymentServer);
paymentServer.charge = async (req: any) => originalCharge(transformRequest(req));

const originalCreatePaymentRequest = paymentServer.createPaymentRequest.bind(paymentServer);
paymentServer.createPaymentRequest = async (req: any) => originalCreatePaymentRequest(transformRequest(req));

app.use(atxpExpress({
  paymentDestination: new ChainPaymentDestination('HQeMf9hmaus7gJhfBtPrPwPPsDLGfeVf8Aeri3uPP3Fy', 'base'),
  payeeName: 'ATXP Example Resource Server',
  allowHttp: true,
  logger,
  paymentServer,
}));


const validateElicitation = (req: Request) => {
  if (!isInitializeRequest(req.body)) return null;
  if (!req.body.params?.capabilities?.elicitation) {
    return 'Client does not support elicitation. URL mode elicitation is required.';
  }
  return null;
};

app.post('/', async (req: Request, res: Response) => {
  const error = validateElicitation(req);
  if (error && !res.headersSent) {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: error }, id: req.body?.id || null });
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const isInit = isInitializeRequest(req.body);

  console.log(`[POST] Session ID: ${sessionId || 'none'}, Is Init: ${isInit}`);
  console.log(`[POST] Available sessions:`, Array.from(transportsBySession.keys()));

  try {
    let server: McpServer, transport: StreamableHTTPServerTransport;

    if (sessionId && transportsBySession.has(sessionId)) {
      transport = transportsBySession.get(sessionId)!;
      server = serversBySession.get(sessionId)!;
      console.log(`[POST] Reusing existing session: ${sessionId}`);
    } else if (!sessionId && isInit) {
      console.log(`[POST] Creating new session (initialize)`);
      server = getServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: false,
        onsessioninitialized: (sid: string) => {
          if (sid) {
            serversBySession.set(sid, server);
            transportsBySession.set(sid, transport);
            console.log(`[POST] Session initialized: ${sid}`);
          }
        }
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transportsBySession.delete(sid);
          serversBySession.delete(sid);
          console.log(`[POST] Session closed: ${sid}`);
        }
      };
      await server.connect(transport);
    } else {
      console.error(`[POST] Bad Request - Session ID: ${sessionId}, Is Init: ${isInit}, Has Session: ${sessionId ? transportsBySession.has(sessionId) : 'N/A'}`);
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: req.body?.id || null });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`[POST] Error:`, error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/', (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.delete('/', (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));


app.listen(3000, (error) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log('ATXP Minimal Demo listening on port 3000');
});

process.on('SIGINT', () => process.exit(0));
