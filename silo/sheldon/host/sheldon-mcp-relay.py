#!/usr/bin/env python3
"""Pass Sheldon's MCP calls from its container to the app, and nothing else.

The app answers /mcp only for callers on its own machine. Sheldon's container is not on the
host's loopback, so this relay listens on the silo's outside bridge (the gate's network) and
forwards to the app on 127.0.0.1. It forwards only
  - requests from the gate's fixed address (GATE_IP),
  - to /mcp/<SHELDON_BOT_ID> and /mcp/<SHELDON_BOT_ID>/gate,
  - with the methods MCP uses (POST, GET, DELETE),
and drops forwarding headers, so the app never sees a request it would treat as proxied.
Every other request gets 403. The bot's own bearer token is still checked by the app.

Configuration by environment (see sheldon-mcp-relay.service):
  RELAY_LISTEN=172.30.53.1:8789   GATE_IP=172.30.53.2
  APP=127.0.0.1:8787              SHELDON_BOT_ID=bot_...
Standard library only. Runs as an unprivileged user.
"""
import http.client
import os
import re
import socket
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST, LISTEN_PORT = os.environ.get('RELAY_LISTEN', '172.30.53.1:8789').rsplit(':', 1)
GATE_IP = os.environ.get('GATE_IP', '172.30.53.2')
APP_HOST, APP_PORT = os.environ.get('APP', '127.0.0.1:8787').rsplit(':', 1)
BOT = os.environ.get('SHELDON_BOT_ID', '')
if not re.fullmatch(r'[A-Za-z0-9_-]{3,64}', BOT):
    sys.exit('SHELDON_BOT_ID is missing or malformed')
PATH_OK = re.compile(r'^/mcp/%s(/gate)?/?(\?.*)?$' % re.escape(BOT))
DROP = {'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
        'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via',
        'cf-connecting-ip', 'true-client-ip', 'cookie'}
MAX_BODY = 8 * 1024 * 1024


class Relay(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'sheldon-mcp-relay'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.client_address[0], fmt % args))

    def refuse(self, code=403, why='forbidden'):
        body = (why + '\n').encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def relay(self):
        if self.client_address[0] != GATE_IP or not PATH_OK.match(self.path):
            return self.refuse()
        # One plain decimal Content-Length, at most MAX_BODY; anything else is refused before reading.
        lengths = self.headers.get_all('Content-Length') or []
        if len(lengths) > 1 or (lengths and not re.fullmatch(r'[0-9]{1,10}', lengths[0].strip())):
            return self.refuse(400, 'bad Content-Length')
        length = int(lengths[0]) if lengths else 0
        if self.headers.get('Transfer-Encoding') or length > MAX_BODY:
            return self.refuse(413, 'body too large or chunked')
        # A slow or stalled sender can't hold the relay open: the body must arrive within 30 seconds.
        self.connection.settimeout(30)
        try:
            body = self.rfile.read(length) if length else None
        except OSError:
            return self.refuse(408, 'body not received in time')
        if body is not None and len(body) != length:
            return self.refuse(400, 'body shorter than Content-Length')
        headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP}
        conn = http.client.HTTPConnection(APP_HOST, int(APP_PORT), timeout=1900)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            return self.refuse(502, 'app unreachable: %s' % e)
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() not in ('connection', 'keep-alive', 'transfer-encoding', 'content-length', 'set-cookie'):
                self.send_header(k, v)
        # Stream the answer (MCP may reply with an event stream) and end with the connection.
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            conn.close()

    do_POST = do_GET = do_DELETE = relay

    def do_PUT(self): self.refuse(405, 'method not allowed')
    do_PATCH = do_HEAD = do_OPTIONS = do_PUT


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # Bind before Docker has created the bridge (the address appears with the network).
        self.socket.setsockopt(socket.IPPROTO_IP, getattr(socket, 'IP_FREEBIND', 15), 1)
        super().server_bind()


if __name__ == '__main__':
    srv = Server((LISTEN_HOST, int(LISTEN_PORT)), Relay)
    sys.stderr.write('relaying %s:%s -> %s:%s for /mcp/%s from %s\n' % (LISTEN_HOST, LISTEN_PORT, APP_HOST, APP_PORT, BOT, GATE_IP))
    srv.serve_forever()
