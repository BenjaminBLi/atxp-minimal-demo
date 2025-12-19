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

const serversBySession = new Map<string, McpServer>();
const transportsBySession = new Map<string, StreamableHTTPServerTransport>();

const getServer = () => {
  const server = new McpServer({ name: 'atxp-min-demo', version: '1.0.0' });

  server.tool("add", "Add two numbers together.", {
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }, async ({ a, b }, extra) => {
    console.log(`[TOOL] add called with a=${a}, b=${b}`);
    const price = BigNumber(0.01);
    
    try {
      await requirePayment({price});
      console.log(`[TOOL] Payment already completed`);
    } catch (error: any) {
      console.log(`[TOOL] Payment required error:`, error?.code, error?.message);
      if (error?.code !== PAYMENT_REQUIRED_ERROR_CODE && error?.code !== -30402) throw error;
      
      const { paymentRequestUrl, chargeAmount = price } = error?.data || {};
      if (!paymentRequestUrl) throw error;

      const sessionId = (extra as any)?.sessionId;
      const requestId = extra.requestId;
      console.log(`[TOOL] Session ID: ${sessionId}, Request ID: ${requestId}`);
      
      const serverInstance = serversBySession.get(sessionId);
      if (!serverInstance) {
        console.error(`[TOOL] No server instance found for session: ${sessionId}`);
        throw error;
      }
      
      if (!serverInstance.isConnected()) {
        console.error(`[TOOL] Server instance not connected for session: ${sessionId}`);
        throw error;
      }

      console.log(`[TOOL] Sending elicitation request with URL: ${paymentRequestUrl}`);
      const elicitationId = randomUUID();
      
      const transport = transportsBySession.get(sessionId);
      console.log(`[TOOL] Transport exists: ${!!transport}`);
      console.log(`[TOOL] Transport sessionId: ${transport?.sessionId}`);
      
      // Add timeout to prevent indefinite hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          console.error(`[TOOL] Elicitation request timed out after 30 seconds`);
          reject(new Error('Elicitation request timed out after 30 seconds'));
        }, 30000);
      });
      
      // Send elicitation over the POST response stream using relatedRequestId
      // Client will send response asynchronously via transport.send() to avoid deadlock
      console.log(`[TOOL] Calling elicitInput WITH relatedRequestId to use POST response stream`);
      console.log(`[TOOL] Request ID: ${requestId}`);
      console.log(`[TOOL] Elicitation params:`, JSON.stringify({
        mode: 'url',
        elicitationId: elicitationId,
        url: paymentRequestUrl,
        message: `Payment of $${chargeAmount.toString()} is required. Please approve to continue.`
      }, null, 2));
      
      const elicitationPromise = serverInstance.server.elicitInput({
        mode: 'url',
        elicitationId: elicitationId,
        url: paymentRequestUrl,
        message: `Payment of $${chargeAmount.toString()} is required. Please approve to continue.`
      } as any, { relatedRequestId: requestId });
      
      console.log(`[TOOL] Elicitation promise created, waiting for response...`);
      const result = await Promise.race([
        elicitationPromise,
        timeoutPromise
      ]) as any;

      console.log(`[TOOL] Elicitation response received:`, JSON.stringify(result, null, 2));

      if (result.action === 'accept') {
        try {
          await requirePayment({price});
          console.log(`[TOOL] Payment completed after elicitation accept`);
        } catch {
          return { content: [{ type: "text", text: `Payment not completed. Please complete at ${paymentRequestUrl}` }], isError: true };
        }
      } else {
        return { content: [{ type: "text", text: "Payment declined. Tool cannot execute without payment." }], isError: true };
      }
    }
    
    return { content: [{ type: "text", text: `${a + b}` }] };
  });

  return server;
}

const app = express();
app.use(express.json({ strict: false }));
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next();
});

const logger = new ConsoleLogger();
const paymentServer = new ATXPPaymentServer('https://auth.atxp.ai', logger);

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

