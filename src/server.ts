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
      
      try {
        await requirePayment({price: price});
      } catch (error: any) {
        // Check if this is a payment required error
        if (error?.code === PAYMENT_REQUIRED_ERROR_CODE || error?.code === -30402) {
          // Extract payment information from error data
          const paymentRequestUrl = error?.data?.paymentRequestUrl;
          const paymentRequestId = error?.data?.paymentRequestId;
          const chargeAmount = error?.data?.chargeAmount || price;
          
          if (!paymentRequestUrl || !paymentRequestId) {
            throw error;
          }

          // Return elicitation requirement in structured format
          // Since we can't send elicitation requests during active tool calls with HTTP transport,
          // we return it in the tool response and the client will handle it as an elicitation
          return {
            content: [
              {
                type: "text",
                text: `Payment of $${chargeAmount.toString()} is required to use this tool.`,
              },
            ],
            isError: false,
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

// Transform charge requests to match API format
const originalCharge = paymentServer.charge.bind(paymentServer);
paymentServer.charge = async function(chargeRequest: any) {
  const transformedRequest: any = {
    ...chargeRequest,
    sourceAccountId: chargeRequest.source,
    destinationAccountId: chargeRequest.destinations?.[0]?.address || chargeRequest.destination,
  };
  
  if (transformedRequest.sourceAccountId) {
    delete transformedRequest.source;
  }
  
  return originalCharge(transformedRequest);
};

// Transform payment request creation to match API format
const originalCreatePaymentRequest = paymentServer.createPaymentRequest.bind(paymentServer);
paymentServer.createPaymentRequest = async function(charge: any) {
  const transformedRequest: any = {
    ...charge,
    sourceAccountId: charge.source,
    destinationAccountId: charge.destinations?.[0]?.address || charge.destination,
  };
  
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

  // Client supports elicitation - that's sufficient for our use case
  return { valid: true };
}

app.post('/', async (req: Request, res: Response) => {
  // Validate elicitation support during initialization
  const validation = validateUrlModeSupport(req);
  if (!validation.valid) {
    console.warn('[VALIDATION] Validation failed:', validation.error);
    if (!res.headersSent) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32602,
          message: validation.error || 'Invalid request: elicitation not supported',
        },
        id: req.body?.id || null,
      });
    }
    return;
  }

  const server = getServer();
  try {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
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
  const server = getServer();
  try {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: false
    });
    await server.connect(transport);
    
    await transport.handleRequest(req, res, undefined);
    res.on('close', () => {
      transport.close();
      server.close();
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
