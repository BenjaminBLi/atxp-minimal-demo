## Proposal Iteration 1:
Integration of Elicitation into the current codebase will require modifying the current error handling code within the post call to send elicitation requests to the client rather than an error. Once elicitation is complete and the response is accepted, the appropriate notification will be sent and the connection terminated.

### required modifications for first iteration:
- `server.ts:53`
	- During the handshake/client initialisation, validate `url` mode to ensure appropriate support for elicitation
- `server.ts:67-77`
	- Upon error, add additional handling for fund elicitation specifically using [url mode](https://modelcontextprotocol.io/specification/draft/client/elicitation#url-mode-elicitation-requests)
	- Add handling for success/rejection
	- store `elicitationId`
```
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "action": "accept"
  }
}
```
- synchronous code that awaits full completion/etc and [notifies the client](https://modelcontextprotocol.io/specification/draft/client/elicitation#completion-notifications-for-url-mode-elicitation) for results
### Current questions:
- does any data need to persist? currently no, as all requests are async and will run to completion
- What about parallelization/performance due to the synchronous server calls? out of scope for first proposal


Brief task list:
- [x] Implment mode validation
- [x] barebones url mode request to send to mcp client
- [x] update url mode request to use proper payments
- [ ] implement basic notifications