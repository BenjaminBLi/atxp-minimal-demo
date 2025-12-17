/* eslint-disable no-console */
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { BigNumber } from 'bignumber.js';
import { requirePayment, ChainPaymentDestination, ATXPPaymentServer, PaymentServer } from '@atxp/server';
import { atxpExpress } from '@atxp/express';
import { ConsoleLogger, Logger } from '@atxp/common';

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
    async ({ a, b }) => {
      // Require payment for the tool call
      try {
        const price = BigNumber(0.01);
        console.log(`[PAYMENT] Attempting to require payment: ${price.toString()}`);
        await requirePayment({price: price});
        console.log(`[PAYMENT] Payment successful`);
      } catch (error) {
        console.error(`[PAYMENT] Payment error:`, error);
        console.error(`[PAYMENT] Error details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
        throw error;
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
  logger: logger, // Use custom logger for detailed debugging
  paymentServer: paymentServer, // Use payment server with transformed charge method
}));


app.post('/', async (req: Request, res: Response) => {
  // Log incoming request
  console.log('[REQUEST]', {
    method: req.method,
    url: req.url,
    path: req.path,
    headers: req.headers,
    body: req.body,
    query: req.query,
    ip: req.ip,
    timestamp: new Date().toISOString(),
  });

  const server = getServer();
  try {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    await server.connect(transport);
    
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
      console.log('[REQUEST] Request closed');
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
  console.log('Received GET MCP request');
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