app.post('/', async (req: Request, res: Response) => {
  const method = (req.body as any)?.method;
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const isInit = isInitializeRequest(req.body);
  
  console.log(`[POST] ========================================`);
  console.log(`[POST] NEW POST REQUEST RECEIVED`);
  console.log(`[POST] Method: ${method}, Session: ${sessionId || 'none'}, IsInit: ${isInit}`);
  console.log(`[POST] Timestamp: ${new Date().toISOString()}`);
  console.log(`[POST] ========================================`);

  if (isInitializeRequest(req.body) && !req.body.params?.capabilities?.elicitation) {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: 'Client does not support elicitation. URL mode elicitation is required.' }, id: (req.body as any)?.id || null });
  }

  try {
    let server: McpServer, transport: StreamableHTTPServerTransport;

    if (sessionId && transportsBySession.has(sessionId)) {
      transport = transportsBySession.get(sessionId)!;
      server = serversBySession.get(sessionId)!;
      console.log(`[POST] Reusing session: ${sessionId}`);
    } else if (!sessionId && isInit) {
      server = getServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: false, // This allows POST requests to return SSE streams
        onsessioninitialized: (sid: string) => {
          if (sid) {
            serversBySession.set(sid, server);
            transportsBySession.set(sid, transport);
            console.log(`[POST] Session initialized: ${sid}`);
          }
        }
      });
      console.log(`[POST] Created transport with enableJsonResponse: false (allows SSE in POST responses)`);
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transportsBySession.delete(sid);
          serversBySession.delete(sid);
          console.log(`[POST] Session closed: ${sid}`);
        }
      };
      await server.connect(transport);
      console.log(`[POST] Created new session`);
    } else {
      console.error(`[POST] Bad request - Session: ${sessionId}, IsInit: ${isInit}, HasSession: ${sessionId ? transportsBySession.has(sessionId) : false}`);
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: (req.body as any)?.id || null });
    }

    console.log(`[POST] Handling request with method: ${method}`);
    console.log(`[POST] Response headers sent: ${res.headersSent}`);
    console.log(`[POST] Response finished: ${res.finished}`);
    
    // Log all incoming POST requests to catch elicitation responses
    // But only log body for non-tool-call requests to avoid noise
    if (method !== 'tools/call') {
      console.log(`[POST] Request body:`, JSON.stringify(req.body, null, 2));
    }
    console.log(`[POST] Request has id: ${!!req.body?.id}, id value: ${req.body?.id}`);
    console.log(`[POST] Request has result: ${!!req.body?.result}`);
    console.log(`[POST] Request has error: ${!!req.body?.error}`);
    console.log(`[POST] Request has method: ${!!req.body?.method}, method value: ${req.body?.method}`);
    
    // Log if this might be an elicitation response (no method, has id and result)
    if (!req.body?.method && req.body?.id !== undefined && req.body?.result) {
      console.log(`[POST] ========================================`);
      console.log(`[POST] POTENTIAL ELICITATION RESPONSE RECEIVED!`);
      console.log(`[POST] Full request body:`, JSON.stringify(req.body, null, 2));
      console.log(`[POST] Response ID: ${req.body.id}`);
      console.log(`[POST] Response result:`, JSON.stringify(req.body.result, null, 2));
      console.log(`[POST] ========================================`);
    }
    
    // For tool calls, the transport should keep the connection open as SSE if enableJsonResponse: false
    // This allows elicitation requests to be sent and responses received on the same stream
    console.log(`[POST] Calling transport.handleRequest - this should keep connection open for tool calls`);
    await transport.handleRequest(req, res, req.body);
    console.log(`[POST] Request handling completed for method: ${method}`);
    console.log(`[POST] Response headers sent after handleRequest: ${res.headersSent}`);
    console.log(`[POST] Response finished after handleRequest: ${res.finished}`);
    
    // If this was a tool call and response is not finished, the connection should still be open for elicitation
    if (method === 'tools/call' && !res.finished) {
      console.log(`[POST] Tool call POST connection still open - waiting for elicitation response or tool completion`);
    }
  } catch (error) {
    console.error(`[POST] Error handling request:`, error);
    if (error instanceof Error) {
      console.error(`[POST] Error message: ${error.message}`);
      console.error(`[POST] Error stack: ${error.stack}`);
    }
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const acceptHeader = req.headers['accept'];
  console.log(`[GET] SSE stream request received`);
  console.log(`[GET] Session: ${sessionId || 'none'}`);
  console.log(`[GET] Accept header: ${acceptHeader}`);
  console.log(`[GET] Available sessions: ${Array.from(transportsBySession.keys()).join(', ')}`);
  
  if (!sessionId || !transportsBySession.has(sessionId)) {
    console.error(`[GET] Invalid session - Session: ${sessionId}, HasSession: ${sessionId ? transportsBySession.has(sessionId) : false}`);
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No session' }, id: null });
  }
  
  const transport = transportsBySession.get(sessionId)!;
  console.log(`[GET] Handling SSE stream for session: ${sessionId}`);
  console.log(`[GET] Transport sessionId: ${transport.sessionId}`);
  console.log(`[GET] Server connected: ${serversBySession.get(sessionId)?.isConnected()}`);
  
  // Note: handleRequest for GET requests should keep the connection open for SSE
  // It will not return until the stream is closed
  // This is the standalone SSE stream used for server-initiated messages like elicitation
  try {
    console.log(`[GET] Starting SSE stream handler (this will block until stream closes)`);
    console.log(`[GET] This stream is used for elicitation requests when not using relatedRequestId`);
    await transport.handleRequest(req, res, null);
    console.log(`[GET] SSE stream handler completed (stream closed)`);
  } catch (error) {
    console.error(`[GET] Error handling SSE stream:`, error);
    if (error instanceof Error) {
      console.error(`[GET] Error message: ${error.message}`);
      console.error(`[GET] Error stack: ${error.stack}`);
    }
    throw error;
  }
});

app.delete('/', (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

app.listen(3000, (error) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log('ATXP Minimal Demo listening on port 3000');
});

process.on('SIGINT', () => process.exit(0));
