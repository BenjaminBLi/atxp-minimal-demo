/* eslint-disable no-console */
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BigNumber } from 'bignumber.js';
import { requirePayment, ChainPaymentDestination, ATXPPaymentServer } from '@atxp/server';
import { atxpExpress } from '@atxp/express';
import { ConsoleLogger, Logger, PAYMENT_REQUIRED_ERROR_CODE } from '@atxp/common';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// Custom logger that logs everything for debugging
class DebugLogger implements Logger {
  private baseLogger = new ConsoleLogger();
  
  debug(message: string): void {
    console.log(`[DEBUG] ${message}`);
    this.baseLogger.debug(message);
  }
  
  info(message: string): void {
    console.log(`[INFO] ${message}`);
    this.baseLogger.info(message);
  }
  
  warn(message: string): void {
    console.warn(`[WARN] ${message}`);
    this.baseLogger.warn(message);
  }
  
  error(message: string): void {
    console.error(`[ERROR] ${message}`);
    this.baseLogger.error(message);
  }
}


// Helper to create elicitation response
const createElicitationResponse = (paymentRequestUrl: string, paymentRequestId: string, chargeAmount: BigNumber) => ({
  content: [{ type: "text" as const, text: `Payment of $${chargeAmount.toString()} is required to use this tool.` }],
  isError: false,
  _elicitation: {
    message: `Payment of $${chargeAmount.toString()} is required to use this tool. Please approve the payment to continue.`,
    requestedSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          title: "Payment Action",
          description: "Choose whether to approve or decline the payment",
          enum: ["accept", "decline"],
          enumNames: ["Approve Payment", "Decline Payment"]
        },
        paymentUrl: {
          type: "string" as const,
          title: "Payment URL",
          description: "URL to complete the payment",
          default: paymentRequestUrl
        }
      },
      required: ["action"]
    },
    paymentRequestUrl,
    paymentRequestId,
    chargeAmount: chargeAmount.toString()
  }
});

let serverInstance: McpServer | null = null;

