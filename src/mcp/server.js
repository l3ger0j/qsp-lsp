// QSP MCP server entry point (out/mcp/server.js):
//
//   node out/mcp/server.js [--workspace <dir>] [--verbose]
//
// Written in ES5 on purpose and copied to out/ as is: it must load on any
// Node.js, so that an MCP client started with a too-old `node` (a system
// Node 12 found on PATH, say) gets a readable message on stderr instead of
// a SyntaxError from the real server, which clients show only as
// "Connection closed". The server itself is out/mcp/main.js.
'use strict';

var MIN_NODE_MAJOR = 18;
var major = parseInt(String(process.versions.node).split('.')[0], 10);

if (!(major >= MIN_NODE_MAJOR)) {
  process.stderr.write(
    '[qsp-mcp] The QSP MCP server needs Node.js ' + MIN_NODE_MAJOR + ' or newer, but it was started with '
    + 'Node.js ' + process.versions.node + ' (' + process.execPath + ').\n'
    + '[qsp-mcp] Point "command" in the MCP config at a newer Node.js, or copy the config again with '
    + '"QSP: Copy MCP Server Config" in VS Code, which uses VS Code\'s own runtime.\n'
  );
  process.exit(1);
} else {
  require('./main.js');
}
