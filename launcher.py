"""
launcher.py — Meshcoms Portal Server

Serves the web portal files AND runs a WebSocket-to-TCP proxy.
The proxy allows the browser (which cannot open raw TCP sockets) to
reach Meshtastic and MeshCore devices over WiFi via a local bridge:

  Browser  <── WebSocket ──>  Proxy (localhost)  <── TCP ──>  Device (192.168.x.x:4403)

Usage:
  python launcher.py

The proxy endpoint is:
  ws://127.0.0.1:<PROXY_PORT>?host=<DEVICE_IP>&port=<DEVICE_PORT>
"""

import http.server
import socketserver
import webbrowser
import os
import sys
import threading
import time
import socket
import asyncio
import json
try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False


def get_base_path():
    if hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


# ─── HTTP File Server ─────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # keep console clean


# ─── WebSocket ↔ TCP Proxy ───────────────────────────────────────────────────

async def ws_tcp_bridge(websocket, path=None):
    """
    Bridge a WebSocket connection to a raw TCP socket.
    Query params: ?host=<ip>&port=<port>
    """
    # Parse query string from the request URI
    import urllib.parse
    uri = websocket.request.path if hasattr(websocket, 'request') else ''
    # Fallback: parse from path argument
    if not uri and path:
        uri = path
    parsed = urllib.parse.urlparse(uri)
    params = urllib.parse.parse_qs(parsed.query)

    host = params.get('host', [None])[0]
    port = params.get('port', [None])[0]

    if not host or not port:
        await websocket.close(1008, 'Missing host or port parameters')
        return

    port = int(port)
    print(f'[TCP Proxy] Bridging WebSocket → TCP {host}:{port}')

    try:
        reader, writer = await asyncio.open_connection(host, port)
    except Exception as e:
        print(f'[TCP Proxy] Connection failed to {host}:{port}: {e}')
        await websocket.close(1011, f'TCP connection failed: {e}')
        return

    print(f'[TCP Proxy] TCP connection established to {host}:{port}')

    async def ws_to_tcp():
        try:
            async for message in websocket:
                if isinstance(message, bytes):
                    writer.write(message)
                    await writer.drain()
                else:
                    writer.write(message.encode())
                    await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    async def tcp_to_ws():
        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                await websocket.send(data)
        except Exception:
            pass
        finally:
            await websocket.close()

    await asyncio.gather(ws_to_tcp(), tcp_to_ws())
    print(f'[TCP Proxy] Bridge to {host}:{port} closed')


def run_proxy_server(proxy_port, proxy_port_file):
    """Run the asyncio WebSocket proxy in its own thread."""
    if not HAS_WEBSOCKETS:
        print('[TCP Proxy] "websockets" package not found — WiFi TCP bridging disabled.')
        print('[TCP Proxy] Install it with: pip install websockets')
        # Write port 0 to signal unavailability
        with open(proxy_port_file, 'w') as f:
            json.dump({'proxy_port': 0, 'available': False}, f)
        return

    async def _start():
        # Bind to a free port if proxy_port == 0
        server = await websockets.serve(ws_tcp_bridge, '127.0.0.1', proxy_port)
        actual_port = server.sockets[0].getsockname()[1]
        print(f'[TCP Proxy] WebSocket proxy listening on ws://127.0.0.1:{actual_port}')
        # Write the actual port so the web app can discover it
        with open(proxy_port_file, 'w') as f:
            json.dump({'proxy_port': actual_port, 'available': True}, f)
        await server.wait_closed()

    asyncio.run(_start())


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print('----------------------------------------')
    print(' Meshcoms Portal Initializing...')
    print('----------------------------------------')

    base_dir = get_base_path()
    os.chdir(base_dir)

    # ── HTTP server on a random free port ──
    httpd = socketserver.TCPServer(('127.0.0.1', 0), Handler)
    http_port = httpd.server_address[1]

    # ── Proxy port discovery file — written by proxy thread, read by app_v2.js ──
    proxy_port_file = os.path.join(base_dir, 'proxy_port.json')

    # ── Start proxy in background thread ──
    proxy_thread = threading.Thread(
        target=run_proxy_server, args=(0, proxy_port_file), daemon=True
    )
    proxy_thread.start()

    # ── Start HTTP server in background thread ──
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    time.sleep(0.8)  # Let both servers bind

    url = f'http://127.0.0.1:{http_port}/index.html'
    print(f'Portal:     {url}')
    print(f'TCP Proxy:  see proxy_port.json for WebSocket port')
    print('')
    print('[!] Keep this window open while using the Portal.')
    print('[!] Close this window when finished.')
    print('----------------------------------------')

    try:
        webbrowser.open(url)
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('\nPortal Server shutting down...')
        httpd.shutdown()
        sys.exit(0)


if __name__ == '__main__':
    main()