const getServer = () => {
  const server = new McpServer({
    name: 'atxp-min-demo',
    version: '1.0.0',
  });
  
  serverInstance = server;

  server.tool(
    "add",
    "Use this tool to add two numbers together.",
    {
      a: z.number().describe("The first number to add"),
      b: z.number().describe("The second number to add"),
    },
    async ({ a, b }, extra) => {
      const price = BigNumber(0.01);
      
      // Check if we have a stored elicitation response (from client accepting payment)
      const elicitationStore = (global as any).__elicitationStore;
      const storedElicitation: { elicitationResponse?: { action: string }; paymentRequestId?: string } | null = 
        elicitationStore && elicitationStore.size > 0
          ? (Array.from(elicitationStore.values()).slice(-1)[0] as { elicitationResponse?: { action: string }; paymentRequestId?: string }) || null
          : null;

      // If client accepted payment via elicitation, process it with existing payment ID
      if (storedElicitation?.elicitationResponse?.action === "accept" && storedElicitation?.paymentRequestId) {
        try {
          await requirePayment({
            price: price,
            getExistingPaymentId: async () => storedElicitation.paymentRequestId || null
          });
          // Payment successful, continue with tool execution
        } catch (retryError: any) {
          // If payment still required for same ID, proceed anyway (demo mode)
          if ((retryError?.code === PAYMENT_REQUIRED_ERROR_CODE || retryError?.code === -30402) &&
              retryError?.data?.paymentRequestId === storedElicitation.paymentRequestId) {
            // Payment not yet completed, but proceed for demo
          } else {
            throw retryError;
          }
        }
      } else {
        // No elicitation response yet - require payment and send elicitation request
        try {
          await requirePayment({ price });
        } catch (error: any) {
          if (error?.code === PAYMENT_REQUIRED_ERROR_CODE || error?.code === -30402) {
            const { paymentRequestUrl, paymentRequestId, chargeAmount } = error.data || {};
            
            if (paymentRequestUrl && paymentRequestId) {
              // With HTTP transport and SSE enabled, we can send server-initiated requests.
              // The transport should handle sending the elicitation request via SSE.
              // Store payment info for when elicitation response is received
              (global as any).__pendingPaymentRequests = (global as any).__pendingPaymentRequests || new Map<string, { paymentRequestUrl: string; paymentRequestId: string; chargeAmount: BigNumber }>();
              (global as any).__pendingPaymentRequests.set(paymentRequestId, { paymentRequestUrl, paymentRequestId, chargeAmount: chargeAmount || price });
              
              // The transport will send the elicitation request via SSE when we throw the error
              // But we need to format it as an elicitation request, not a payment error
              // For now, throw the error - the transport should convert it to an elicitation request
              // The issue is ATXP client intercepts it. We may need to configure the client differently.
              throw error;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }
      
      return {
        content: [
          {
            type: "text",
            text: `${a + b}`,
          },
        ],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

const destination = new ChainPaymentDestination('HQeMf9hmaus7gJhfBtPrPwPPsDLGfeVf8Aeri3uPP3Fy', 'base');
const logger = new DebugLogger();

// Create a payment server that transforms the charge format before sending
// The API expects sourceAccountId and destinationAccountId, but requirePayment sends source and destinations
const paymentServer = new ATXPPaymentServer('https://auth.atxp.ai', logger);

// Transform payment requests to match API format (adds sourceAccountId/destinationAccountId)
const transformPaymentRequest = (request: any) => {
  const transformed = {
    ...request,
    sourceAccountId: request.source,
    destinationAccountId: request.destinations?.[0]?.address || request.destination,
  };
  if (transformed.sourceAccountId) delete transformed.source;
  return transformed;
};

const originalCharge = paymentServer.charge.bind(paymentServer);
paymentServer.charge = async (req: any) => originalCharge(transformPaymentRequest(req));

const originalCreatePaymentRequest = paymentServer.createPaymentRequest.bind(paymentServer);
paymentServer.createPaymentRequest = async (req: any) => originalCreatePaymentRequest(transformPaymentRequest(req));

app.use(atxpExpress({
  paymentDestination: destination,
  payeeName: 'ATXP Example Resource Server',
  allowHttp: true, // Only use in development
  logger: logger, 
  paymentServer: paymentServer, // Use payment server with transformed charge method
}));


function validateUrlModeSupport(req: Request): { valid: boolean; error?: string } {
  if (!isInitializeRequest(req.body)) {
    return { valid: true };
  }

  const params = req.body.params;
  if (!params || !params.capabilities) {
    return {
      valid: false,
      error: 'Client capabilities not provided in initialize request'
    };
  }

  const capabilities = params.capabilities;
  
  // Check if elicitation capability is present
  if (!capabilities.elicitation) {
    return {
      valid: false,
      error: 'Client does not support elicitation. URL mode elicitation is required for payment flows.'
    };
  }

  // Client supports elicitation - that's sufficient for our use case
  return { valid: true };
}

// Global store for elicitation responses (keyed by paymentRequestId)
(global as any).__elicitationStore = (global as any).__elicitationStore || new Map<string, { elicitationResponse: any; paymentRequestId: string }>();

app.post('/', async (req: Request, res: Response) => {
  // Validate elicitation support during initialization
  const validation = validateUrlModeSupport(req);
  if (!validation.valid) {
    if (!res.headersSent) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32602, message: validation.error || 'Invalid request: elicitation not supported' },
        id: req.body?.id || null,
      });
    }
    return;
  }

  // Handle JSON-RPC elicitation response from client
  if (req.body?.jsonrpc === '2.0' && req.body?.result?.action) {
    const paymentRequestId = req.headers['x-payment-request-id'] as string;
    if (paymentRequestId) {
      (global as any).__elicitationStore.set(paymentRequestId, {
        elicitationResponse: { action: req.body.result.action },
        paymentRequestId
      });
    }
    if (!res.headersSent) {
      res.json({ jsonrpc: '2.0', id: req.body.id, result: { received: true } });
    }
    return;
  }

  const server = getServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: false
    });
    await server.connect(transport);
    
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error('[ERROR] Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/', async (req: Request, res: Response) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});

app.delete('/', async (req: Request, res: Response) => {
  console.log('Received DELETE MCP request');
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  }));
});


// Start the server
app.listen(3000, (error) => {
  if (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
  console.log(`ATXP Minimal Demo listening on port 3000`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  process.exit(0);
});
