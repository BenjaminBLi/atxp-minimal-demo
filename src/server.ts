/* eslint-disable no-console */
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BigNumber } from 'bignumber.js';
import { requirePayment, ChainPaymentDestination, ATXPPaymentServer, getATXPConfig } from '@atxp/server';
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


const getServer = () => {
  const server = new McpServer({
    name: 'atxp-min-demo',
    version: '1.0.0',
  });

  server.tool(
    "add",
    "Use this tool to add two numbers together.",
    {
      a: z.number().describe("The first number to add"),
      b: z.number().describe("The second number to add"),
    },
    async ({ a, b }, extra) => {
      // Require payment for the tool call
      const price = BigNumber(0.01);
      console.log(`[PAYMENT] Attempting to require payment: ${price.toString()}`);
      
      try {
        await requirePayment({price: price});
        console.log(`[PAYMENT] Payment successful`);
      } catch (error: any) {
        // Check if this is a payment required error
        if (error?.code === PAYMENT_REQUIRED_ERROR_CODE || error?.code === -30402) {
          console.log(`[PAYMENT] Payment required`);
          
          // Extract payment information from error data
          const paymentRequestUrl = error?.data?.paymentRequestUrl;
          const paymentRequestId = error?.data?.paymentRequestId;
          const chargeAmount = error?.data?.chargeAmount || price;
          
          if (!paymentRequestUrl || !paymentRequestId) {
            console.error(`[PAYMENT] Missing payment information in error:`, error?.data);
            throw error;
          }

          // Return elicitation requirement in structured format
          // Since we can't send elicitation requests during active tool calls with HTTP transport,
          // we return it in the tool response and the client will handle it as an elicitation
          console.log(`[PAYMENT] Returning elicitation requirement with URL: ${paymentRequestUrl}`);
          
          return {
            content: [
              {
                type: "text",
                text: `Payment of $${chargeAmount.toString()} is required to use this tool.`,
              },
            ],
            isError: false,
            // Include elicitation information in structured format
            _elicitation: {
              message: `Payment of $${chargeAmount.toString()} is required to use this tool. Please approve the payment to continue.`,
              requestedSchema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    title: "Payment Action",
                    description: "Choose whether to approve or decline the payment",
                    enum: ["accept", "decline"],
                    enumNames: ["Approve Payment", "Decline Payment"]
                  },
                  paymentUrl: {
                    type: "string",
                    title: "Payment URL",
                    description: "URL to complete the payment",
                    default: paymentRequestUrl
                  }
                },
                required: ["action"]
              },
              paymentRequestUrl: paymentRequestUrl,
              paymentRequestId: paymentRequestId,
              chargeAmount: chargeAmount.toString()
            }
          };
        } else {
          // Not a payment error, rethrow
          console.error(`[PAYMENT] Payment error:`, error);
          throw error;
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

// Override the charge method to transform the request format
const originalCharge = paymentServer.charge.bind(paymentServer);
paymentServer.charge = async function(chargeRequest: any) {
  // Log the original request
  console.log('[PAYMENT] Original charge request:', JSON.stringify(chargeRequest, null, 2));
  
  // Transform: Keep destinations (required by API), but add sourceAccountId and destinationAccountId
  // The API expects: { sourceAccountId, destinationAccountId, destinations: [...], ... }
  const transformedRequest: any = {
    ...chargeRequest, // Keep all original fields including destinations
    sourceAccountId: chargeRequest.source, // Add sourceAccountId
    destinationAccountId: chargeRequest.destinations?.[0]?.address || chargeRequest.destination, // Add destinationAccountId
  };
  
  // Remove the old 'source' field if we added sourceAccountId
  if (transformedRequest.sourceAccountId) {
    delete transformedRequest.source;
  }
  
  console.log('[PAYMENT] Transformed charge request:', JSON.stringify(transformedRequest, null, 2));
  
  return originalCharge(transformedRequest);
};

// Override createPaymentRequest with the same transformation
const originalCreatePaymentRequest = paymentServer.createPaymentRequest.bind(paymentServer);
paymentServer.createPaymentRequest = async function(charge: any) {
  // Keep destinations and add sourceAccountId/destinationAccountId
  const transformedRequest: any = {
    ...charge, // Keep all original fields including destinations
    sourceAccountId: charge.source,
    destinationAccountId: charge.destinations?.[0]?.address || charge.destination,
  };
  
  // Remove the old 'source' field if we added sourceAccountId
  if (transformedRequest.sourceAccountId) {
    delete transformedRequest.source;
  }
  
  return originalCreatePaymentRequest(transformedRequest);
};

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

  // Check if URL mode is supported (elicitation object may have urlMode property)
  // The schema uses "passthrough" so we check for urlMode property
  const elicitation = capabilities.elicitation as any;
  if (elicitation.urlMode === false || (elicitation.urlMode === undefined && !elicitation.urlMode)) {
    // If urlMode is explicitly false or not present, we should check if it's required
    // For now, we'll accept if elicitation is present (urlMode might be implicit)
    console.log('[VALIDATION] Elicitation capability found, urlMode:', elicitation.urlMode);
  }

  console.log('[VALIDATION] Client supports elicitation with capabilities:', JSON.stringify(capabilities.elicitation, null, 2));
  return { valid: true };
}

// Store transports by session ID to share state between GET and POST requests
const transportStore = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.post('/', async (req: Request, res: Response) => {
  // Validate URL mode support during initialization
  const validation = validateUrlModeSupport(req);
  if (!validation.valid) {
    console.warn('[VALIDATION] URL mode validation failed:', validation.error);
    if (!res.headersSent) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: validation.error || 'Invalid request: URL mode elicitation not supported',
        },
        id: req.body?.id || null,
      });
    }
    return;
  }

  // Get or create transport for this session
  const sessionId = req.headers['mcp-session-id'] as string || `session-${Date.now()}`;
  let transportData = transportStore.get(sessionId);
  
  if (!transportData) {
    const server = getServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: false // Use SSE to allow server-initiated requests during tool calls
    });
    await server.connect(transport);
    transportData = { transport, server };
    transportStore.set(sessionId, transportData);
    console.log(`[SESSION] Created new transport for session: ${sessionId}`);
  } else {
    console.log(`[SESSION] Reusing transport for session: ${sessionId}`);
  }
  
  const { transport, server } = transportData;
  
  try {
    // Log response when it's sent
    const originalEnd = res.end;
    res.end = function(chunk?: any, encoding?: any) {
      console.log('[RESPONSE]', {
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: chunk ? (typeof chunk === 'string' ? chunk : chunk.toString()) : undefined,
        timestamp: new Date().toISOString(),
      });
      return originalEnd.call(this, chunk, encoding);
    };
    
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      console.log('[REQUEST] Request closed for session:', sessionId);
      // Don't close transport/server here - they're shared across requests
      // Only clean up if session is truly ended (would need session management)
    });
  } catch (error) {
    console.error('[ERROR] Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

app.get('/', async (req: Request, res: Response) => {
  console.log('[GET] Received GET MCP request for SSE stream');
  
  // Get or create transport for this session (same as POST)
  const sessionId = req.headers['mcp-session-id'] as string || `session-${Date.now()}`;
  let transportData = transportStore.get(sessionId);
  
  if (!transportData) {
    const server = getServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: false // Use SSE for GET requests
    });
    await server.connect(transport);
    transportData = { transport, server };
    transportStore.set(sessionId, transportData);
    console.log(`[GET] Created new transport for session: ${sessionId}`);
  } else {
    console.log(`[GET] Reusing transport for session: ${sessionId}`);
  }
  
  const { transport, server } = transportData;
  
  try {
    // Handle the GET request - this will set up the SSE stream
    await transport.handleRequest(req, res, undefined);
    
    res.on('close', () => {
      console.log('[GET] SSE stream closed for session:', sessionId);
      // Don't close transport/server here - they're shared
    });
  } catch (error) {
    console.error('[GET] Error handling SSE stream:', error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
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
